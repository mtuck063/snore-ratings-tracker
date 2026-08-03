/**
 * assistant.js — panel UI + GitHub-backed memory for the data assistant.
 * Engine, model ladder, digest, and system prompt live in assistant-core.js
 * (shared with evals.html so evals test exactly what production runs).
 *
 * Memory model: the user asks in chat ("remember that …" / "save this") —
 * detected deterministically, saved via the GitHub contents API, confirmed
 * in the panel. No per-message buttons, no model-driven tool calls (the
 * small tiers can't do those reliably).
 */

import {
  TIERS,
  ModelLadder,
  ThinkParser,
  buildDigest,
  contextFor,
  detectCountry,
  INTENT,
  systemPrompt,
  webllm,
} from "./assistant-core.js?v=9";
import { planGuards, checkAnswer, repairAnswer, blockedWords } from "./assistant-guards.js?v=3";
import { ClaudeBackend, claudeKey } from "./assistant-claude.js?v=1";

const REPO = "mtuck063/snore-ratings-tracker";
const MEMORY_PATH = "docs/data/assistant-memory.json";
const TOKEN_KEY = "st-assistant-gh-token";
const HISTORY_CAP = 6; // small models, small context — keep the tail only

/** "remember that X" / "save this" / "note down …" — handled without the model */
const REMEMBER_RE = /\b(remember|save (this|that)|note (this|that|down))\b/i;
const REMEMBER_STRIP_RE = /^(please\s+)?(can you\s+)?(remember|note down|note|save)\s*(that|this)?\s*[:,-]?\s*/i;

// ---------------------------------------------------------------------------
// Memory — committed to the repo via the GitHub contents API.
// The PAT lives ONLY in localStorage on the owner's machine.
// ---------------------------------------------------------------------------

const memory = {
  notes: [],
  // Falls back to the token the dashboard already stores for the
  // "Full update" workflow-dispatch buttons — one token, both features.
  get token() {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem("ghDispatchToken") || "";
  },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },

  async save(text) {
    if (!this.token) throw new Error("no-token");
    const note = { date: new Date().toISOString(), text };
    const api = `https://api.github.com/repos/${REPO}/contents/${MEMORY_PATH}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    // Read current file (for sha + latest notes — the Pages copy lags deploys)
    let sha, existing = [];
    const cur = await fetch(api, { headers });
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      try { existing = JSON.parse(atob(j.content.replace(/\n/g, ""))).notes ?? []; } catch {}
    } else if (cur.status !== 404) {
      throw new Error(`GitHub read failed (${cur.status})`);
    }
    existing.push(note);
    const body = JSON.stringify({ notes: existing }, null, 1);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
    const put = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({ message: "assistant: save learning", content: b64, ...(sha ? { sha } : {}) }),
    });
    if (!put.ok) {
      throw new Error(
        `GitHub write failed (${put.status})` +
          (put.status === 403 || put.status === 404
            ? " — your saved token may lack Contents read/write for this repo"
            : ""),
      );
    }
    this.notes = existing;
    return note;
  },
};

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------

const html = `
<div class="ai-head">
  <strong>Data assistant</strong>
  <span class="ai-badge" id="ai-badge">off</span>
  <button class="ai-chip" id="ai-upgrade-chip" hidden title="Download the bigger model for better answers">Get 8B</button>
  <span class="ai-spacer"></span>
  <button class="ai-icon" id="ai-gear" title="Memory settings" aria-label="Memory settings">⚙</button>
  <button class="ai-icon" id="ai-close" title="Close" aria-label="Close assistant">✕</button>
</div>
<div class="ai-settings" id="ai-settings" hidden>
  <label for="ai-engine-select">Answer engine</label>
  <select id="ai-engine-select">
    <option value="device">On device — private, free, works offline</option>
    <option value="claude">Claude API — best quality, needs a key</option>
  </select>

  <div id="ai-engine-claude" hidden>
    <div class="ai-token-row">
      <input type="password" id="ai-claude-key" placeholder="sk-ant-…" autocomplete="off" />
      <button id="ai-claude-save">Save key</button>
    </div>
    <p id="ai-claude-state"></p>
  </div>

  <div id="ai-engine-device">
    <select id="ai-model-select">
      <option value="0.6b">Qwen3 0.6B — instant, ~450 MB (default)</option>
      <option value="4b">Qwen3 4B — better answers, ~2.4 GB</option>
      <option value="8b">Qwen3 8B — strongest, ~4.7 GB</option>
    </select>
    <p>Downloads once and is cached. Bigger models need more memory and hold the GPU longer on each question — on phones, stay on 0.6B.</p>
  </div>

  <hr class="ai-sep" />
  <div id="ai-token-form">
    <label for="ai-token">GitHub token for saved learnings</label>
    <div class="ai-token-row">
      <input type="password" id="ai-token" placeholder="fine-grained PAT, this repo only" autocomplete="off" />
      <button id="ai-token-save">Save</button>
    </div>
    <p>Stored only in this browser's localStorage — never in the repo. Use a fine-grained PAT limited to <code>${REPO}</code> with Contents read/write.</p>
  </div>
  <div id="ai-token-connected" hidden>
    <p id="ai-token-source"></p>
    <div class="ai-token-row">
      <button id="ai-token-change">Change token</button>
      <button id="ai-token-clear">Remove token</button>
    </div>
  </div>
</div>
<div class="ai-progress" id="ai-progress" hidden><div class="ai-progress-fill" id="ai-progress-fill"></div></div>
<div class="ai-status" id="ai-status"></div>
<div class="ai-msgs" id="ai-msgs">
  <div class="ai-start" id="ai-start">
    <p>Ask questions about your ratings, keyword ranks, and reviews. The model runs entirely in your browser — nothing leaves this device.</p>
    <button id="ai-start-btn">Start assistant</button>
    <p class="ai-fine" id="ai-start-note">First start downloads a quick ~450 MB model so you can ask right away, then fetches the stronger 8B (~4.7 GB) in the background. Both are cached — later visits are instant.</p>
  </div>
</div>
<form class="ai-composer" id="ai-composer">
  <div class="ai-composer-box">
    <textarea id="ai-input" placeholder="Ask about the data…" rows="1" disabled></textarea>
    <div class="ai-composer-row">
      <select id="ai-think-select" title="Thinking gives better answers on strategy questions but takes longer. Auto decides per question.">
        <option value="auto">Think: auto</option>
        <option value="on">Think: on</option>
        <option value="off">Think: off</option>
      </select>
      <span class="ai-spacer"></span>
      <span class="ai-hint">Shift+↵ for new line</span>
      <button type="submit" id="ai-send" disabled>Send</button>
    </div>
  </div>
</form>`;

function setup() {
  const fab = document.createElement("button");
  fab.id = "assistant-fab";
  fab.setAttribute("aria-label", "Ask about this data");
  fab.textContent = "✦";
  document.body.appendChild(fab);

  const panel = document.createElement("aside");
  panel.id = "assistant";
  panel.setAttribute("aria-label", "Data assistant");
  panel.hidden = true;
  panel.innerHTML = html;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(`#${id}`);
  const msgs = $("ai-msgs"), input = $("ai-input"), send = $("ai-send");
  const badge = $("ai-badge"), status = $("ai-status");

  let ladder = null, digest = null, history = [], starting = false;
  // "auto" → a fast router call decides per question; "on"/"off" force it
  const MODEL_KEY = "st-assistant-model";
  const ENGINE_KEY = "st-assistant-engine";
  const engineOf = () => (localStorage.getItem(ENGINE_KEY) === "claude" && claudeKey.get() ? "claude" : "device");
  let localLadder = null;
  let thinkMode = localStorage.getItem("st-assistant-think") || "auto";
  if (!["auto", "on", "off"].includes(thinkMode)) thinkMode = "auto";

  const scroll = () => (msgs.scrollTop = msgs.scrollHeight);

  function open() {
    panel.hidden = false;
    document.body.classList.add("assistant-open");
    fab.hidden = true;
    if (!ladder && !starting) void maybeAutoStart();
    input.focus();
  }
  function close() {
    panel.hidden = true;
    document.body.classList.remove("assistant-open");
    fab.hidden = false;
  }
  fab.onclick = open;
  $("ai-close").onclick = close;

  /** Spin up the local model on demand — the offline/API-failure backup. */
  async function ensureLocalBackup() {
    if (localLadder) return localLadder;
    status.textContent = "Claude unreachable — starting the on-device model…";
    localLadder = new ModelLadder({
      pinnedTier: localStorage.getItem(MODEL_KEY) || "0.6b",
      onEvent: (e) => {
        if (e.type === "download-progress") {
          $("ai-progress").hidden = false;
          $("ai-progress-fill").style.width = `${Math.round(e.progress * 100)}%`;
          status.textContent = `[${e.tier}] ${e.text}`;
        } else if (e.type === "tier-active") {
          $("ai-progress").hidden = true;
          badge.textContent = `Qwen3 ${e.tier.toUpperCase()}`;
        }
      },
    });
    await localLadder.init();
    return localLadder;
  }

  /** Config errors (bad key, bad request) are the user's to fix; anything else
   *  — offline, rate limit, overload — is worth falling back for. */
  const isTransient = (err) => !/401|400|api key/i.test(String(err?.message ?? err));

  // -- send / stop -----------------------------------------------------
  let sending = false;
  function setSending(on) {
    sending = on;
    send.textContent = on ? "Stop" : "Send";
    send.classList.toggle("ai-stop", on);
    send.disabled = false;
  }
  send.addEventListener("click", (ev) => {
    if (!sending) return; // normal submit
    ev.preventDefault();
    ladder?.interrupt();
    status.textContent = "Stopped.";
  });
  // Esc also stops
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && sending) { ladder?.interrupt(); status.textContent = "Stopped."; }
  });

  // -- composer: auto-growing textarea, Enter sends, Shift+Enter newlines ---
  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      $("ai-composer").requestSubmit();
    }
  });

  // -- think mode: auto (router decides) / on / off -------------------------
  $("ai-think-select").value = thinkMode;
  $("ai-think-select").onchange = (ev) => {
    thinkMode = ev.target.value;
    localStorage.setItem("st-assistant-think", thinkMode);
    status.textContent = {
      auto: "Auto — a quick check decides per question whether to think.",
      on: "Thinking on — slower, better for strategy questions.",
      off: "Thinking off — fast answers for quick lookups.",
    }[thinkMode];
  };

  /** Fast pre-flight: no digest, no thinking, ~1–2s. Decides if the real
   *  answer is worth reasoning over. Defaults to thinking when unclear. */
  // Obvious cases are decided in JS — no extra inference, no extra GPU burst.
  const FAST_RE = /^(how many|how much|what is|what's|whats|when|who is|list|count|show me)\b|\b(characters?|words?|length|total|average|avg)\b/i;
  const THINK_RE = /\b(should|recommend|suggest|strategy|strategic|why|compare|comparison|better|best approach|improve|optimi[sz]e|plan|draft|write|rewrite|keyword field|which keywords)\b/i;

  async function shouldThink(question) {
    if (thinkMode === "on") return true;
    if (thinkMode === "off") return false;
    // JS fast path: decisive patterns skip the router call entirely
    const think = THINK_RE.test(question);
    const fast = FAST_RE.test(question);
    if (think !== fast) return think;
    try {
      const raw = await ladder.quick(
        [
          {
            role: "system",
            content: [
              'You route questions for an App Store data assistant. Reply with exactly one word: "fast" or "think".',
              '"fast" = simple lookups, single facts, counts, character/word counts, definitions, formatting requests.',
              '"think" = strategy, recommendations, trade-offs, comparisons across many items, or constrained deliverables like keyword lists.',
              "Examples:",
              '"how many ratings do we have in canada" -> fast',
              '"how many characters are in: apple" -> fast',
              '"what is pop" -> fast',
              '"which keywords should i target in france" -> think',
              '"why did our rank drop and what should we do" -> think',
            ].join("\n"),
          },
          { role: "user", content: `${question} /no_think` },
        ],
        24, // headroom: even with /no_think, Qwen3 emits an empty <think></think> shell first
      );
      // Strip the empty think shell before reading the verdict
      const p = new ThinkParser();
      const verdict = [...p.push(raw), ...p.flush()]
        .filter((c) => c.kind === "answer")
        .map((c) => c.text)
        .join("")
        .toLowerCase();
      if (verdict.includes("fast")) return false;
      if (verdict.includes("think")) return true;
      return true; // unparseable — err on the side of quality
    } catch {
      return true; // router failed — err on the side of quality
    }
  }

  // -- settings ------------------------------------------------------------
  function renderSettings() {
    const own = !!localStorage.getItem(TOKEN_KEY);
    const fallback = !own && !!localStorage.getItem("ghDispatchToken");
    $("ai-token-form").hidden = own || fallback;
    $("ai-token-connected").hidden = !(own || fallback);
    $("ai-token-source").textContent = fallback
      ? `Memory is on, reusing the dashboard's saved GitHub token — say "remember that …" in chat and it commits to ${REPO}. (Needs Contents read/write; add a dedicated token below if saves fail.)`
      : `Memory is on — say "remember that …" in chat and it commits to ${REPO}.`;
    $("ai-token-clear").hidden = fallback; // don't delete the dashboard's token from here
  }
  function renderEngine() {
    const eng = localStorage.getItem(ENGINE_KEY) || "device";
    $("ai-engine-select").value = eng;
    $("ai-engine-claude").hidden = eng !== "claude";
    $("ai-engine-device").hidden = eng === "claude";
  }
  $("ai-engine-select").onchange = (ev) => {
    localStorage.setItem(ENGINE_KEY, ev.target.value);
    renderEngine();
    status.textContent =
      ev.target.value === "claude" && !claudeKey.get()
        ? "Add your Claude API key below, then reload."
        : "Reload to apply the engine change.";
  };

  function renderClaudeState() {
    const has = !!claudeKey.get();
    $("ai-claude-state").textContent = has
      ? "Key saved — using Claude Opus 5. No local model is downloaded. Remove the key to fall back to the in-browser models."
      : "Stored only in this browser, like the GitHub token. With a key set, answers come from Claude Opus 5 and no local model is downloaded. Set a spend limit in the Anthropic console.";
    $("ai-claude-key").placeholder = has ? "key saved — paste a new one to replace" : "sk-ant-…";
  }
  renderEngine();
  renderClaudeState();
  $("ai-claude-save").onclick = () => {
    const v = $("ai-claude-key").value.trim();
    claudeKey.set(v);
    $("ai-claude-key").value = "";
    renderEngine();
  renderClaudeState();
    status.textContent = v
      ? "Claude key saved — reload to switch to Claude Opus 5."
      : "Claude key removed — reload to use the local model.";
  };

  $("ai-model-select").value = localStorage.getItem(MODEL_KEY) || "0.6b";
  $("ai-model-select").onchange = async (ev) => {
    const tier = ev.target.value;
    localStorage.setItem(MODEL_KEY, tier);
    $("ai-settings").hidden = true;
    await ladder?.switchTo(tier);
  };

  $("ai-gear").onclick = () => {
    const s = $("ai-settings");
    s.hidden = !s.hidden;
    if (!s.hidden) renderSettings();
  };
  $("ai-token-save").onclick = () => {
    memory.token = $("ai-token").value.trim();
    $("ai-token").value = "";
    $("ai-settings").hidden = true;
    if (memory.token) status.textContent = "Memory on — say \"remember that …\" in chat.";
  };
  $("ai-token-change").onclick = () => {
    $("ai-token-form").hidden = false;
    $("ai-token-connected").hidden = true;
  };
  $("ai-token-clear").onclick = () => {
    memory.token = "";
    renderSettings();
    status.textContent = "Memory token removed.";
  };

  // -- model lifecycle -----------------------------------------------------
  async function maybeAutoStart() {
    // If the small model is already cached (returning visit), start silently.
    const cached = await webllm
      .hasModelInCache(TIERS["0.6b"].f16, webllm.prebuiltAppConfig)
      .catch(() => false);
    if (cached || claudeKey.get()) void start();
  }

  $("ai-start-btn").onclick = () => void start();

  async function start() {
    if (starting) return;
    starting = true;
    $("ai-start-btn").disabled = true;
    badge.textContent = "loading";
    // A Claude key short-circuits the whole local-model path: no WebGPU,
    // no multi-GB download, and it works the same on a phone as on a desktop.
    if (engineOf() === "claude") {
      badge.textContent = "Claude Opus 5";
      ladder = new ClaudeBackend({
        onEvent: (e) => {
          if (e.type === "usage") {
            status.textContent =
              `${e.input.toLocaleString()} in / ${e.output.toLocaleString()} out · ` +
              `$${e.cost.toFixed(4)} this answer · $${e.sessionSpend.toFixed(3)} this session`;
          }
        },
      });
      try {
        digest = await buildDigest();
        memory.notes = digest.notes;
        $("ai-start")?.remove();
        input.disabled = send.disabled = false;
        input.focus();
      } catch (err) {
        status.textContent = `⚠ ${err.message ?? err}`;
      } finally {
        starting = false;
      }
      return;
    }

    ladder = new ModelLadder({
      pinnedTier: localStorage.getItem(MODEL_KEY) || "0.6b",
      onEvent: (e) => {
        if (e.type === "download-progress") {
          $("ai-progress").hidden = false;
          $("ai-progress-fill").style.width = `${Math.round(e.progress * 100)}%`;
          status.textContent = `[${e.tier}] ${e.text}`;
        } else if (e.type === "tier-active") {
          $("ai-progress").hidden = true;
          badge.textContent = `Qwen3 ${e.tier.toUpperCase()}`;
          status.textContent = "";
          if (e.tier === "8b") $("ai-upgrade-chip").hidden = true;
        } else if (e.type === "device-limited") {
          $("ai-upgrade-chip").hidden = false;
          $("ai-upgrade-chip").textContent = "Bigger model";
          status.textContent =
            "Running the small model — on a phone or tablet, larger models are opt-in (they need GBs of download and memory).";
        } else if (e.type === "upgrade-skipped") {
          // Data Saver is on — don't auto-download gigabytes; offer a chip instead.
          $("ai-upgrade-chip").hidden = false;
          status.textContent = "Data Saver is on — tap Get 8B to download the bigger model (~4.7 GB).";
        } else if (e.type === "gpu-info") {
          const g = e.info;
          const warn = [];
          if (g.fallback) warn.push("software fallback adapter (no real GPU acceleration)");
          if (!g.f16) warn.push("no shader-f16 (using the slower 32-bit build)");
          if (warn.length) {
            status.textContent = `⚠ ${warn.join("; ")} — this is why inference is slow.`;
          }
          console.info("[assistant] GPU:", g);
        } else if (e.type === "status") {
          status.textContent = e.message;
        }
      },
    });
    try {
      const [, d] = await Promise.all([ladder.init(), buildDigest()]);
      digest = d;
      memory.notes = d.notes;
      $("ai-start").remove();
      input.disabled = send.disabled = false;
      input.focus();
    } catch (err) {
      status.textContent = `⚠ ${err.message ?? err}`;
      badge.textContent = "off";
      $("ai-start-btn").disabled = false;
      ladder = null;
    } finally {
      starting = false;
    }
  }

  $("ai-upgrade-chip").onclick = () => {
    if (!ladder) return;
    $("ai-upgrade-chip").hidden = true;
    ladder.forceUpgrade();
  };

  // -- messages ------------------------------------------------------------
  function addUser(text) {
    const div = document.createElement("div");
    div.className = "ai-msg ai-user";
    div.textContent = text;
    msgs.appendChild(div);
    scroll();
  }

  function addNotice(text) {
    const div = document.createElement("div");
    div.className = "ai-msg ai-notice";
    div.textContent = text;
    msgs.appendChild(div);
    scroll();
  }

  function addAssistant() {
    const wrap = document.createElement("div");
    wrap.className = "ai-msg ai-assistant";
    wrap.innerHTML = `
      <details class="ai-think ai-think-live" open style="display:none">
        <summary>Thinking</summary><div class="ai-think-text"></div>
      </details>
      <div class="ai-copyline" hidden><code></code><button title="Copy just this line">Copy</button></div>
      <div class="ai-pending"><span></span><span></span><span></span></div>
      <div class="ai-bubble" hidden></div>
      <div class="ai-actions" hidden>
        <button class="ai-copy" title="Copy the whole answer">Copy answer</button>
      </div>`;
    msgs.appendChild(wrap);
    return {
      wrap,
      think: wrap.querySelector(".ai-think"),
      thinkText: wrap.querySelector(".ai-think-text"),
      bubble: wrap.querySelector(".ai-bubble"),
      pending: wrap.querySelector(".ai-pending"),
      copyline: wrap.querySelector(".ai-copyline"),
      actions: wrap.querySelector(".ai-actions"),
      copy: wrap.querySelector(".ai-copy"),
    };
  }

  function addGuardNote(wrap, applied, notes) {
    if (!applied.length && !notes.length) return;
    const el = document.createElement("div");
    el.className = "ai-guard";
    el.textContent =
      (applied.length ? "Auto-corrected: " + applied.join("; ") : "") +
      (applied.length && notes.length ? " · " : "") +
      (notes.length ? "Check: " + notes.map((n) => n.detail).join("; ") : "");
    wrap.appendChild(el);
  }

  /** Collapse a live thinking box into its finished state. Always called when
   *  a stream ends, so a pulsing "Thinking" can never outlive the generation. */
  function collapseThink(ui, thinkAcc, label) {
    if (!ui.think?.isConnected) return;
    if (!thinkAcc.trim()) { ui.think.remove(); return; }
    ui.think.classList.remove("ai-think-live");
    ui.think.open = false;
    ui.think.querySelector("summary").textContent = label;
  }

  /**
   * Stream one generation into `ui`. Returns what was produced so the caller
   * can tell an empty answer (truncated while thinking) from a real one.
   */
  async function streamInto(ui, req, maxTokens, isRetry = false) {
    let thinkAcc = "", answerAcc = "";
    let firstTokenAt = 0;
    const tStart = performance.now();
    let painting = false;
    const paint = () => {
      if (painting) return;
      painting = true;
      requestAnimationFrame(() => {
        painting = false;
        if (thinkAcc.trim() && ui.think?.isConnected) ui.thinkText.textContent = thinkAcc;
        if (answerAcc) ui.bubble.textContent = answerAcc;
        scroll();
      });
    };

    // Live counter: a long think should look busy, not hung.
    const t0 = performance.now();
    const ticker = setInterval(() => {
      if (answerAcc || !ui.think?.isConnected) return;
      const s = Math.round((performance.now() - t0) / 1000);
      const sum = ui.think.querySelector("summary");
      if (sum) sum.textContent = `Thinking… ${s}s`;
    }, 1000);

    try {
      for await (const chunk of ladder.chat(req, maxTokens)) {
        if (!firstTokenAt) firstTokenAt = performance.now();
        ui.pending?.remove();
        if (chunk.kind === "think") {
          thinkAcc += chunk.text;
          if (thinkAcc.trim() && !isRetry) ui.think.style.display = "block";
        } else {
          if (answerAcc === "") {
            collapseThink(ui, thinkAcc, "Thought — tap to expand");
            ui.bubble.hidden = false;
          }
          answerAcc += answerAcc === "" ? chunk.text.replace(/^\s+/, "") : chunk.text;
        }
        paint();
      }
    } finally {
      clearInterval(ticker);
      // Final flush; the last frame may not have painted the tail.
      if (thinkAcc.trim() && ui.think?.isConnected) ui.thinkText.textContent = thinkAcc;
      if (answerAcc) ui.bubble.textContent = answerAcc;
      // Never leave a pulsing box behind, whatever ended the stream.
      if (answerAcc) collapseThink(ui, thinkAcc, "Thought — tap to expand");
      ui.pending?.remove();
      scroll();
    }
    return { thinkAcc, answerAcc, ttft: firstTokenAt ? firstTokenAt - tStart : 0, total: performance.now() - tStart };
  }

  function flashLabel(btn, label) {
    const prev = btn.textContent;
    btn.textContent = label;
    setTimeout(() => (btn.textContent = prev), 1200);
  }

  /** If the answer leads with a comma-separated deliverable (e.g. a keyword
   *  field), lift it into its own block with a one-tap copy. */
  function finalizeAssistant(ui, answer) {
    const firstLine = answer.split("\n")[0].trim();
    const isCommaList = firstLine.length <= 140 && (firstLine.match(/,/g) ?? []).length >= 2;
    if (isCommaList) {
      ui.copyline.hidden = false;
      ui.copyline.querySelector("code").textContent = firstLine;
      ui.copyline.querySelector("button").onclick = (ev) => {
        navigator.clipboard.writeText(firstLine);
        flashLabel(ev.target, "Copied ✓");
      };
      ui.bubble.textContent = answer.slice(answer.indexOf("\n") + 1).trim();
      if (!ui.bubble.textContent) ui.bubble.remove();
    }
    ui.actions.hidden = false;
    ui.copy.onclick = () => {
      navigator.clipboard.writeText(answer);
      flashLabel(ui.copy, "Copied ✓");
    };
  }

  // -- chat-driven memory ---------------------------------------------------
  async function handleRemember(text) {
    // "remember that CA launch was July" carries its own content; a bare
    // "remember this" refers to the last exchange.
    const stripped = text.replace(REMEMBER_STRIP_RE, "").trim();
    let note;
    if (stripped.length >= 12) {
      note = stripped;
    } else {
      const lastA = [...history].reverse().find((m) => m.role === "assistant");
      const lastQ = [...history].reverse().find((m) => m.role === "user");
      if (!lastA) { addNotice("Nothing to remember yet — ask something first."); return; }
      note = `Q: ${lastQ?.content ?? ""} → ${lastA.content.slice(0, 280)}`;
    }
    if (!memory.token) {
      $("ai-settings").hidden = false;
      renderSettings();
      addNotice("Memory saves to GitHub — add a fine-grained token above to enable it.");
      return;
    }
    addNotice("Saving to GitHub…");
    try {
      await memory.save(note);
      digest.base += `\n[saved] ${note}`; // visible to the model this session
      history.push(
        { role: "user", content: text },
        { role: "assistant", content: `Saved to memory: ${note}` },
      );
      addNotice(`✓ Saved to GitHub (${REPO}): "${note.slice(0, 120)}${note.length > 120 ? "…" : ""}"`);
    } catch (err) {
      addNotice(`⚠ Couldn't save to GitHub: ${err.message ?? err}`);
    }
  }

  $("ai-composer").onsubmit = async (ev) => {
    ev.preventDefault();
    if (sending) return; // Stop is handled by the click listener
    const text = input.value.trim();
    if (!text || !ladder) return;
    input.value = "";
    autosize();

    // Memory commands never go to the model — deterministic on every tier.
    if (REMEMBER_RE.test(text)) {
      addUser(text);
      await handleRemember(text);
      input.focus();
      return;
    }

    input.disabled = true;
    setSending(true);
    addUser(text);
    if (thinkMode === "auto") status.textContent = "Deciding whether to think…";
    const useThink = await shouldThink(text);
    if (thinkMode === "auto") {
      status.textContent = useThink ? "Worth thinking about — reasoning first." : "Quick one — answering directly.";
    }
    // The /no_think suffix is Qwen3's soft switch — sent to the model, never shown
    history.push({ role: "user", content: useThink ? text : `${text} /no_think` });

    const ui = addAssistant();
    const tSend = performance.now();
    let tFirst = 0;
    let answerAcc = "";
    try {
      const sys = {
        role: "system",
        content: systemPrompt(digest.base, contextFor(text, digest.data), { aso: INTENT.strategy.test(text) }),
      };
      // Thinking needs far more room than a direct answer. Too small a budget
      // and the model burns the whole allowance reasoning, never reaching an
      // answer — which used to leave the panel stuck on a live "Thinking" box.
      let res;
      try {
        res = await streamInto(ui, [sys, ...history.slice(-HISTORY_CAP)], useThink ? 2600 : 900);
      } catch (err) {
        if (engineOf() !== "claude" || !isTransient(err)) throw err;
        ladder = await ensureLocalBackup();
        addNotice(`Claude unavailable (${err.message ?? err}) — answered with the on-device model.`);
        res = await streamInto(ui, [sys, ...history.slice(-HISTORY_CAP)], useThink ? 2600 : 900);
      }
      answerAcc = res.answerAcc;

      // Truncated inside <think>: no answer was ever produced. Say so, then
      // retry once with thinking off so the user still gets a result.
      if (!answerAcc && res.thinkAcc.trim()) {
        collapseThink(ui, res.thinkAcc, "Ran out of room while thinking — tap to read");
        addGuardNote(ui.wrap, ["thinking used the whole token budget without reaching an answer; retried with thinking off"], []);
        status.textContent = "Retrying without thinking…";
        history[history.length - 1] = { role: "user", content: `${text} /no_think` };
        ui.pending = document.createElement("div");
        ui.pending.className = "ai-pending";
        ui.pending.innerHTML = "<span></span><span></span><span></span>";
        ui.wrap.insertBefore(ui.pending, ui.bubble);
        res = await streamInto(ui, [sys, ...history.slice(-HISTORY_CAP)], 900, true);
        answerAcc = res.answerAcc;
      }

      if (!answerAcc) {
        ui.bubble.hidden = false;
        ui.bubble.textContent = "No answer was produced. Try rephrasing, or set Think: off for a direct answer.";
      }

      // -- output guards: validate, repair, disclose ---------------------
      const cc = detectCountry(text, digest.data);
      const guards = planGuards(text, digest.data, cc, memory.notes);
      if (answerAcc && guards.length) {
        const violations = checkAnswer(answerAcc, guards, digest.data);
        if (violations.length) {
          const rep = repairAnswer(answerAcc, violations, digest.data, cc, blockedWords(memory.notes));
          answerAcc = rep.answer;
          ui.bubble.textContent = answerAcc;
          addGuardNote(ui.wrap, rep.applied, rep.notes);
        }
      }
      history.push({ role: "assistant", content: answerAcc });
      finalizeAssistant(ui, answerAcc);
      if (res?.ttft) {
        const tps = res.total > res.ttft ? Math.round((answerAcc.length / 4) / ((res.total - res.ttft) / 1000)) : 0;
        status.textContent =
          `${(res.ttft / 1000).toFixed(1)}s to first token (prefill)` +
          (tps ? ` · ~${tps} tok/s · ${(res.total / 1000).toFixed(1)}s total` : "");
      }
    } catch (err) {
      ui.pending.remove();
      ui.bubble.hidden = false;
      ui.bubble.textContent = `⚠ ${err.message ?? err}`;
    } finally {
      input.disabled = false;
      setSending(false);
      input.focus();
    }
  };
}

if ("gpu" in navigator) setup();
// No WebGPU → no button at all; the dashboard is untouched.
