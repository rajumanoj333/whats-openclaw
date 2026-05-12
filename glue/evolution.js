import { fetch } from "undici";

export class EvolutionClient {
  constructor({ baseUrl, apiKey, instance, logger }) {
    if (!baseUrl) throw new Error("EvolutionClient: baseUrl required");
    if (!apiKey) throw new Error("EvolutionClient: apiKey required");
    if (!instance) throw new Error("EvolutionClient: instance required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.instance = instance;
    this.log = logger;
  }

  async #call(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const headers = { apikey: this.apiKey };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const err = new Error(`Evolution ${method} ${path} -> ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  async ensureInstance() {
    try {
      return await this.#call("POST", "/instance/create", {
        instanceName: this.instance,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      });
    } catch (e) {
      // 409 / 403 / 400 typically mean "already exists" — ignore
      if (e.status >= 400 && e.status < 500) {
        this.log?.debug({ status: e.status }, "instance already exists or rejected by Evolution");
        return null;
      }
      throw e;
    }
  }

  async getQr() {
    const payload = await this.#call("GET", `/instance/connect/${this.instance}`);
    const base64 =
      payload?.base64 ||
      payload?.qrcode?.base64 ||
      payload?.qrcode ||
      null;
    const code = payload?.code || payload?.pairingCode || null;
    return { base64, code, raw: payload };
  }

  async getState() {
    const payload = await this.#call("GET", `/instance/connectionState/${this.instance}`);
    const state =
      payload?.instance?.state ||
      payload?.state ||
      payload?.status ||
      "unknown";
    return { state, raw: payload };
  }

  async sendText(numberE164, text) {
    const number = String(numberE164).replace(/^\+/, "");
    return this.#call("POST", `/message/sendText/${this.instance}`, {
      number,
      text,
    });
  }

  async ping() {
    try {
      await this.#call("GET", "/");
      return true;
    } catch (e) {
      this.log?.warn({ err: e.message }, "evolution ping failed");
      return false;
    }
  }
}
