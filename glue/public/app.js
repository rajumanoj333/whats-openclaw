const STATES = {
  idle:       { label: "Ready",        cls: "state--idle" },
  starting:   { label: "Generating QR…", cls: "state--qr" },
  qr:         { label: "Waiting for scan", cls: "state--qr" },
  connecting: { label: "Connecting…",  cls: "state--connecting" },
  open:       { label: "Connected",    cls: "state--open" },
  close:      { label: "Disconnected", cls: "state--close" },
  error:      { label: "Error",        cls: "state--error" },
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

function setState(key, override) {
  const def = STATES[key] || STATES.error;
  stateEl.className = `state ${def.cls}`;
  stateLabel.textContent = override || def.label;
}

function showQr(base64, pairingCode) {
  if (!base64) {
    placeholder.hidden = false;
    qrImg.hidden = true;
    return;
  }
  qrImg.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  qrImg.hidden = false;
  placeholder.hidden = true;
  if (pairingCode) {
    pairingEl.hidden = false;
    pairingEl.textContent = `Code: ${pairingCode}`;
  } else {
    pairingEl.hidden = true;
  }
}

function showConnected() {
  qrImg.hidden = true;
  placeholder.innerHTML = '<div style="font-size:48px">✓</div><div>Linked successfully</div>';
  placeholder.hidden = false;
  pairingEl.hidden = true;
  actions.hidden = false;
}

async function startPair() {
  setState("starting");
  actions.hidden = true;
  try {
    const res = await fetch("/pair/start", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `start failed: ${res.status}`);
    instanceEl.textContent = `Instance: ${data.instance}`;
    if (data.qrBase64) {
      showQr(data.qrBase64, data.pairingCode);
      setState("qr");
      beginPolling();
    } else {
      // Evolution sometimes returns no QR if the instance is already paired
      setState("connecting");
      beginPolling();
    }
    actions.hidden = false;
  } catch (e) {
    console.error(e);
    setState("error", `Error: ${e.message}`);
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
    const res = await fetch("/pair/status");
    const data = await res.json();
    if (!res.ok || !data.ok) return;

    const state = (data.state || "").toLowerCase();
    if (state === "open") {
      setState("open");
      showConnected();
      stopPolling();
    } else if (state === "connecting") {
      setState("connecting");
    } else if (state === "close" || state === "closed") {
      setState("close");
    } else if (state === "qr" || state === "qrcode") {
      setState("qr");
    }
  } catch (e) {
    console.warn("status poll failed", e);
  }
}

connectBtn?.addEventListener("click", startPair);
restartBtn?.addEventListener("click", async () => {
  setState("starting");
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

// On page load, check status — if already connected, skip the QR step
(async () => {
  try {
    const res = await fetch("/pair/status");
    const data = await res.json();
    if (res.ok && data.ok) {
      instanceEl.textContent = `Instance: ${data.instance}`;
      if (String(data.state).toLowerCase() === "open") {
        setState("open");
        showConnected();
        return;
      }
    }
  } catch {}
  setState("idle");
})();
