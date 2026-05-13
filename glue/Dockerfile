FROM node:24-bookworm-slim AS base

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    OPENCLAW_DISABLE_UPDATE_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates socat \
 && rm -rf /var/lib/apt/lists/*

# Install OpenClaw CLI globally so this container can call `openclaw agent ...`
RUN npm install -g openclaw@latest \
 && openclaw --version

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js evolution.js openclaw.js entrypoint.sh ./
COPY public ./public

RUN chmod +x entrypoint.sh \
 && useradd --create-home --shell /bin/bash app \
 && mkdir -p /home/app/.openclaw \
 && chown -R app:app /app /home/app

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
