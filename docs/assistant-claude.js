/**
 * assistant-claude.js — Claude API backend for the data assistant.
 *
 * Drop-in replacement for ModelLadder: same chat()/quick()/interrupt() surface,
 * so the panel, retrieval, guards, and memory all work unchanged. When a key is
 * present nothing is downloaded and no WebGPU is used at all — which is what
 * makes this viable on a phone.
 *
 * Raw fetch rather than the SDK on purpose: no build step, exact control of the
 * CORS header, and one less CDN script on a page that holds an API key.
 *
 * The key lives only in this browser's localStorage, same as the GitHub token.
 * Anyone with the key can spend against the account, so treat it like a
 * password: personal use only, and set a spend limit in the Anthropic console.
 */

const API = "https://api.anthropic.com/v1/messages";
export const CLAUDE_KEY = "st-assistant-claude-key";
const MODEL = "claude-opus-5";

/** Opus 5 pricing, $ per million tokens — used for the running cost readout. */
const PRICE = { input: 5, output: 25 };

export const claudeKey = {
  get() { return localStorage.getItem(CLAUDE_KEY) || ""; },
  set(v) { v ? localStorage.setItem(CLAUDE_KEY, v) : localStorage.removeItem(CLAUDE_KEY); },
};

export class ClaudeBackend {
  constructor(opts = {}) {
    this.opts = opts;
    this.activeTier = "claude";
    this.abort = null;
    this.spend = 0; // running $ for this session
  }

  emit(e) { this.opts.onEvent?.(e); }

  /** Ladder-compatible no-ops: there is no local model to swap or download. */
  async switchTo() {}
  forceUpgrade() {}
  engagement() {}

  interrupt() {
    try { this.abort?.abort(); } catch {}
  }

  /**
   * The panel sends an OpenAI-shaped array with a leading system message and
   * Qwen's "/no_think" suffix. Translate both to Claude's API shape.
   */
  #build(messages, maxTokens) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const rest = messages.filter((m) => m.role !== "system");

    // "/no_think" is Qwen syntax; on Claude it maps to disabled thinking.
    let noThink = false;
    const chat = rest.map((m) => {
      let content = m.content;
      if (typeof content === "string" && content.includes("/no_think")) {
        noThink = true;
        content = content.replace(/\s*\/no_think\s*/g, " ").trim();
      }
      return { role: m.role === "assistant" ? "assistant" : "user", content };
    });

    const body = {
      model: MODEL,
      max_tokens: Math.max(1024, maxTokens ?? 1024),
      system,
      messages: chat,
      stream: true,
      // Adaptive thinking lets Claude decide how much to reason per question,
      // which replaces the JS router we needed for the local models.
      // Disabling is only permitted at effort "high" or below.
      ...(noThink
        ? { thinking: { type: "disabled" }, output_config: { effort: "high" } }
        : { thinking: { type: "adaptive", display: "summarized" } }),
    };
    return body;
  }

  async #send(body, { withFallbacks = true } = {}) {
    const headers = {
      "content-type": "application/json",
      "x-api-key": claudeKey.get(),
      "anthropic-version": "2023-06-01",
      // Required for any browser-origin request; without it the API returns 401.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    const payload = { ...body };
    if (withFallbacks) {
      // A safety-classifier decline is re-served by another model in the same
      // call instead of returning an empty answer.
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      payload.fallbacks = "default";
    }
    this.abort = new AbortController();
    return fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: this.abort.signal,
    });
  }

  /** Streaming chat. Yields {kind:"think"|"answer", text} like the local ladder. */
  async *chat(messages, maxTokens = 1024) {
    if (!claudeKey.get()) throw new Error("No Claude API key set — add one in settings (⚙).");
    const body = this.#build(messages, maxTokens);

    let res = await this.#send(body);
    // If the fallbacks beta isn't enabled on this account, retry plainly.
    if (res.status === 400) {
      const txt = await res.text();
      if (/fallback|beta/i.test(txt)) res = await this.#send(body, { withFallbacks: false });
      else throw new Error(this.#explain(400, txt));
    }
    if (!res.ok) throw new Error(this.#explain(res.status, await res.text()));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage = { input: 0, output: 0 };
    let stopReason = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (ev.type === "content_block_delta") {
            const d = ev.delta ?? {};
            if (d.type === "thinking_delta" && d.thinking) yield { kind: "think", text: d.thinking };
            else if (d.type === "text_delta" && d.text) yield { kind: "answer", text: d.text };
          } else if (ev.type === "message_start") {
            usage.input = ev.message?.usage?.input_tokens ?? 0;
          } else if (ev.type === "message_delta") {
            usage.output = ev.usage?.output_tokens ?? usage.output;
            stopReason = ev.delta?.stop_reason ?? stopReason;
          } else if (ev.type === "error") {
            throw new Error(ev.error?.message ?? "stream error");
          }
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") return; // user pressed Stop
      throw err;
    } finally {
      this.abort = null;
      const cost = (usage.input * PRICE.input + usage.output * PRICE.output) / 1e6;
      this.spend += cost;
      this.emit({ type: "usage", ...usage, cost, sessionSpend: this.spend });
    }

    if (stopReason === "refusal") {
      yield { kind: "answer", text: "\n\n[Claude declined this request on safety grounds.]" };
    }
  }

  /** Non-streaming one-liner — kept so the panel's router code still works. */
  async quick(messages, maxTokens = 24) {
    let out = "";
    for await (const c of this.chat(messages, Math.max(1024, maxTokens))) {
      if (c.kind === "answer") out += c.text;
    }
    return out;
  }

  #explain(status, text) {
    if (status === 401) return "Claude rejected the API key (401). Check it in settings.";
    if (status === 429) return "Rate limited by Claude (429). Wait a moment and retry.";
    if (status === 529) return "Claude is overloaded (529). Retry shortly.";
    if (status === 400) return `Claude rejected the request (400): ${String(text).slice(0, 200)}`;
    return `Claude API error ${status}: ${String(text).slice(0, 200)}`;
  }
}
