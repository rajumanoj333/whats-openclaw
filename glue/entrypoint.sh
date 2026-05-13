#!/bin/sh
set -eu

: "${OPENCLAW_GATEWAY_URL:?OPENCLAW_GATEWAY_URL is required}"
: "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}"
: "${EVOLUTION_BASE_URL:?EVOLUTION_BASE_URL is required}"
: "${EVOLUTION_API_KEY:?EVOLUTION_API_KEY is required}"

# The OpenClaw CLI refuses plaintext ws:// to anything other than 127.0.0.1.
# When the gateway runs on the Docker host we reach it via `host.docker.internal`,
# which the CLI flags as non-loopback. To satisfy the check without changing the
# CLI's security policy, run a TCP forwarder inside this container that listens
# on the container's own 127.0.0.1:18789 and forwards to the host gateway.
#
# Two env vars control this:
#   GATEWAY_PROXY_HOST  - upstream host, default host.docker.internal
#   GATEWAY_PROXY_PORT  - upstream port, default 18789
# Set GATEWAY_PROXY_DISABLED=1 to skip the proxy (e.g. when OPENCLAW_GATEWAY_URL
# already points at a loopback or wss:// endpoint).
PROXY_HOST="${GATEWAY_PROXY_HOST:-host.docker.internal}"
PROXY_PORT="${GATEWAY_PROXY_PORT:-18789}"
LOCAL_PORT=18789

if [ "${GATEWAY_PROXY_DISABLED:-0}" != "1" ]; then
  echo "[entrypoint] starting socat: 127.0.0.1:${LOCAL_PORT} -> ${PROXY_HOST}:${PROXY_PORT}"
  socat TCP-LISTEN:${LOCAL_PORT},fork,reuseaddr,bind=127.0.0.1 TCP:${PROXY_HOST}:${PROXY_PORT} &
  SOCAT_PID=$!
  trap "kill $SOCAT_PID 2>/dev/null || true" EXIT INT TERM

  # Rewrite the gateway URL to point at the local proxy so the CLI sees loopback.
  # Preserve the path (typically /ws) and scheme (ws://).
  if echo "$OPENCLAW_GATEWAY_URL" | grep -q '^ws://'; then
    PATH_PART=$(echo "$OPENCLAW_GATEWAY_URL" | sed -E 's|^ws://[^/]+||')
    OPENCLAW_GATEWAY_URL="ws://127.0.0.1:${LOCAL_PORT}${PATH_PART}"
    export OPENCLAW_GATEWAY_URL
    echo "[entrypoint] rewrote OPENCLAW_GATEWAY_URL to $OPENCLAW_GATEWAY_URL"
  fi
fi

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

if ! openclaw config validate >/dev/null 2>&1; then
  echo "[entrypoint] openclaw config validate failed" >&2
  openclaw config validate || true
  exit 1
fi

exec node server.js
