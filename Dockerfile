# syntax=docker/dockerfile:1.7
# One Dockerfile, two images:
#   --target api  -> API and worker (same image, different command)
#   --target web  -> Caddy serving the web app and proxying /api to the API
# Pin base images by digest in production (docs/deployment.md, "Image pinning").

ARG NODE_IMAGE=node:22-bookworm-slim
ARG CADDY_IMAGE=caddy:2.10-alpine

# ───────────── build everything once ─────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w packages/shared \
 && npm run build -w apps/api \
 && npm run build -w apps/web
# Production dependencies only for the runtime image
RUN npm ci --omit=dev --no-audit --no-fund --workspace apps/api --include-workspace-root=false

# ───────────── API / worker runtime ─────────────
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
# Mount point for the encrypted files volume, owned by the unprivileged user
RUN mkdir -p /data/files && chown node:node /data/files
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ───────────── Web (static files + reverse proxy) ─────────────
FROM ${CADDY_IMAGE} AS web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
