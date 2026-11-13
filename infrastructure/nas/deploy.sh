#!/usr/bin/env bash
# Stages a commit of the hotel system on the NAS (project claude-hotel):
#
#   infrastructure/nas/deploy.sh                # deploy HEAD
#   infrastructure/nas/deploy.sh <ref>          # deploy another ref
#   infrastructure/nas/deploy.sh --dry-run [ref]      # only the GitHub check; the NAS is not touched
#   infrastructure/nas/deploy.sh --build-check [ref]  # check, then build hotel-claude:buildx-check
#                                                      # from /volume1/ci/hotel/buildx-check and stop
#                                                      # (no hotel.env, no :staging, no container)
#
#   <ref> is resolved once to a full commit SHA; that SHA is what the CI run is
#   looked up by, what git archive ships and what the image is tagged with.
#
#   1. gh on this machine: the GitHub Actions run "CI" for exactly this SHA must have
#      concluded success (it ran build, tests and typecheck on the NAS runner). No green
#      run, no deploy. GH_REPO overrides the repository.
#   2. `git archive <sha>` into /volume1/ci/hotel/deploy (never the working tree,
#      never /volume1/ci/hotel/src, which belongs to ci.sh).
#   3. hotel.env: add HOTEL_SECRET_KEY, HOTEL_ROOT_KEYSET, DATABASE_URL if missing
#      (hotel-env.sh of the deployed ref; add-only, values never printed).
#   4. docker buildx build -> hotel-claude:<sha> only. Install and build happen in the
#      Dockerfile build stage; the registry .npmrc is a BuildKit secret mount, so it is
#      in no layer, ARG, ENV or log. hotel-web is built with
#      HOTEL_API_URL=http://hotel-api-claude:4200 (Next fixes the rewrite at build).
#   5. refuse if the compose file would recreate a database or Redis container;
#      only then tag hotel-claude:staging.
#   6. postgres, hub-postgres and redis: started only if missing or stopped,
#      never recreated (--no-recreate); then api and web alone
#      (--no-deps --remove-orphans --wait).
#   7. keep the 3 newest hotel-claude:<sha> tags; nothing else is touched.
#
# Run from a machine holding ~/.ssh/synology_claude_ci and an authenticated gh. Nothing
# started here may exit (Synology mails for every stopped container): BuildKit steps
# are not containers, and hotel-api migrates and then listens in one long-running
# process. Volumes are never removed.
set -euo pipefail

MODE=deploy
case "${1:-}" in
  --dry-run) MODE=dry-run; shift ;;
  --build-check) MODE=build-check; shift ;;
esac
REF="${1:-HEAD}"

NAS="claude-ci@192.168.1.199"
KEY="$HOME/.ssh/synology_claude_ci"
ROOT=/volume1/ci/hotel
DEPLOY=$ROOT/deploy
DOCKER=/usr/local/bin/docker
API_URL_FOR_WEB=http://hotel-api-claude:4200
GH_REPO="${GH_REPO:-AldinAga/Hotelski-System-Claude}"

cd "$(git rev-parse --show-toplevel)"
# Resolved once: a branch that moves during the deploy cannot split the CI run,
# archive and image across two commits.
SHA="$(git rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:7}"
nas() { ssh -i "$KEY" -o BatchMode=yes -o LogLevel=ERROR "$NAS" "$@"; }

echo "==> $SHORT: GitHub Actions run for this exact commit"
# Tests no longer run here: the CI workflow (.github/workflows/ci.yml) ran them on
# the NAS runner. A SHA that was never pushed, or whose run is red, is not deployed.
GH_RUNS="$(gh run list -R "$GH_REPO" --workflow CI --commit "$SHA" --json conclusion,status,url --limit 20)"   || { echo "could not ask GitHub for the runs of $SHORT (gh installed and logged in?)" >&2; exit 1; }
GREEN_URL="$(gh run list -R "$GH_REPO" --workflow CI --commit "$SHA" --json conclusion,status,url --limit 20   --jq '[.[] | select(.status == "completed" and .conclusion == "success")][0].url // empty')"
if [ -z "$GREEN_URL" ]; then
  echo "No green CI run for $SHA in $GH_REPO. Push the commit (branch master or phase-*)," >&2
  echo "wait for the CI run to pass, then deploy again. Runs found: $GH_RUNS" >&2
  exit 1
fi
echo "   green: $GREEN_URL"
if [ "$MODE" = dry-run ]; then
  echo "==> dry run: stopping before the NAS is touched (would: archive to $DEPLOY, hotel.env, buildx build hotel-claude:$SHA, guard, tag, up api web)"
  exit 0
fi

# --build-check builds into a sibling directory under a throwaway tag, so a
# running deploy's files and :staging stay untouched; it stops after the build.
if [ "$MODE" = build-check ]; then
  DEPLOY=$ROOT/buildx-check
  TAG="hotel-claude:buildx-check"
else
  TAG="hotel-claude:$SHA"
fi

echo "==> $SHORT: copying git archive to $DEPLOY"
nas "rm -rf $DEPLOY && mkdir -p $DEPLOY"
git archive --format=tar "$SHA" | nas "tar -x -C $DEPLOY"

if [ "$MODE" = deploy ]; then
  # The deployed ref's copy, so the script matches the image it prepares.
  echo "==> hotel.env (add-only, key names only)"
  nas "bash $DEPLOY/infrastructure/nas/hotel-env.sh"
fi

# Install and build run inside the Dockerfile's build stage (BuildKit, no
# container objects, so no Synology stop mails). The registry token is the
# secret mount; it is never an argument, a variable or a file in the context
# (.dockerignore keeps .npmrc out). Only the commit tag here: :staging moves
# after the guard below, so a refused or failed deploy never leaves :staging on
# an image that was not started.
echo "==> building image $TAG (buildx, BuildKit secret npmrc)"
nas "cp $DEPLOY/infrastructure/docker/.dockerignore $DEPLOY/.dockerignore && \
  $DOCKER buildx build --load --progress=plain --secret id=npmrc,src=/volume1/ci/.npmrc \
  --build-arg HOTEL_API_URL=$API_URL_FOR_WEB \
  -f $DEPLOY/infrastructure/docker/Dockerfile -t $TAG $DEPLOY"
if [ "$MODE" = build-check ]; then
  echo "==> build check done: $TAG built from $DEPLOY; nothing deployed, :staging untouched."
  echo "    Remove with: $DOCKER rmi $TAG && rm -rf $DEPLOY"
  exit 0
fi

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
