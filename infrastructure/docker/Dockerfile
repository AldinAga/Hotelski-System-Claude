# Staging image of the hotel system: hotel-api and hotel-web (one image, two
# commands; see docker-compose.yml).
#
# Two stages. The build stage installs the dependencies and builds; the final
# stage is the finished tree on a clean node image, the same contents the image
# had when deploy.sh built the tree outside Docker.
#
# @platform/* comes from the private registry (http://192.168.1.199:4873). Its
# token reaches pnpm only as a BuildKit secret, mounted for the one RUN step that
# installs (deploy.sh: --secret id=npmrc,src=/volume1/ci/.npmrc). A secret mount is
# not part of any layer, ARG or ENV, and is not in `docker history`. Never turn it
# into a COPY, ARG or ENV. The context's .dockerignore keeps every .npmrc out.
#
# hotel-web is built with HOTEL_API_URL=http://hotel-api-claude:4200, because Next
# fixes its /api rewrite at `next build`; deploy.sh passes it as a build arg.
#
# Build with: docker buildx build --secret id=npmrc,src=/volume1/ci/.npmrc ...
# (the NAS has buildx v0.14.1 for claude-ci; the classic builder cannot do secrets).

FROM node:20-bookworm-slim AS build
# No NODE_ENV here: install needs the dev dependencies.
ARG HOTEL_API_URL=http://hotel-api-claude:4200
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/pnpm-store \
    CI=true
WORKDIR /app
RUN corepack enable
COPY . .
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,id=hotel-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile
RUN HOTEL_API_URL="$HOTEL_API_URL" pnpm build
# Same exclusions as the old host-side tree (.dockerignore never applied to
# files created after COPY), then the checks deploy.sh used to run on the host.
RUN find . -name .turbo -prune -exec rm -rf {} + \
    && rm -rf apps/*/.next/cache \
    && test -f apps/hotel-api/dist/main.js \
    && test -f apps/hotel-api/dist/db/migrations/0001_foundation.sql \
    && grep -q 'hotel-api-claude:4200' apps/hotel-web/.next/routes-manifest.json

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
