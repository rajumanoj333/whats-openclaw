# WhatsApp ↔ OpenClaw bot — execution plan

Each step = action + verify command + expected output. Don't move on until verify passes.

## Context

- VM: `whats-openclaw` — public IP `135.235.140.117`, DNS `whatsapp.centralindia.cloudapp.azure.com`
- SSH: `ssh manoj@135.235.140.117`
- OpenClaw: already running, gateway `127.0.0.1:18789` (loopback only)
- Goal: WhatsApp msg → Evolution API → glue server → OpenClaw → reply back
- QR scan happens in **our own custom UI** served by glue server, not Evolution's built-in UI

## Architecture

```
WhatsApp user
      ▲ │
      │ ▼
   Evolution API (in EasyPanel)
      ▲ │
      │ ▼ webhook
   Glue server  ─── spawn `openclaw agent` ──► OpenClaw :18789
   - / (custom QR UI)
   - /pair/start, /pair/status
   - /webhook (inbound)
```

---

## Phase 0 — Pre-flight (Azure NSG + DNS)

### 0.1 Open temporary inbound port :3000 (EasyPanel signup), :80, :443
- **Action**: Azure Portal → VM `whats-openclaw` → Networking → Add inbound rule. Source = Any (or your IP), Dest port = `3000,80,443`, Protocol TCP, Allow. Priority 1000.
- **Verify** (from your laptop):
  ```powershell
  Test-NetConnection 135.235.140.117 -Port 80
  Test-NetConnection 135.235.140.117 -Port 443
  Test-NetConnection 135.235.140.117 -Port 3000
  ```
- **Expected**: `TcpTestSucceeded : True` for all three (port may say False until EasyPanel running — that's OK, retest after Phase 1).

### 0.2 DNS resolves
- **Verify**:
  ```powershell
  nslookup whatsapp.centralindia.cloudapp.azure.com
  ```
- **Expected**: Resolves to `135.235.140.117`.

---

## Phase 1 — Install EasyPanel on the VM

### 1.1 SSH in
- **Action**:
  ```powershell
  ssh manoj@135.235.140.117
  ```
- **Verify**:
  ```bash
  whoami && uname -a
  ```
- **Expected**: `manoj` + Linux details (Ubuntu/Debian).

### 1.2 Check Docker (EasyPanel installs it but useful to know)
- **Verify**:
  ```bash
  command -v docker || echo "missing"
  ```
- **Expected**: path printed, or "missing" (fine — installer adds it).

### 1.3 Install EasyPanel
- **Action**:
  ```bash
  curl -sSL https://get.easypanel.io | sh
  ```
- **Verify**:
  ```bash
  sudo docker ps --format '{{.Names}} {{.Status}}' | grep -i easypanel
  ```
- **Expected**: line like `easypanel Up ... (healthy)`.
- **If fails**: `sudo journalctl -u docker -n 50` and `curl ... | sh 2>&1 | tail -50`.

### 1.4 First-time admin signup
- **Action**: Open browser → `http://135.235.140.117:3000` → create admin account (strong password — save to your password manager).
- **Verify**: You land on EasyPanel dashboard.
- **If page won't load**: NSG :3000 not open (Phase 0.1) OR EasyPanel still booting (`docker logs easypanel`).

### 1.5 Attach the domain + HTTPS
- **Action**: EasyPanel → Settings → Domain → enter `whatsapp.centralindia.cloudapp.azure.com` → Save. EasyPanel auto-issues Let's Encrypt cert via :80.
- **Verify** (wait ~30s):
  ```powershell
  curl.exe -I https://whatsapp.centralindia.cloudapp.azure.com
  ```
- **Expected**: `HTTP/2 200` or `301` with valid TLS (no cert warning).
- **If fails**: NSG :80 still closed OR DNS not propagated. Recheck Phase 0.

### 1.6 Lock down :3000
- **Action**: Azure NSG → delete the :3000 rule (or restrict to your IP only). Now EasyPanel only reachable via HTTPS domain.
- **Verify**:
  ```powershell
  Test-NetConnection 135.235.140.117 -Port 3000
  ```
- **Expected**: `TcpTestSucceeded : False`. And `https://whatsapp.centralindia.cloudapp.azure.com` still works.

---

## Phase 2 — Deploy Evolution API via EasyPanel template

### 2.1 Create project
- **Action**: EasyPanel dashboard → Projects → Create Project → name `whats-bot`.
- **Verify**: Project appears in list.

### 2.2 Add Evolution API service from template
- **Action**: Inside project → Add Service → Templates → search "Evolution API" → click → Create.
- **Verify**: Three services appear in project: `evolution-api`, `postgres`, `redis` (template provisions all).
- **If "Evolution API" not in template list**: use "App" type with image `atendai/evolution-api:v2.1.1`, then add Postgres + Redis templates separately. (Backup path — let me know and I'll provide explicit env block.)

### 2.3 Configure Evolution env
- **Action**: Click `evolution-api` service → Environment → set:
  ```
  AUTHENTICATION_API_KEY=<generate 64-char random; click 🎲>
  DATABASE_ENABLED=true
  DATABASE_PROVIDER=postgresql
  DATABASE_CONNECTION_URI=postgresql://postgres:<pg-pass>@$(PROJECT_NAME)_postgres:5432/evolution
  CACHE_REDIS_ENABLED=true
  CACHE_REDIS_URI=redis://$(PROJECT_NAME)_redis:6379
  WEBHOOK_GLOBAL_ENABLED=true
  WEBHOOK_GLOBAL_URL=http://$(PROJECT_NAME)_glue:3000/webhook
  WEBHOOK_EVENTS_MESSAGES_UPSERT=true
  CONFIG_SESSION_PHONE_CLIENT=OpenClaw Bot
  LANGUAGE=en
  ```
  Save the API key — needed in Phase 3.
- **Verify**: Save + Deploy. Service status → Running.

### 2.4 Don't expose Evolution publicly
- **Action**: In `evolution-api` service → Domains tab → no public domain attached. Service stays on internal Docker network only.
- **Verify**: From your laptop:
  ```powershell
  curl.exe -I https://whatsapp.centralindia.cloudapp.azure.com  # still EasyPanel
  ```
  Evolution NOT publicly reachable.

### 2.5 Smoke test Evolution from VM
- **Action** (SSH session):
  ```bash
  sudo docker ps | grep evolution
  EVO=$(sudo docker ps --format '{{.Names}}' | grep evolution)
  sudo docker exec $EVO wget -qO- http://localhost:8080 | head
  ```
- **Expected**: HTML/JSON from Evolution. Container alive.

---

## Phase 3 — Build + deploy the glue server (with custom QR UI)

### 3.1 Create GitHub repo
- **Action**: New private repo `whats-bot-glue`. (I'll generate all files in the next round when you say "go".) Repo will contain: `server.js`, `public/index.html`, `package.json`, `Dockerfile`, `README.md`.

### 3.2 Deploy via EasyPanel
- **Action**: In `whats-bot` project → Add Service → App → Source = GitHub → pick repo, branch `main` → build mode Nixpacks (auto-detects Node).
- **Verify**: Build logs end with `Done`. Service status → Running.

### 3.3 Configure glue env
- **Action**: Service → Environment → set:
  ```
  PORT=3000
  EVOLUTION_BASE_URL=http://whats-bot_evolution-api:8080
  EVOLUTION_API_KEY=<same key from 2.3>
  EVOLUTION_INSTANCE=main
  OPENCLAW_BIN=openclaw
  OPENCLAW_HOST_URL=http://host.docker.internal:18789
  ALLOWLIST=*
  RATE_LIMIT_PER_MIN=30
  ```
- **Action**: Service → Advanced → Extra Hosts: `host.docker.internal:host-gateway` (so glue container can reach OpenClaw on VM host loopback :18789).
- **Action**: Service → Domains → attach `whatsapp.centralindia.cloudapp.azure.com` (path `/`). This is the public QR UI.

### 3.4 Make `openclaw` CLI reachable from glue container
- Problem: OpenClaw is installed under your `manoj` user, not inside the container. Two options — pick in Phase 3.5.

### 3.5 Pick how glue talks to OpenClaw
- **Option A (Recommended): HTTP via OpenClaw gateway WS** — glue uses Node `ws` client to talk to `ws://host.docker.internal:18789/ws`. Need WS protocol details from OpenClaw README/source (we already saw `/ws` accepts upgrade).
- **Option B: SSH from glue container** — glue spawns `ssh manoj@host.docker.internal openclaw agent ...`. Needs SSH key mounted into container. Works but ugly.
- **Option C: Run glue as systemd service on VM (NOT in EasyPanel)** — glue is plain `node server.js` under `systemctl`, can run `openclaw` directly. Reachable from Evolution via host networking.
- **Decision needed before I generate code**. Caveman recommendation: **A** if WS protocol straightforward, else **C**.

### 3.6 Verify glue health
- **Verify**:
  ```powershell
  curl.exe https://whatsapp.centralindia.cloudapp.azure.com/health
  ```
- **Expected**: `{"ok":true,"openclaw":"reachable","evolution":"reachable"}`.

---

## Phase 4 — Wire the webhook

### 4.1 Confirm webhook receipt
- **Action** (SSH on VM):
  ```bash
  GLUE=$(sudo docker ps --format '{{.Names}}' | grep glue)
  sudo docker logs -f $GLUE &
  EVO=$(sudo docker ps --format '{{.Names}}' | grep evolution)
  sudo docker exec $EVO curl -s -X POST http://whats-bot_glue:3000/webhook \
    -H 'Content-Type: application/json' \
    -d '{"event":"messages.upsert","data":{"key":{"remoteJid":"919999999999@s.whatsapp.net","fromMe":false,"id":"test"},"message":{"conversation":"ping"},"messageType":"conversation"}}'
  ```
- **Expected**: glue log shows received event + (in test mode) returns 200.

---

## Phase 5 — Pair the WhatsApp number via custom UI

### 5.1 Open the custom QR page
- **Action**: Browser → `https://whatsapp.centralindia.cloudapp.azure.com/`
- **Expected**: Page titled "Connect WhatsApp" with a button.

### 5.2 Trigger pairing
- **Action**: Click "Connect". The page POSTs `/pair/start` → glue calls Evolution `POST /instance/create` (idempotent) and `GET /instance/connect/main` → returns base64 QR. Page renders QR image.
- **Verify**: QR visible on page within ~3s.
- **Expected** (browser DevTools Network): `POST /pair/start` 200 with `{ qr: "data:image/png;base64,..." }`.

### 5.3 Scan with WhatsApp on phone
- **Action**: WhatsApp → Settings → Linked Devices → Link a device → scan the on-screen QR.
- **Verify**: Page polls `/pair/status` every 2s. Status flips to `connected`. Phone shows linked device "OpenClaw Bot".

### 5.4 End-to-end test
- **Action**: From a different WhatsApp account, send "hello" to the linked number.
- **Verify** (VM logs):
  ```bash
  sudo docker logs $GLUE | tail -30
  ```
  Should show: webhook received → openclaw agent invoked → reply text → Evolution sendText 200.
- **Expected**: Reply appears on the sending phone within ~5–10s.

---

## Phase 6 — Hardening (after MVP works)

- Switch `ALLOWLIST=*` → comma-separated E.164 list
- Add HMAC webhook signature verification (set `WEBHOOK_GLOBAL_SECRET` in Evolution + verify in glue)
- Daily cost cap (token budget)
- Postgres backup (EasyPanel built-in)
- Pin all images to specific tags, not `latest`
- Remove broad NSG rules; keep only :80, :443

---

## What's blocking next

1. **Phase 3.5 decision**: how does glue call OpenClaw? (A: WS, B: SSH-out, C: glue runs on host) — answer needed before I generate code.
2. **GitHub repo creation**: do you want me to write code into `c:\Users\Manoj Kasula\Desktop\whats\glue\` for you to push, OR scaffold to a new repo you create first?

Reply with answers and I'll generate the glue server (server.js, custom QR HTML page, package.json, Dockerfile).
