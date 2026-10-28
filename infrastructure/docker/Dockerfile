# Staging image of the hotel system: hotel-api and hotel-web (one image, two
# commands; see docker-compose.yml).
#
# Dependencies are NOT installed here. The NAS's Docker has no buildx, so a
# BuildKit secret mount is unavailable, and installing @platform/* from the
# private registry inside a build step would bake the registry token into a
# layer. infrastructure/nas/deploy.sh therefore installs and builds inside the
# long-running hotel-ci-runner-claude (token mounted read-only, never in the
# tree) and this file only copies the finished tree. hotel-web is built there
# with HOTEL_API_URL=http://hotel-api-claude:4200, because Next fixes its
# /api rewrite at `next build`.
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY . .
