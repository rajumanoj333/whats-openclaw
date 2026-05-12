# whats-openclaw

WhatsApp ↔ OpenClaw bot.

WhatsApp message → Evolution API → glue server → OpenClaw agent turn → reply delivered back through Evolution → user.

Pairing happens in a custom QR UI served by the glue server at `https://<your-domain>/`. No human in the reply loop.

## Repo layout

```
.
├── PLAN.md          step-by-step deploy plan (start here)
├── glue/            Node Express service: QR UI + webhook + OpenClaw bridge
└── README.md
```

## Quickstart

1. Read [PLAN.md](PLAN.md) and complete Phases 0–2 (Azure NSG, EasyPanel install, Evolution API deploy).
2. Push this repo to GitHub.
3. In EasyPanel: add an "App" service from the GitHub repo, build directory `glue/`, set env from `glue/.env.example`, attach domain.
4. Open `https://<your-domain>/`, scan QR with WhatsApp on the phone you want to make the bot.
5. Send the bot a message from another phone → reply appears.

## Architecture

```
┌─────────────────────── VM (Ubuntu 24.04) ──────────────────────┐
│                                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Evolution API│◄──►│   Postgres   │    │    Redis     │      │
│  └──────┬───────┘    └──────────────┘    └──────────────┘      │
│         │ webhook                                              │
│         ▼                                                      │
│  ┌──────────────────────┐       spawn          ┌────────────┐  │
│  │   glue (this repo)   │────────────────────►│  OpenClaw  │  │
│  │ - /  (QR UI)         │  openclaw agent     │  :18789    │  │
│  │ - /pair/start        │                     │  (host)    │  │
│  │ - /pair/status       │                     └────────────┘  │
│  │ - /webhook           │                                     │
│  │ - /health            │                                     │
│  └──────────────────────┘                                     │
│         ▲                                                     │
└─────────│─────────────────────────────────────────────────────┘
          │ HTTPS (via EasyPanel reverse proxy)
       WhatsApp user opens QR page; messages flow via Evolution
```

The glue container reaches the host's OpenClaw gateway via `host.docker.internal:18789`. EasyPanel must inject `--add-host host.docker.internal:host-gateway` (set under service → Advanced → Extra Hosts).

## Portability

All host-specific values are env vars (see `glue/.env.example`). Anyone can fork, change envs, deploy on any Docker host that runs OpenClaw locally.
