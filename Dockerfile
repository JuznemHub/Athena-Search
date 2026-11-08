# Self-hosted Athena image. Built by Dokploy with buildType=dockerfile so
# deploys need only git + Docker Hub + npm + Debian — no Railpack download.
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production

# Headless Chromium for JS-rendered page scraping (CHROME_BIN override works too).
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "server/index.js"]
