const STATES = {
  idle:       { label: "Ready",          cls: "state--idle" },
  starting:   { label: "Generating QR…", cls: "state--qr" },
  qr:         { label: "Scan the QR with WhatsApp", cls: "state--qr" },
  connecting: { label: "Connecting…",    cls: "state--connecting" },
  open:       { label: "Connected",      cls: "state--open" },
  close:      { label: "Disconnected",   cls: "state--close" },
  error:      { label: "Error",          cls: "state--error" },
};

const $ = (sel) => document.querySelector(sel);
const stateEl     = $("#state");
const stateLabel  = $(".state__label");
const qrImg       = $("#qr-image");
const placeholder = $("#qr-placeholder");
const connectBtn  = $("#connect-btn");
const restartBtn  = $("#restart-btn");
const actions     = $("#actions");
const pairingEl   = $("#pairing-code");
const instanceEl  = $("#instance-label");

let pollTimer = null;
let polling   = false;
let connectedShown = false;
let qrRefreshTimer = null;
const QR_REFRESH_MS = 20_000;

function log(...args) { console.log("[whats-bot-ui]", ...args); }

function setState(key, override) {
  const def = STATES[key] || STATES.error;
  stateEl.className = `state ${def.cls}`;
  stateLabel.textContent = override || def.label;
  log("state ->", key, override || "");
}

function showQr(base64, pairingCode) {
  log("showQr base64 len:", base64 ? base64.length : 0);
  if (!base64) {
    placeholder.hidden = false;
    qrImg.hidden = true;
    if (pairingCode) {
      pairingEl.hidden = false;
      pairingEl.textContent = pairingCode;
    } else {
      pairingEl.hidden = true;
    }
    return;
  }
  qrImg.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  qrImg.hidden = false;
  placeholder.hidden = true;
  // Pairing code is a long opaque token from Baileys; not user-typed. Hide by default
  // since scanning the QR is the supported path. Keep DOM node for potential debug.
  pairingEl.hidden = true;
  pairingEl.textContent = "";
}

function showConnected() {
  if (connectedShown) return;
  connectedShown = true;
  qrImg.hidden = true;
  placeholder.innerHTML = '<div style="font-size:48px;line-height:1">✓</div><div style="margin-top:8px">Linked successfully</div>';
  placeholder.hidden = false;
  pairingEl.hidden = true;
  actions.hidden = false;
}

async function callPairStart() {
  log("POST /pair/start");
  const res = await fetch("/pair/start", { method: "POST" });
  const data = await res.json();
  log("/pair/start", res.status, "ok:", data.ok, "qrLen:", data.qrBase64 ? data.qrBase64.length : 0);
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || `start failed: ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

async function startPair() {
  setState("starting");
  actions.hidden = true;
  try {
    const data = await callPairStart();
    instanceEl.textContent = `Instance: ${data.instance}`;
    if (data.qrBase64) {
      showQr(data.qrBase64, data.pairingCode);
      setState("qr");
      beginQrRefresh();
    } else {
      setState("connecting");
    }
    actions.hidden = false;
    beginPolling();
  } catch (e) {
    console.error(e);
    setState("error", `Error: ${e.message}`);
  }
}

function beginQrRefresh() {
  if (qrRefreshTimer) return;
  qrRefreshTimer = setInterval(refreshQr, QR_REFRESH_MS);
}

function stopQrRefresh() {
  if (qrRefreshTimer) clearInterval(qrRefreshTimer);
  qrRefreshTimer = null;
}

async function refreshQr() {
  if (connectedShown) { stopQrRefresh(); return; }
  try {
    const data = await callPairStart();
    if (data.qrBase64) {
      showQr(data.qrBase64, data.pairingCode);
      log("QR refreshed");
    }
  } catch (e) {
    log("QR refresh failed", e.message);
  }
}

function beginPolling() {
  if (polling) return;
  polling = true;
  pollTimer = setInterval(pollStatus, 2000);
  pollStatus();
}

function stopPolling() {
  polling = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollStatus() {
  try {
    const res = await fetch("/pair/status", { headers: { "cache-control": "no-cache" } });
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    const state = (data.state || "").toLowerCase();
    if (state === "open") {
      setState("open");
      showConnected();
      stopPolling();
      stopQrRefresh();
    } else if (state === "connecting") {
      // Keep QR visible. Only change badge if no QR has been rendered yet.
      if (qrImg.hidden) setState("connecting");
    } else if (state === "close" || state === "closed") {
      setState("close");
    }
  } catch (e) {
    console.warn("status poll failed", e);
  }
}

connectBtn?.addEventListener("click", startPair);
restartBtn?.addEventListener("click", async () => {
  setState("starting");
  connectedShown = false;
  try {
    const res = await fetch("/pair/restart", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "restart failed");
    showQr(data.qrBase64, data.pairingCode);
    setState("qr");
    beginPolling();
  } catch (e) {
    setState("error", `Error: ${e.message}`);
  }
});

// Auto-start on page load: check current state, then either show connected or pair.
(async () => {
  try {
    log("page load, checking status");
    const res = await fetch("/pair/status", { headers: { "cache-control": "no-cache" } });
    const data = await res.json();
    if (res.ok && data.ok) {
      instanceEl.textContent = `Instance: ${data.instance}`;
      const state = String(data.state || "").toLowerCase();
      log("initial state:", state);
      if (state === "open") {
        setState("open");
        showConnected();
        return;
      }
    }
  } catch (e) {
    log("initial status check failed", e);
  }
  // Not connected -> auto-start pair immediately, no button click required.
  await startPair();
})();
