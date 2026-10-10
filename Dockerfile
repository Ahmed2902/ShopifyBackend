FROM node:22-bookworm-slim AS build

WORKDIR /app

# Prisma needs OpenSSL in slim images, and the repository postinstall runs
# `prisma generate` during npm ci. Copy the Prisma config/schema before npm ci
# so that lifecycle script can resolve the schema deterministically.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/check-production-env.mjs ./scripts/check-production-env.mjs

RUN npm run build

# One-off migration image includes the Prisma CLI and full migration history.
FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Prisma's runtime engine needs OpenSSL as well. Keep only the minimal system
# packages required by the production Node/Prisma process.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY scripts/check-worker-health.mjs ./scripts/check-worker-health.mjs
COPY scripts/check-sentry.mjs ./scripts/check-sentry.mjs
COPY scripts/monitor-check-in.mjs ./scripts/monitor-check-in.mjs

USER node

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api.js"]

# Single-replica Azure deployment: migrations, API and polling workers share one
# image. Keep the runtime target above for deployments with separate workers.
FROM runtime AS azure
ENV SENTRY_SERVICE=combined
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY scripts/check-production-env.mjs ./scripts/check-production-env.mjs
COPY scripts/start-production.mjs ./scripts/start-production.mjs
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m CMD node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-production.mjs"]
