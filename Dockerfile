# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

# argon2 normally installs a prebuilt binary. Keep a compiler toolchain in the
# build stage so the image also builds on platforms without a matching binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && mkdir -p dist/db \
  && cp src/db/schema.sql dist/db/schema.sql

FROM dependencies AS production-dependencies

ENV NODE_ENV=production
RUN npm prune --omit=dev \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="relay-station" \
  org.opencontainers.image.description="Minimal OpenAI-compatible relay and billing service"

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((response)=>{if(!response.ok)throw new Error(String(response.status))}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
