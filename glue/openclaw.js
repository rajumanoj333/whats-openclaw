import { spawn } from "node:child_process";

export class OpenClawClient {
  constructor({ bin = "openclaw", timeoutMs = 60_000, logger } = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.log = logger;
  }

  /**
   * Run a single agent turn keyed by the WhatsApp sender's E.164 number.
   * Returns the assistant reply text on success.
   */
  async agentTurn({ to, message }) {
    if (!to) throw new Error("agentTurn: to required");
    if (!message) throw new Error("agentTurn: message required");

    const args = [
      "agent",
      "--to", to,
      "--message", message,
      "--json",
      "--timeout", String(Math.ceil(this.timeoutMs / 1000)),
    ];

    const { stdout, stderr, code, timedOut } = await this.#run(args);

    if (timedOut) {
      const err = new Error("openclaw agent timed out");
      err.code = "OPENCLAW_TIMEOUT";
      throw err;
    }
    if (code !== 0) {
      const err = new Error(`openclaw agent exited ${code}: ${stderr.slice(0, 500)}`);
      err.code = "OPENCLAW_EXIT";
      err.stderr = stderr;
      throw err;
    }

    return this.#extractReply(stdout);
  }

  async ping() {
    try {
      const { code } = await this.#run(["--version"], 5000);
      return code === 0;
    } catch (e) {
      this.log?.warn({ err: e.message }, "openclaw ping failed");
      return false;
    }
  }

  #run(args, overrideTimeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks = { out: [], err: [] };
      let timedOut = false;
      const timeoutMs = overrideTimeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, timeoutMs);
      child.stdout.on("data", (b) => chunks.out.push(b));
      child.stderr.on("data", (b) => chunks.err.push(b));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(chunks.out).toString("utf8"),
          stderr: Buffer.concat(chunks.err).toString("utf8"),
          code: code ?? -1,
          timedOut,
        });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: e.message, code: -1, timedOut: false });
      });
    });
  }

  /**
   * `openclaw agent --json` output shape is not strictly contracted; try common fields.
   * Falls back to whole stdout if parsing/extraction fails.
   */
  #extractReply(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) return "";

    try {
      const obj = JSON.parse(trimmed);
      const candidates = [
        obj.reply,
        obj.text,
        obj.message,
        obj.output,
        obj.result?.reply,
        obj.result?.text,
        obj.result?.message,
        obj.assistant?.text,
        obj.assistant?.message,
        obj.data?.reply,
        obj.data?.text,
      ];
      const first = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
      if (first) return first.trim();
      // Last resort: stringify the JSON so we deliver _something_ rather than dropping the turn
      this.log?.warn({ keys: Object.keys(obj) }, "could not find reply text in openclaw JSON; returning stringified");
      return JSON.stringify(obj);
    } catch {
      // stdout was not JSON — assume it is the reply text directly
      return trimmed;
    }
  }
}
