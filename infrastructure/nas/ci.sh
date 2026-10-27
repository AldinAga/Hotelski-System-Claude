#!/usr/bin/env bash
# Ships the hotel system to the NAS and runs build, tests and typecheck there.
# The computer has no Docker and must not run `pnpm install`.
#
#   infrastructure/nas/ci.sh           # ship the working tree (tracked + untracked, not ignored)
#   infrastructure/nas/ci.sh <ref>     # ship `git archive <ref>` instead
#   infrastructure/nas/ci.sh --lock    # regenerate pnpm-lock.yaml on the NAS and copy it back
#
# Exit 0 only when build, tests and typecheck are all green (--lock exits after
# the install). Run from a machine holding ~/.ssh/synology_claude_ci. The registry
# token lives only in /volume1/ci/.npmrc on the NAS, mounted read-only into the
# runner; it never enters this repo. /volume1/ci/hotel/hotel.env belongs to the
# running claude-hotel project and is never touched here.
#
# Nothing this script starts may exit (Synology mails for every stopped
# container), so everything runs via `docker exec` in the long-running
# claude-hotel-ci project (ci-compose.yml).
set -euo pipefail

LOCK=0
if [ "${1:-}" = "--lock" ]; then LOCK=1; shift; fi
REF="${1:-}"

NAS="claude-ci@192.168.1.199"
KEY="$HOME/.ssh/synology_claude_ci"
ROOT=/volume1/ci/hotel
DOCKER=/usr/local/bin/docker

cd "$(git rev-parse --show-toplevel)"
nas() { ssh -i "$KEY" -o BatchMode=yes -o LogLevel=ERROR "$NAS" "$@"; }

# Only $ROOT/src is ever deleted; hotel.env, pnpm-store and the rest stay.
if [ -n "$REF" ]; then
  LABEL="$(git rev-parse --short "$REF")"
  echo "==> $LABEL: copying git archive to the NAS"
  nas "rm -rf $ROOT/src && mkdir -p $ROOT/src"
  git archive --format=tar "$REF" | nas "tar -x -C $ROOT/src"
else
  LABEL="working tree"
  echo "==> $LABEL: copying files to the NAS"
  nas "rm -rf $ROOT/src && mkdir -p $ROOT/src"
  # Tracked files deleted in the working tree are still listed by `ls-files -c`.
  git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do
    if [ -e "$f" ]; then printf '%s\0' "$f"; fi
  done | tar --null -T - -cf - | nas "tar -x -C $ROOT/src"
fi

echo "==> CI environment (hotel-ci-runner-claude, hotel-postgres-test-claude)"
nas "mkdir -p $ROOT/pnpm-store && CI_UID=\$(id -u) CI_GID=\$(id -g) \
  $DOCKER compose -f $ROOT/src/infrastructure/nas/ci-compose.yml up -d --wait"

# Without root, corepack cannot install pnpm into /usr/local/bin, so it goes to
# /tmp/bin inside the runner.
PNPM="export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:\$PATH"
EXEC="$DOCKER exec -w /ci/hotel/src"

if [ "$LOCK" = 1 ]; then
  echo "==> regenerating pnpm-lock.yaml"
  nas "$EXEC hotel-ci-runner-claude sh -c '$PNPM && pnpm install --no-frozen-lockfile'"
  # Write to a temp file first so a failed ssh never leaves an empty lockfile.
  nas "cat $ROOT/src/pnpm-lock.yaml" > pnpm-lock.yaml.tmp
  mv pnpm-lock.yaml.tmp pnpm-lock.yaml
  echo "==> pnpm-lock.yaml updated"
  exit 0
fi

echo "==> installing, building, testing"
nas "$EXEC \
  -e DATABASE_URL=postgres://postgres:postgres@hotel-postgres-test-claude:5432/postgres \
  hotel-ci-runner-claude sh -c '$PNPM && pnpm install --frozen-lockfile && pnpm build && test -f apps/hotel-api/dist/db/migrations/0001_foundation.sql && pnpm test && pnpm typecheck'"
echo "==> green ($LABEL)"
