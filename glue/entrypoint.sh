#!/bin/sh
set -eu

: "${OPENCLAW_GATEWAY_URL:?OPENCLAW_GATEWAY_URL is required}"
: "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}"
: "${EVOLUTION_BASE_URL:?EVOLUTION_BASE_URL is required}"
: "${EVOLUTION_API_KEY:?EVOLUTION_API_KEY is required}"

CFG_DIR="${HOME:-/home/app}/.openclaw"
CFG_FILE="$CFG_DIR/openclaw.json"

mkdir -p "$CFG_DIR"

cat > "$CFG_FILE" <<EOF
{
  "gateway": {
    "mode": "remote",
    "remote": {
      "url": "${OPENCLAW_GATEWAY_URL}"
    },
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    }
  }
}
EOF

chmod 600 "$CFG_FILE"

# Validate config; abort if schema rejects it
if ! openclaw config validate >/dev/null 2>&1; then
  echo "[entrypoint] openclaw config validate failed" >&2
  openclaw config validate || true
  exit 1
fi

exec node server.js
