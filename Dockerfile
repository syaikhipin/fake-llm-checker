# fake-llm-checker — single-container SaaS (API + in-process scan runner + SQLite).
# Needs: bash, curl, openssl, python3 (for the vendored scan-engine scripts).
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates openssl python3 dnsutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY web ./web
COPY vendor ./vendor
RUN chmod +x vendor/engine/*.sh

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    RUNNER_POLL_MS=3000 \
    MAX_CONCURRENT_SCANS=1 \
    SCAN_TIMEOUT_MS=600000

EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/server.js"]
