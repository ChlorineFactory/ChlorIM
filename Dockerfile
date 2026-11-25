# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

# Native build toolchain only needed in builder stage for better-sqlite3
RUN apk add --no-cache python3 make g++ && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY apps/server/package.json apps/server/tsconfig.json apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY packages/bridge/package.json packages/bridge/tsconfig.json packages/bridge/
COPY packages/mcp/package.json packages/mcp/tsconfig.json packages/mcp/

RUN --mount=type=cache,id=chiorim-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/ apps/
COPY scripts/ scripts/

RUN pnpm exec tsc -b \
 && pnpm --filter @chiorim/web build \
 && node scripts/compress-web.mjs apps/web/dist \
 && pnpm --filter @chiorim/server deploy --prod --legacy /prod/server \
 && cp -R apps/web/dist /prod/web \
 && test -f /prod/server/dist/index.js && test -f /prod/web/index.html \
 && find /prod/server/node_modules -type f \( -name "*.map" -o -name "*.md" -o -name "*.ts" ! -name "*.d.ts" \) -delete

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web \
    NODE_OPTIONS="--max-old-space-size=256"

RUN addgroup -S chiorim && adduser -S -G chiorim chiorim \
 && mkdir -p /data && chown chiorim:chiorim /data

COPY --from=builder --chown=chiorim:chiorim /prod/server /app/server
COPY --from=builder --chown=chiorim:chiorim /prod/web /app/web

USER chiorim
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1

CMD ["node", "/app/server/dist/index.js"]
