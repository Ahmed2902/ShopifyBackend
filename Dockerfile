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

RUN npm run build

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

USER node

EXPOSE 3001

CMD ["node", "dist/api.js"]
