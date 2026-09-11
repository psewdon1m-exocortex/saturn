# syntax=docker/dockerfile:1.7
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /workspace
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate && pnpm install --frozen-lockfile
RUN VAULT_RELEASE_BUILD=true pnpm build
RUN pnpm --filter @saturn/api deploy --prod --legacy /release/api \
 && pnpm --filter @saturn/worker deploy --prod --legacy /release/worker \
 && pnpm --filter @saturn/deployment deploy --prod --legacy /release/deployment \
 && find /release -type f \( -name '*.map' -o -name '*.ts' -o -name '*.tsbuildinfo' \) -delete \
 && find /release -type d \( -name test -o -name tests -o -name coverage \) -prune -exec rm -rf '{}' +

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS app
ARG VAULT_VERSION=0.0.0
ARG VAULT_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Saturn Gateway runtime" \
      org.opencontainers.image.version=$VAULT_VERSION \
      org.opencontainers.image.revision=$VAULT_SOURCE_REVISION
RUN apk add --no-cache postgresql-client tini 7zip
WORKDIR /app
COPY --from=build --chown=node:node /release/api /app/api
COPY --from=build --chown=node:node /release/worker /app/worker
COPY --from=build --chown=node:node /release/deployment /app/deployment
COPY --chown=node:node compose.production.yaml /app/recovery/compose.yaml
COPY --chown=node:node packages/database/migrations /app/recovery/migrations
COPY --chown=node:node scripts/validate-production.mjs scripts/migrate-runtime.mjs scripts/storage-bootstrap.mjs scripts/storage-smoke.mjs scripts/storage-exit.mjs /app/scripts/
ENV VAULT_RUNTIME_ROOT=/app
COPY --chown=node:node scripts/recovery-cli.mjs /app/scripts/
USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","/app/api/dist/main.js"]

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS web
ARG VAULT_VERSION=0.0.0
ARG VAULT_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Saturn web runtime" \
      org.opencontainers.image.version=$VAULT_VERSION \
      org.opencontainers.image.revision=$VAULT_SOURCE_REVISION
COPY --from=build --chown=1000:1000 /workspace/apps/web/dist /srv
COPY --chown=1000:1000 infra/production/static-server.mjs /app/static-server.mjs
ENV NODE_ENV=production \
    SATURN_WEB_HOST=0.0.0.0 \
    SATURN_WEB_PORT=8080 \
    SATURN_WEB_ROOT=/srv
USER 1000:1000
EXPOSE 8080
CMD ["node","/app/static-server.mjs"]
