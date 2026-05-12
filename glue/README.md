# Glue server — WhatsApp ↔ OpenClaw

Node Express service that:

1. Serves a custom QR pairing UI at `/`.
2. Proxies pairing actions to Evolution API (`/pair/start`, `/pair/status`, `/pair/restart`).
3. Receives Evolution webhook events at `/webhook`, runs an OpenClaw agent turn, posts the reply back to Evolution.

## Endpoints

| Method | Path           | Purpose                                                          |
|-------:|----------------|------------------------------------------------------------------|
| GET    | `/`            | QR pairing UI (static).                                          |
| GET    | `/health`      | Liveness + dependency reachability.                              |
| POST   | `/pair/start`  | Ensure the WhatsApp instance exists and return a fresh QR.       |
| GET    | `/pair/status` | Return `{ state }` — one of `qr`, `connecting`, `open`, `close`. |
| POST   | `/pair/restart`| Force a new QR.                                                  |
| POST   | `/webhook`     | Evolution → glue. Filters, dispatches to OpenClaw, replies.      |

## Environment

See `.env.example`. Required:

- `EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`
- `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`

Optional:

- `WEBHOOK_SECRET` — if set, glue rejects webhooks without a matching HMAC-SHA256 in `X-Webhook-Signature`. Configure the same value in Evolution if your build supports `WEBHOOK_GLOBAL_SECRET`.
- `ALLOWLIST` — comma-separated E.164 numbers (with `+`), or `*` for any sender. Default `*`.
- `RATE_LIMIT_PER_MIN` — per-sender rolling 60-second window, default 30.
- `SKIP_GROUPS`, `SKIP_SELF` — default `true`.

## Build (Docker)

```bash
cd glue
docker build -t whats-bot-glue:dev .
```

## Run (Docker, standalone test)

```bash
docker run --rm --name glue \
  --add-host=host.docker.internal:host-gateway \
  -p 3000:3000 \
  --env-file .env \
  whats-bot-glue:dev
```

Open `http://localhost:3000`.

## Deploy with EasyPanel

1. Push this repo to GitHub.
2. EasyPanel → project `whats-bot` → Add Service → App → from GitHub.
3. Build settings:
   - Build path: `glue`
   - Build type: Dockerfile (auto-detected)
4. Environment: copy from `.env.example`, set real values. `EVOLUTION_BASE_URL` should use the internal EasyPanel hostname (e.g. `http://whats-bot_evolution-api:8080`).
5. Advanced → Extra Hosts: add `host.docker.internal:host-gateway` so the container can reach OpenClaw on the host's loopback at port 18789.
6. Domains: attach your public hostname; EasyPanel handles TLS.
7. Deploy.

## Verify after deploy

```bash
# Liveness
curl https://<your-domain>/health
# Expected: {"ok":true,"evolution":"reachable","openclaw":"reachable",...}

# Sanity-check webhook routing without touching WhatsApp
curl -X POST https://<your-domain>/webhook \
  -H 'Content-Type: application/json' \
  -d '{"event":"messages.upsert","data":{"key":{"remoteJid":"919999999999@s.whatsapp.net","fromMe":false,"id":"test"},"message":{"conversation":"ping"},"messageType":"conversation"}}'
# Expected: {"ok":true}, then service logs show "openclaw turn start" and either a sendText
# attempt or an allowlist drop depending on your ALLOWLIST setting.
```

## OpenClaw config (inside the container)

`entrypoint.sh` writes a minimal `~/.openclaw/openclaw.json` at container start using the env vars, then runs `openclaw config validate` before launching the server. If validation fails the container exits.

Shape written:

```json
{
  "gateway": {
    "mode": "remote",
    "remote": { "url": "ws://host.docker.internal:18789/ws" },
    "auth":   { "mode": "token", "token": "***" }
  }
}
```

If `openclaw config validate` rejects this shape on your OpenClaw version, run on the host:

```bash
openclaw config schema | jq '.properties.gateway' | head -80
```

and patch `entrypoint.sh` accordingly.

## OpenClaw reply parsing

The CLI's `--json` output shape is not strictly contracted across OpenClaw versions. `openclaw.js` looks at the common fields in order: `reply`, `text`, `message`, `output`, `result.reply`, `result.text`, `result.message`, `assistant.text`, `assistant.message`, `data.reply`, `data.text`. If none match, the raw stdout is delivered so the user still gets something. If your version uses a different key, see the warning log line `"could not find reply text in openclaw JSON"` and add it to the candidates list in `openclaw.js`.

## Troubleshooting

| Symptom                                            | Likely cause                                                                                       |
|----------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `/health` says `openclaw: down`                    | Container can't reach the host gateway. Confirm Extra Hosts mapping and that OpenClaw is bound to `127.0.0.1:18789` on the host. |
| `/health` says `evolution: down`                   | Wrong `EVOLUTION_BASE_URL` (use the EasyPanel internal hostname) or wrong `EVOLUTION_API_KEY`.     |
| QR never appears                                   | Evolution instance not created. Check Evolution logs; try `POST /pair/restart`.                    |
| Pairs successfully but no reply on incoming msg    | Webhook not wired. Set `WEBHOOK_GLOBAL_URL=http://whats-bot_glue:3000/webhook` in Evolution env.   |
| Reply comes back as `{...}` JSON instead of text   | The OpenClaw `--json` output shape doesn't match the candidates list. See "OpenClaw reply parsing" above. |
| All inbound messages dropped silently              | `ALLOWLIST` doesn't include the sender. Set to `*` while testing.                                  |
