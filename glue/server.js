import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EvolutionClient } from "./evolution.js";
import { OpenClawClient } from "./openclaw.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- config ----------------------------------------------------------------

const cfg = {
  port: Number(process.env.PORT || 3000),
  logLevel: process.env.LOG_LEVEL || "info",
  evolution: {
    baseUrl: process.env.EVOLUTION_BASE_URL,
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE || "main",
  },
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  openclaw: {
    bin: process.env.OPENCLAW_BIN || "openclaw",
    timeoutMs: Number(process.env.OPENCLAW_TIMEOUT_SECONDS || 60) * 1000,
  },
  allowlist: (process.env.ALLOWLIST || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 30),
  skipGroups: (process.env.SKIP_GROUPS || "true") === "true",
  skipSelf: (process.env.SKIP_SELF || "true") === "true",
  pageTitle: process.env.PAGE_TITLE || "Connect WhatsApp to OpenClaw",
};

const log = pino({ level: cfg.logLevel });

const evolution = new EvolutionClient({
  baseUrl: cfg.evolution.baseUrl,
  apiKey: cfg.evolution.apiKey,
  instance: cfg.evolution.instance,
  logger: log,
});

const openclaw = new OpenClawClient({
  bin: cfg.openclaw.bin,
  timeoutMs: cfg.openclaw.timeoutMs,
  logger: log,
});

// ---- helpers ---------------------------------------------------------------

function jidToE164(remoteJid = "") {
  // e.g. "919876543210@s.whatsapp.net" -> "+919876543210"
  const num = String(remoteJid).split("@")[0].replace(/[^\d]/g, "");
  return num ? `+${num}` : "";
}

function isGroup(remoteJid = "") {
  return String(remoteJid).endsWith("@g.us");
}

function isAllowed(e164) {
  if (cfg.allowlist.includes("*")) return true;
  return cfg.allowlist.includes(e164);
}

function extractText(data) {
  const m = data?.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.ephemeralMessage?.message?.conversation ||
    m?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ""
  );
}

function verifyWebhookSignature(req) {
  if (!cfg.webhookSecret) return true;
  const provided = req.get("x-webhook-signature") || req.get("x-hub-signature-256") || "";
  if (!provided) return false;
  const expected = crypto
    .createHmac("sha256", cfg.webhookSecret)
    .update(req.rawBody || "")
    .digest("hex");
  const a = Buffer.from(provided.replace(/^sha256=/, ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Per-sender sliding window rate limiter (in-memory; fine for single-replica MVP)
const rateBuckets = new Map();

// Dedupe webhook events by message ID. Evolution v2 fires each event twice
// (global webhook + per-instance webhook, or duplicate emit on its side).
const seenMessageIds = new Map();
const SEEN_TTL_MS = 5 * 60_000;
function alreadyHandled(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of seenMessageIds) {
    if (now - t > SEEN_TTL_MS) seenMessageIds.delete(k);
  }
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.set(id, now);
  return false;
}
function checkRate(e164) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = (rateBuckets.get(e164) || []).filter((t) => now - t < windowMs);
  if (arr.length >= cfg.rateLimitPerMin) {
    rateBuckets.set(e164, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(e164, arr);
  return true;
}

// ---- express ---------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(pinoHttp({ logger: log, redact: ["req.headers.apikey", "req.headers.authorization"] }));
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, "public")));

// ---- health ----------------------------------------------------------------

app.get("/health", async (_req, res) => {
  const [evo, oc] = await Promise.all([evolution.ping(), openclaw.ping()]);
  res.status(evo && oc ? 200 : 503).json({
    ok: evo && oc,
    evolution: evo ? "reachable" : "down",
    openclaw: oc ? "reachable" : "down",
    instance: cfg.evolution.instance,
  });
});

// ---- pairing API (called by the QR UI) -------------------------------------

app.post("/pair/start", async (_req, res, next) => {
  try {
    await evolution.ensureInstance();
    const qr = await evolution.getQr();
    res.json({
      ok: true,
      instance: cfg.evolution.instance,
      qrBase64: qr.base64,
      pairingCode: qr.code,
    });
  } catch (e) { next(e); }
});

app.get("/pair/status", async (_req, res, next) => {
  try {
    const { state } = await evolution.getState();
    res.json({ ok: true, instance: cfg.evolution.instance, state });
  } catch (e) { next(e); }
});

app.post("/pair/restart", async (_req, res, next) => {
  try {
    await evolution.ensureInstance();
    const qr = await evolution.getQr();
    res.json({ ok: true, qrBase64: qr.base64, pairingCode: qr.code });
  } catch (e) { next(e); }
});

// ---- webhook (Evolution → glue) --------------------------------------------

app.post("/webhook", async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    log.warn("webhook signature rejected");
    return res.status(401).json({ ok: false, error: "bad signature" });
  }

  // Always 200 quickly so Evolution doesn't retry; do real work async
  res.status(200).json({ ok: true });

  const event = req.body?.event;
  const data = req.body?.data;
  log.info({
    event,
    messageType: data?.messageType,
    fromMe: data?.key?.fromMe,
    remoteJid: data?.key?.remoteJid,
    hasMessage: !!data?.message,
    msgKeys: data?.message ? Object.keys(data.message) : null,
  }, "webhook event");

  if (!event || !data) { log.debug("drop: no event or data"); return; }
  // Evolution sends event names like "messages.upsert" or "MESSAGES_UPSERT"
  const ev = String(event).toLowerCase().replace(/_/g, ".");
  if (ev !== "messages.upsert") { log.debug({ event }, "drop: not messages.upsert"); return; }

  const msgId = data?.key?.id;
  if (alreadyHandled(msgId)) {
    log.info({ msgId }, "drop: duplicate webhook");
    return;
  }

  const remoteJid = data?.key?.remoteJid || "";
  const fromMe = !!data?.key?.fromMe;
  if (cfg.skipSelf && fromMe) { log.info({ remoteJid }, "drop: fromMe"); return; }
  if (cfg.skipGroups && isGroup(remoteJid)) { log.info({ remoteJid }, "drop: group"); return; }

  const text = extractText(data);
  if (!text.trim()) {
    log.info({
      remoteJid,
      messageType: data?.messageType,
      msgKeys: data?.message ? Object.keys(data.message) : null,
    }, "drop: no text content");
    return;
  }

  const e164 = jidToE164(remoteJid);
  if (!e164) { log.warn({ remoteJid }, "drop: cannot derive E.164"); return; }

  if (!isAllowed(e164)) {
    log.info({ e164, allowlist: cfg.allowlist }, "drop: not in allowlist");
    return;
  }

  if (!checkRate(e164)) {
    log.warn({ e164 }, "rate limit exceeded");
    await safeSend(e164, "Slow down. Try again in a minute.");
    return;
  }

  const t0 = Date.now();
  log.info({ e164, len: text.length }, "openclaw turn start");

  let reply;
  try {
    reply = await openclaw.agentTurn({ to: e164, message: text });
  } catch (e) {
    log.error({ e164, err: e.message, code: e.code }, "openclaw turn failed");
    reply =
      e.code === "OPENCLAW_TIMEOUT"
        ? "Sorry, that took too long. Please try again."
        : "Sorry, I hit an error. Please try again in a moment.";
  }

  if (!reply || !reply.trim()) {
    log.warn({ e164 }, "empty reply from openclaw; skipping send");
    return;
  }

  await safeSend(e164, reply);
  log.info({ e164, ms: Date.now() - t0 }, "turn complete");
});

async function safeSend(e164, text) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await evolution.sendText(e164, text);
      return;
    } catch (e) {
      log.warn({ e164, attempt, err: e.message, status: e.status }, "sendText failed");
      if (attempt === maxAttempts) {
        log.error({ e164, text: text.slice(0, 200) }, "sendText giving up");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

// ---- error handler ---------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  req.log?.error({ err: err.message, status: err.status }, "request failed");
  res.status(err.status || 500).json({ ok: false, error: err.message });
});

// ---- start -----------------------------------------------------------------

app.listen(cfg.port, () => {
  log.info({ port: cfg.port, instance: cfg.evolution.instance }, "glue server listening");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info({ sig }, "shutting down");
    process.exit(0);
  });
}
