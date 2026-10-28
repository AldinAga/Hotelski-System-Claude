#!/usr/bin/env bash
# Stages a commit of the hotel system on the NAS (project claude-hotel):
#
#   infrastructure/nas/deploy.sh          # deploy HEAD
#   infrastructure/nas/deploy.sh <ref>    # deploy another ref
#
#   <ref> is resolved once to a full commit SHA; that SHA is what ci.sh tests,
#   what git archive ships and what the image is tagged with.
#
#   1. infrastructure/nas/ci.sh <sha>: build, tests and typecheck; red stops here.
#   2. `git archive <sha>` into /volume1/ci/hotel/deploy (never the working tree,
#      never /volume1/ci/hotel/src, which belongs to ci.sh).
#   3. install and build there, inside hotel-ci-runner-claude (registry token
#      mounted read-only, never in the tree), hotel-web with
#      HOTEL_API_URL=http://hotel-api-claude:4200 (Next fixes the rewrite at build).
#   4. hotel.env: add HOTEL_SECRET_KEY, HOTEL_ROOT_KEYSET, DATABASE_URL if missing
#      (hotel-env.sh of the deployed ref; add-only, values never printed).
#   5. docker build -> hotel-claude:<sha> only.
#   6. refuse if the compose file would recreate a database or Redis container;
#      only then tag hotel-claude:staging.
#   7. postgres, hub-postgres and redis: started only if missing or stopped,
#      never recreated (--no-recreate); then api and web alone
#      (--no-deps --remove-orphans --wait).
#   8. keep the 3 newest hotel-claude:<sha> tags; nothing else is touched.
#
# Run from a machine holding ~/.ssh/synology_claude_ci. Nothing started here may
# exit (Synology mails for every stopped container): one-off work runs via
# `docker exec` in hotel-ci-runner-claude, and hotel-api migrates and then
# listens in one long-running process. Volumes are never removed.
set -euo pipefail

REF="${1:-HEAD}"

NAS="claude-ci@192.168.1.199"
KEY="$HOME/.ssh/synology_claude_ci"
ROOT=/volume1/ci/hotel
DEPLOY=$ROOT/deploy
DOCKER=/usr/local/bin/docker
API_URL_FOR_WEB=http://hotel-api-claude:4200

cd "$(git rev-parse --show-toplevel)"
# Resolved once: a branch that moves during the deploy cannot split tests,
# archive and image across two commits.
SHA="$(git rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:7}"
nas() { ssh -i "$KEY" -o BatchMode=yes -o LogLevel=ERROR "$NAS" "$@"; }

echo "==> $SHORT: tests on the NAS (ci.sh)"
bash infrastructure/nas/ci.sh "$SHA"

echo "==> $SHORT: copying git archive to $DEPLOY"
nas "rm -rf $DEPLOY && mkdir -p $DEPLOY"
git archive --format=tar "$SHA" | nas "tar -x -C $DEPLOY"

# Same runner and pnpm setup as ci.sh; the runner mounts $ROOT at /ci/hotel.
PNPM="export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:\$PATH"
echo "==> installing and building for the image"
nas "$DOCKER exec -w /ci/hotel/deploy -e HOTEL_API_URL=$API_URL_FOR_WEB \
  hotel-ci-runner-claude sh -c '$PNPM && pnpm install --frozen-lockfile && pnpm build'"
nas "test -f $DEPLOY/apps/hotel-api/dist/main.js && test -f $DEPLOY/apps/hotel-api/dist/db/migrations/0001_foundation.sql"
# The web image is useless if its /api rewrite points anywhere else.
nas "grep -q 'hotel-api-claude:4200' $DEPLOY/apps/hotel-web/.next/routes-manifest.json" \
  || { echo "hotel-web was not built with HOTEL_API_URL=$API_URL_FOR_WEB" >&2; exit 1; }

# The deployed ref's copy, so the script matches the image it prepares.
echo "==> hotel.env (add-only, key names only)"
nas "bash $DEPLOY/infrastructure/nas/hotel-env.sh"

# Only the commit tag here: :staging moves after the guard below, so a refused
# or failed deploy never leaves :staging on an image that was not started.
echo "==> building image hotel-claude:$SHA"
nas "cp $DEPLOY/infrastructure/docker/.dockerignore $DEPLOY/.dockerignore && \
  $DOCKER build -q -f $DEPLOY/infrastructure/docker/Dockerfile -t hotel-claude:$SHA $DEPLOY"

COMPOSE="$DOCKER compose -f $DEPLOY/infrastructure/docker/docker-compose.yml --env-file $ROOT/hotel.env"

# The databases and Redis keep running across deploys. The `up` commands below
# never recreate them (--no-recreate, then --no-deps); this guard is a second
# check: if the compose file changed their definition, stop and let a human
# look rather than leave a running container behind its own file.
echo "==> checking that postgres, hub-postgres and redis stay as they are"
nas "$COMPOSE config --hash='postgres,hub-postgres,redis'" | while read -r svc hash; do
  # </dev/null: ssh would otherwise swallow the rest of the hash list.
  container="$(nas "$DOCKER ps -a --filter label=com.docker.compose.project=claude-hotel \
    --filter label=com.docker.compose.service=$svc --format '{{.Names}}'" </dev/null)"
  [ -z "$container" ] && continue
  running="$(nas "$DOCKER inspect $container --format '{{index .Config.Labels \"com.docker.compose.config-hash\"}}'" </dev/null)"
  if [ "$running" != "$hash" ]; then
    echo "$svc ($container) would be recreated; deploy stopped" >&2
    exit 1
  fi
  echo "   $svc unchanged"
done

echo "==> hotel-claude:staging -> $SHORT"
nas "$DOCKER tag hotel-claude:$SHA hotel-claude:staging"

# Plain `up api web` would still converge the dependencies and recreate one
# whose image moved under its shared tag (postgres:16-alpine and redis:7-alpine
# are pulled by other projects on this daemon too). So: dependencies with
# --no-recreate (create or start only), then api and web with --no-deps.
echo "==> postgres, hub-postgres, redis (started only if missing, never recreated)"
nas "$COMPOSE up -d --no-recreate --wait postgres hub-postgres redis"

# hotel-api-claude migrates before it listens; a failed start leaves it Up
# (unhealthy) with /health 503, so --wait fails the deploy without a crash loop.
echo "==> starting api and web"
nas "$COMPOSE up -d --no-deps --remove-orphans --wait api web"

# Keep the newest 3 commit tags: the one just deployed (excluded explicitly, so
# a cached rebuild of an older commit never untags what runs) plus the two
# before it. Only tags of the hotel-claude repository, never :staging, never
# another repository, never `docker image prune`. A failed removal must not fail
# a deploy that already succeeded.
echo "==> removing old hotel-claude images (3 newest stay)"
nas "$DOCKER images hotel-claude --format '{{.Tag}}' \
  | grep -v -x -e staging -e '<none>' -e $SHA \
  | tail -n +3 \
  | while read -r tag; do $DOCKER rmi hotel-claude:\$tag >/dev/null && echo \"   removed hotel-claude:\$tag\"; done; true"

# compose v2.20 on the NAS rejects Go templates in `compose ps --format`.
nas "$DOCKER ps -a --filter label=com.docker.compose.project=claude-hotel --format '{{.Names}} {{.Status}} {{.Image}}'"
echo "==> staging $SHA: API http://192.168.1.199:4200, web http://192.168.1.199:4201"
