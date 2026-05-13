# whats-openclaw — Overview

End-to-end WhatsApp bot. WhatsApp message arrives, OpenClaw answers using Azure OpenAI gpt-5-chat, reply lands back in WhatsApp. Zero human in the loop.

---

## What was built

Single Azure VM hosting four cooperating pieces:

1. **OpenClaw** (native package, `npm install -g openclaw`). The AI agent. Listens for "agent turns" on a local WebSocket gateway. Backed by Azure OpenAI gpt-5-chat.
2. **Evolution API** (Docker container via EasyPanel). Bridge to WhatsApp Web. Manages the WhatsApp session (the linked-device QR pairing), exposes a REST API for sending messages, and posts incoming messages to a webhook.
3. **Glue server** (Node 24 Express, `glue/` in this repo, Docker container via EasyPanel). The bot brain wiring. Receives Evolution webhooks, dispatches to OpenClaw via the `openclaw agent` CLI, posts the reply back through Evolution. Also serves the custom QR pairing UI at `/`.
4. **socat bridge** (host-side systemd service + container-side process). Lets the containerised glue talk to the host's loopback-bound OpenClaw gateway without triggering OpenClaw's security check.

Everything runs on **one Azure VM** (`whats-openclaw`, public IP `135.235.140.117`, DNS `whatsapp.centralindia.cloudapp.azure.com`).

---

## Workflow — what happens on a single message

```
1. Phone user sends "hi"
        │
        ▼
2. WhatsApp servers deliver to the linked device session
        │
        ▼
3. Evolution API receives via Baileys WebSocket
        │
        ▼
4. Evolution fires HTTP POST to glue server:
        POST http://whatsapp_whatsapp-1:3000/webhook
        body: { event:"messages.upsert", data:{ key:{ remoteJid, id, fromMe:false }, message:{ conversation:"hi" } } }
        │
        ▼
5. Glue server (server.js):
   - dedupes by data.key.id (Evolution fires every event twice)
   - filters: skip groups, skip self, allowlist check
   - extracts text + E.164 sender number
   - logs "openclaw turn start"
        │
        ▼
6. Glue spawns CLI:
        openclaw agent --to +9163... --message "hi" --json --timeout 60
        │
        ▼
7. CLI connects ws://127.0.0.1:18789/ws (in container)
        │
        ▼
8. Container-side socat forwards to 172.18.0.1:18789 (docker bridge IP)
        │
        ▼
9. Host-side socat (systemd unit) forwards 172.18.0.1:18789 → 127.0.0.1:18789
        │
        ▼
10. OpenClaw gateway accepts (peer addr is 127.0.0.1, security check passes)
        │
        ▼
11. OpenClaw runs an agent turn → calls Azure OpenAI gpt-5-chat
        │
        ▼
12. Reply JSON returned: { result: { payloads: [{ text: "Hey 👋 …" }], … } }
        │
        ▼
13. Glue extracts result.payloads[0].text
        │
        ▼
14. Glue POSTs to Evolution: /message/sendText/main { number, text }
        │
        ▼
15. Evolution sends via Baileys → WhatsApp delivers to phone
        │
        ▼
16. User sees the reply
```

End-to-end latency: 5–25s (gpt-5-chat dominates).

---

## Why each component exists

| Component | Why not skip |
|---|---|
| **OpenClaw** | Open-source multi-channel AI assistant framework. Handles session memory, model failover, the agent loop. Already installed and configured on the VM — used as the "brain". |
| **Evolution API** | OpenClaw's built-in WhatsApp channel exists, but you wanted a separate, neutral WhatsApp gateway you could control independently. Evolution = mature WhatsApp Web wrapper (Baileys under hood) with REST + webhooks. |
| **Glue server** | The bridge. Evolution speaks REST/webhook; OpenClaw speaks WebSocket + JSON CLI. Glue translates between them, applies policy (rate limit, allowlist, dedupe), and serves the QR pairing UI. |
| **socat** | OpenClaw refuses plaintext `ws://` to anything other than 127.0.0.1 — protects the token from being sniffed on shared networks. Inside a container `host.docker.internal` resolves to a non-loopback IP, so OpenClaw rejects it. Two socat hops make the peer address look like 127.0.0.1 to OpenClaw while still letting packets flow from the container. |

---

## Cost

| Item | Monthly recurring (USD) |
|---|---|
| Azure VM (current size — modest 2 vCPU / 8 GB) | ~$30–50 depending on plan and region |
| Public IP (static) | ~$3 |
| Outbound bandwidth (WhatsApp + Azure OpenAI calls) | ~$1–5 at light volume |
| Azure OpenAI gpt-5-chat usage | Pay per token. Light chat = pennies. Heavy daily use = a few dollars/month. The current OpenClaw config shows `cost: 0` because you're on a custom Azure deployment without per-token billing surfaced — your Azure OpenAI bill is the actual cost driver. |
| Evolution API license | Free, MIT |
| OpenClaw | Free, MIT |
| EasyPanel (self-hosted) | Free for personal use. Pro license $15/mo if you want multiple servers or white-label. |
| GitHub private repo | Free |
| **Total at light usage** | **~$35–60/month** |

To reduce: use a smaller VM size (B1ms can run all this for ~$15/mo). Watch Azure OpenAI usage; cap with the daily budget feature.

---

## Is the workflow correct

Yes for an MVP. Caveats:

- **socat double-proxy is a hack** — it satisfies OpenClaw's loopback check without addressing the underlying risk (token traverses Docker bridge unencrypted between container and host). On a single-tenant VM this is acceptable. For multi-tenant or shared Docker hosts, switch to `wss://` on OpenClaw gateway and set `GATEWAY_PROXY_DISABLED=1`.
- **Secrets have leaked into chat** during debugging (Evolution API key, OpenClaw gateway token, Postgres password, Redis password). Rotate them. Best practice: never paste full env files into shared transcripts.
- **`ALLOWLIST=*`** means anyone who messages the WhatsApp number gets an AI reply on your dime. Set to your actual users' E.164 numbers before going public.
- **No HMAC on Evolution webhooks** — Evolution v2.3.7 doesn't sign outbound webhooks, so we rely on the Docker private network for isolation. Good enough for now.
- **Dedupe is in-memory** — works for one glue replica. Scaling to multiple replicas needs a shared store (Redis is already running).

---

## Step-by-step recap (what we did)

| Phase | What | Why |
|---|---|---|
| 0 | Opened Azure NSG inbound :22 / :80 / :443 / :3000 (temp) | EasyPanel ports needed |
| 1 | Installed EasyPanel: `curl -sSL https://get.easypanel.io \| sudo bash` | Docker + Caddy/Traefik + service UI |
| 2 | Attached domain `whatsapp.centralindia.cloudapp.azure.com` in EasyPanel settings | TLS via Let's Encrypt |
| 3 | Created project `whatsapp` → added Evolution API template (auto-provisions postgres + redis) | WhatsApp Web bridge |
| 4 | Generated `AUTHENTICATION_API_KEY`, set into Evolution env | Evolution admin auth |
| 5 | Wrote glue server (Node Express): `/webhook`, `/pair/start`, `/pair/status`, `/health`, static QR UI | Translator + policy layer |
| 6 | Pushed glue to GitHub `rajumanoj333/whats-openclaw` | Source-controlled, EasyPanel deploys from git |
| 7 | Created EasyPanel App service → repo + branch + build path `glue` + Dockerfile | Container build pipeline |
| 8 | Fixed: build path typo `gule`, Dockerfile path doubled, Traefik upstream port wrong (80 instead of 3000) | Misconfig debugging |
| 9 | Set per-instance Evolution webhook via REST: `POST /webhook/set/main { url: http://whatsapp_whatsapp-1:3000/webhook, events: [MESSAGES_UPSERT, CONNECTION_UPDATE] }` | Tell Evolution where to forward msgs |
| 10 | Paired WhatsApp by scanning QR in the custom UI (`whatsapp-whatsapp-1.osp27v.easypanel.host/`) | Activates the linked-device WhatsApp Web session |
| 11 | Added `socat` to Dockerfile + entrypoint forwarder | OpenClaw security policy needs loopback peer addr |
| 12 | Added host-side socat as systemd unit | Persistent across reboot |
| 13 | Patched openclaw.js reply extractor for `result.payloads[].text` shape | OpenClaw 2026.5.x JSON shape was different |
| 14 | Added message-ID dedupe in webhook handler | Evolution double-fires each event |

---

## How to use it (operations)

### Sending a test message
1. From any WhatsApp account other than the bot's paired number, message the bot.
2. Reply arrives in 5–25s.

### Watching live activity
```bash
GLUE=$(sudo docker ps --format '{{.Names}}' | grep whatsapp_whatsapp-1 | head -1)
sudo docker logs -f $GLUE 2>&1 | grep -vE '/health|/pair/'
```

### Re-pairing (if WhatsApp drops the session)
Open `https://whatsapp-whatsapp-1.osp27v.easypanel.host/`. Custom UI auto-starts pairing, displays QR, auto-refreshes every 20s until scanned.

### Updating the bot code
1. Edit locally in `glue/`
2. `git commit && git push`
3. EasyPanel → glue service → **Deploy** (or enable Auto Deploy on the Source tab)

### Health check
```
https://whatsapp-whatsapp-1.osp27v.easypanel.host/health
```
Returns `{ ok, evolution: "reachable", openclaw: "reachable", instance: "main" }`.

---

## How to integrate this into your own application

### Pattern A — Use this stack as-is, replace the AI brain
Keep glue + Evolution. Swap OpenClaw for your own service. Edit `glue/openclaw.js` to call your endpoint instead of spawning the `openclaw` CLI:

```js
async agentTurn({ to, message }) {
  const res = await fetch("https://your-ai-service/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${process.env.YOUR_API_KEY}` },
    body: JSON.stringify({ user: to, text: message }),
  });
  const data = await res.json();
  return data.reply;
}
```

Everything else (Evolution, webhook routing, QR UI, dedupe, allowlist) stays.

### Pattern B — Drop into an existing webhook system
You already have a server somewhere. Just point Evolution's webhook at it:
1. Deploy Evolution API by itself (skip glue)
2. Configure `WEBHOOK_GLOBAL_URL=https://your-app.example.com/whatsapp/webhook`
3. In your app, handle Evolution's webhook shape (`event: "messages.upsert"`, `data.key.remoteJid`, `data.message.conversation`)
4. Send replies via `POST https://your-evolution-host/message/sendText/main` with `apikey` header

### Pattern C — Embed in a SaaS product
Each customer pairs their own WhatsApp number:
- Multi-tenant Evolution: create one instance per customer via `POST /instance/create { instanceName: <customer-id> }`
- Webhook URL stays one endpoint; differentiate by `instance` field in payload
- Store paired-instance state per customer in your DB
- Use Evolution's master `AUTHENTICATION_API_KEY` for admin actions; you can also generate per-instance API keys

### Pattern D — Use OpenClaw's native WhatsApp channel (no Evolution)
OpenClaw has a built-in WhatsApp channel. If you don't need Evolution's multi-tenant features:
```
openclaw channels login --channel whatsapp
```
Scan the QR. Configure `dmPolicy` + `allowFrom` in OpenClaw config. Skips this entire glue/Evolution stack.

---

## How we used EasyPanel

EasyPanel = web UI on top of Docker Swarm + Traefik + Let's Encrypt. Concepts:

- **Project** — namespace (we used `whatsapp`). Services in a project share an internal network.
- **Service** — a container (or set of containers, e.g. a Template like Evolution API spawns 3 containers).
- **Template** — a prebuilt service definition. We used the Evolution API template (auto-deploys evolution-api + postgres + redis).
- **App** — a service built from a Git repo (your own code). Either Dockerfile build OR Nixpacks auto-detect.
- **Domain** — public hostname attached to a service. EasyPanel writes a Traefik rule + requests a Let's Encrypt cert.
- **Internal network** — services in a project reach each other at `<project>_<service>-<replica>` (e.g. `whatsapp_evolution-api`, `whatsapp_whatsapp-1`).

Recurring operations:
- **Deploy** = pull latest git commit, rebuild image, replace container with zero-downtime swap.
- **Stop/Start** = pause/resume container without rebuilding.
- **Environment** = edit env vars; requires Save AND Deploy to take effect.
- **Logs tab** = real-time stream.

### Replicating this setup on a new server
1. Fresh Linux VM (Ubuntu 24.04 LTS, ≥2 GB RAM, ≥10 GB disk).
2. Open NSG/firewall :22 (SSH), :80, :443.
3. `curl -sSL https://get.easypanel.io | sudo bash`
4. EasyPanel → Settings → set your domain → wait for TLS.
5. Create project → add Evolution API template → set env (API key, webhook URL placeholder).
6. Add App service → point at your GitHub repo (this one or your fork) → build path `glue` → set env (including pointing at the Evolution service hostname).
7. Run the per-instance webhook setup via `curl POST /webhook/set/main ...` (or use Evolution Manager UI).
8. Visit your glue domain → scan QR → done.

Total time: ~30 min once you know the path. We took longer because we were discovering everything for the first time.

---

## What's left to do

- [ ] Rotate Evolution `AUTHENTICATION_API_KEY` (still original value, leaked in chat)
- [ ] Rotate OpenClaw gateway token (rotated mid-session; rotate again as hygiene)
- [ ] Make host-side socat a systemd unit (see PLAN.md Phase 6)
- [ ] Make OpenClaw gateway a systemd unit (currently nohup; dies on reboot)
- [ ] Lock down `ALLOWLIST` from `*` to specific E.164 numbers
- [ ] Set up Postgres backup (EasyPanel offers built-in volume backup)
- [ ] Pin Docker image tags (avoid `:latest`)
- [ ] Set up basic monitoring (uptime check, log rotation)
- [ ] Cost cap on Azure OpenAI (daily token budget)
