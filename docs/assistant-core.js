/**
 * assistant-core.js — shared engine, prompt, and data digest for the
 * dashboard assistant AND the evals runner (evals.html). Keeping these in
 * one module means evals always test exactly what production runs.
 *
 * Runs Qwen3 locally via WebLLM (WebGPU): nothing leaves the machine, no
 * server, no inference cost. A model ladder keeps time-to-first-answer low:
 *   0.6B → starts fast, kept forever as fallback
 *   4B   → inserted only when the connection is slow
 *   8B   → offered after engagement; 4B cache deleted once 8B is stable
 *
 * The system prompt is a digest of the same JSON the dashboard renders
 * (latest.json, keywords.json, reviews.json) plus saved learnings from
 * data/assistant-memory.json. Learnings are committed back to the repo via
 * the GitHub contents API using a fine-grained PAT that the owner pastes
 * into the panel once (stored in localStorage — NEVER in this repo).
 *
 * Desktop: docked right panel. Mobile: full-screen overlay.
 */

import * as webllm from "https://esm.run/@mlc-ai/web-llm";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const TIERS = {
  "0.6b": { f16: "Qwen3-0.6B-q4f16_1-MLC", f32: "Qwen3-0.6B-q4f32_1-MLC", downloadMB: 450,  vramMB: 1403 },
  "4b":   { f16: "Qwen3-4B-q4f16_1-MLC",   f32: "Qwen3-4B-q4f32_1-MLC",   downloadMB: 2400, vramMB: 3432 },
  "8b":   { f16: "Qwen3-8B-q4f16_1-MLC",   f32: "Qwen3-8B-q4f32_1-MLC",   downloadMB: 4700, vramMB: 5696 },
};

/** Phones and tablets: small VRAM budgets, aggressive tab eviction, metered
 *  connections, and background suspension that kills long downloads. */
export function isHandheld() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPod|Android.*Mobile/i.test(ua)) return true;
  // iPadOS reports a desktop UA; touch + no fine pointer is the reliable tell.
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return matchMedia?.("(pointer: coarse)")?.matches === true && Math.min(screen.width, screen.height) < 900;
}
const INSERT_4B_THRESHOLD_MS = 8 * 60 * 1000;

// ---------------------------------------------------------------------------
// ThinkParser — split the token stream into thinking vs answer chunks,
// tolerant of <think>/</think> tags split across streamed deltas.
// ---------------------------------------------------------------------------

const OPEN = "<think>";
const CLOSE = "</think>";

export class ThinkParser {
  constructor() { this.state = "detect"; this.buf = ""; }
  push(delta) {
    this.buf += delta;
    const out = [];
    if (this.state === "detect") {
      const lead = this.buf.replace(/^\s+/, "");
      if (lead.startsWith(OPEN)) { this.state = "think"; this.buf = lead.slice(OPEN.length); }
      else if (lead.length === 0 || OPEN.startsWith(lead)) return out;
      else this.state = "answer";
    }
    if (this.state === "think") {
      const idx = this.buf.indexOf(CLOSE);
      if (idx >= 0) {
        if (idx > 0) out.push({ kind: "think", text: this.buf.slice(0, idx) });
        this.buf = this.buf.slice(idx + CLOSE.length).replace(/^\s+/, "");
        this.state = "answer";
      } else {
        const safe = this.buf.length - (CLOSE.length - 1);
        if (safe > 0) { out.push({ kind: "think", text: this.buf.slice(0, safe) }); this.buf = this.buf.slice(safe); }
        return out;
      }
    }
    if (this.state === "answer" && this.buf) { out.push({ kind: "answer", text: this.buf }); this.buf = ""; }
    return out;
  }
  flush() {
    const rest = this.buf; this.buf = "";
    return rest ? [{ kind: this.state === "think" ? "think" : "answer", text: rest }] : [];
  }
}

// ---------------------------------------------------------------------------
// ModelLadder (worker engines)
// ---------------------------------------------------------------------------

export class ModelLadder {
  constructor(opts = {}) {
    this.opts = opts;
    this.engine = null;
    this.worker = null;
    this.activeTier = null;
    this.useF16 = true;
    this.appConfig = webllm.prebuiltAppConfig;
    this.upgradeStarted = false;
    this.pendingApproval = null;
    this.measuredMBps = null;
    this.busy = Promise.resolve();
    this.releaseBusy = null;
    this.generating = false;
    this.lastActivity = 0;
    // Set before init() so the auto-upgrade chain never races a saved choice.
    this.pinnedTier = opts.pinnedTier ?? null;
  }
  emit(e) { this.opts.onEvent?.(e); }
  modelId(tier) { return this.useF16 ? TIERS[tier].f16 : TIERS[tier].f32; }
  spawnWorker() { return new Worker(new URL("./assistant-worker.js", import.meta.url), { type: "module" }); }

  async init() {
    if (!("gpu" in navigator)) throw new Error("This browser has no WebGPU — the assistant needs Chrome, Edge, or Safari 18+.");
    // Without an explicit preference some browsers hand back the low-power
    // integrated GPU, which is a common cause of single-digit tokens/sec.
    const adapter =
      (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ||
      (await navigator.gpu.requestAdapter());
    if (!adapter) throw new Error("No WebGPU adapter available on this device.");
    this.useF16 = adapter.features.has("shader-f16");

    // Surface what we're actually running on — a software/fallback adapter or
    // a missing shader-f16 both explain order-of-magnitude slow inference.
    let info = {};
    try { info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {}; } catch {}
    this.gpuInfo = {
      vendor: info.vendor || "unknown",
      architecture: info.architecture || "",
      device: info.device || "",
      description: info.description || "",
      f16: this.useF16,
      fallback: adapter.isFallbackAdapter === true,
      maxBufferMB: Math.round((adapter.limits?.maxBufferSize ?? 0) / 1e6),
      maxStorageMB: Math.round((adapter.limits?.maxStorageBufferBindingSize ?? 0) / 1e6),
    };
    console.info("[assistant] WebGPU adapter:", this.gpuInfo);
    this.emit({ type: "gpu-info", info: this.gpuInfo });
    try { await navigator.storage.persist?.(); } catch {}

    await this.loadFirst("0.6b");

    // Handhelds: stay on the small model. Anything larger risks Safari killing
    // the tab, and a multi-GB pull may be on cellular or get suspended.
    if (!this.pinnedTier && isHandheld()) {
      this.upgradeStarted = true;
      this.pinnedTier = "0.6b";
      this.emit({
        type: "device-limited",
        tier: "0.6b",
        reason: "phone or tablet — larger models are opt-in here to protect memory and data",
      });
      return;
    }

    // A saved model choice wins outright: no auto-upgrade chain, no promotion.
    if (this.pinnedTier) {
      this.upgradeStarted = true;
      if (this.pinnedTier !== "0.6b") void this.switchTo(this.pinnedTier);
      return;
    }

    const cached8b = await webllm.hasModelInCache(this.modelId("8b"), this.appConfig).catch(() => false);
    if (cached8b) {
      this.upgradeStarted = true;
      void this.backgroundUpgrade("8b");
    } else {
      this.autoUpgrade();
    }
  }

  /** Start the big download automatically once the small model is serving.
   *  Only Data Saver mode opts out (explicit user signal — offer a chip instead). */
  autoUpgrade() {
    if (this.upgradeStarted) return;
    if (navigator.connection?.saveData) {
      this.emit({ type: "upgrade-skipped", reason: "data-saver" });
      return;
    }
    this.upgradeStarted = true;
    const tier = this.pickNextTier();
    this.emit({
      type: "status",
      message:
        tier === "4b"
          ? "Slower connection — fetching a mid-size model first, then the full 8B, in the background."
          : "Downloading the bigger 8B model in the background — answers will improve once it's ready.",
    });
    void this.runChain(tier);
  }

  progressCallback(tier) {
    let firstFetch = null;
    return (report) => {
      if (report.text.toLowerCase().includes("fetch")) {
        firstFetch ??= performance.now();
        const s = (performance.now() - firstFetch) / 1000;
        if (s > 5 && report.progress > 0.02) this.measuredMBps = (TIERS[tier].downloadMB * report.progress) / s;
      }
      this.emit({ type: "download-progress", tier, progress: report.progress, text: report.text });
    };
  }

  async loadFirst(tier) {
    const worker = this.spawnWorker();
    this.engine = await webllm.CreateWebWorkerMLCEngine(worker, this.modelId(tier), {
      appConfig: this.appConfig,
      initProgressCallback: this.progressCallback(tier),
    });
    this.worker = worker;
    this.activeTier = tier;
    this.emit({ type: "tier-active", tier });
  }

  /**
   * Switch the standing model on demand. Pinning stops the auto-upgrade chain
   * from promoting past the user's choice — picking 4B for speed should not be
   * silently undone by the background 8B download finishing.
   */
  async switchTo(tier) {
    this.pinnedTier = tier;
    if (this.activeTier === tier) return;
    await this.acquire();
    try {
      this.emit({ type: "status", message: `Switching to ${tier}…` });
      await this.engine.reload(this.modelId(tier));
      this.activeTier = tier;
      this.emit({ type: "tier-active", tier });
    } catch (err) {
      this.emit({ type: "status", message: `Could not switch to ${tier}: ${err.message ?? err}` });
    } finally {
      this.release();
    }
  }

  /** Rough check: will this tier's weights fit the adapter's buffer limits? */
  fitsTier(tier) {
    const need = TIERS[tier]?.vramMB ?? 0;
    const cap = this.gpuInfo?.maxStorageMB || this.gpuInfo?.maxBufferMB || 0;
    return !cap || need <= cap * 4; // weights are split across buffers; 4x is a practical allowance
  }

  /** Manual trigger — used only when Data Saver suppressed the auto-download. */
  forceUpgrade() {
    if (this.upgradeStarted) return;
    this.upgradeStarted = true;
    void this.runChain(this.pickNextTier());
  }

  async runChain(tier) {
    if (tier === "4b") {
      await this.backgroundUpgrade("4b");
      await this.backgroundUpgrade("8b");
      await webllm.deleteModelAllInfoInCache(this.modelId("4b"), this.appConfig).catch(() => {});
    } else {
      await this.backgroundUpgrade("8b");
    }
  }

  pickNextTier() {
    if (this.measuredMBps > 0) {
      const etaMs = (TIERS["8b"].downloadMB / this.measuredMBps) * 1000;
      if (etaMs > INSERT_4B_THRESHOLD_MS) return "4b";
    }
    return "8b";
  }

  /** Resolves once no generation has run for `quietMs`. Loading a model's
   *  weights into VRAM while the GPU is decoding starves the compositor and
   *  freezes the whole desktop, so the big download waits for a quiet gap. */
  async waitForIdle(quietMs = 1500) {
    for (;;) {
      await this.busy.catch(() => {});
      const since = performance.now() - this.lastActivity;
      if (!this.generating && since >= quietMs) return;
      await new Promise((r) => setTimeout(r, Math.max(200, quietMs - since)));
    }
  }

  async backgroundUpgrade(tier) {
    if (this.pinnedTier && this.pinnedTier !== tier) return; // user chose a tier; respect it
    let candidate = null, candidateWorker = null;
    try {
      await this.waitForIdle(); // never load weights mid-answer
      candidateWorker = this.spawnWorker();
      candidate = await webllm.CreateWebWorkerMLCEngine(candidateWorker, this.modelId(tier), {
        appConfig: this.appConfig,
        initProgressCallback: this.progressCallback(tier),
      });
      await this.smokeTest(candidate);
    } catch {
      try { await candidate?.unload(); } catch {}
      candidateWorker?.terminate();
      const swapped = await this.swapTimeUpgrade(tier).catch(() => false);
      if (!swapped) this.emit({ type: "status", message: `${tier} model can't run on this device — staying on ${this.activeTier}.` });
      return;
    }
    await this.acquire();
    try {
      const oldEngine = this.engine, oldWorker = this.worker;
      this.engine = candidate; this.worker = candidateWorker; this.activeTier = tier;
      try { await oldEngine?.unload(); } catch {}
      oldWorker?.terminate();
      this.emit({ type: "tier-active", tier });
    } finally { this.release(); }
  }

  async swapTimeUpgrade(tier) {
    await this.acquire();
    const prev = this.activeTier;
    try {
      await this.engine.reload(this.modelId(tier));
      await this.smokeTest(this.engine);
      this.activeTier = tier;
      this.emit({ type: "tier-active", tier });
      return true;
    } catch {
      await this.engine.reload(this.modelId(prev)).catch(() => {});
      return false;
    } finally { this.release(); }
  }

  async smokeTest(engine) {
    const r = await engine.chat.completions.create({
      messages: [{ role: "user", content: "Say OK. /no_think" }],
      max_tokens: 8,
    });
    if (!r.choices?.[0]?.message) throw new Error("smoke-test-failed");
  }

  /** Small non-streaming call — used by the thinking router. */
  async quick(messages, max_tokens = 8) {
    await this.acquire();
    try {
      const r = await this.engine.chat.completions.create({ messages, max_tokens, stream: false });
      return r.choices?.[0]?.message?.content ?? "";
    } finally {
      this.release();
    }
  }

  /** Stop the in-flight generation. The stream ends after the current token,
   *  so the GPU frees up within ~1 token rather than finishing the answer. */
  interrupt() {
    try { this.engine?.interruptGenerate?.(); } catch {}
  }

  async *chat(messages, maxTokens = 1024) {
    await this.acquire();
    try {
      const parser = new ThinkParser();
      const chunks = await this.engine.chat.completions.create({ messages, stream: true, max_tokens: maxTokens });
      for await (const c of chunks) {
        const d = c.choices[0]?.delta?.content;
        if (d) yield* parser.push(d);
      }
      yield* parser.flush();
    } finally { this.release(); }
  }

  async acquire() {
    const prev = this.busy;
    this.busy = new Promise((r) => (this.releaseBusy = r));
    await prev;
    this.generating = true;
  }

  release() {
    this.generating = false;
    this.lastActivity = performance.now();
    this.releaseBusy?.();
    this.releaseBusy = null;
  }
}

// ---------------------------------------------------------------------------
// Data layer — loads the same JSON the dashboard renders, then serves the
// model two things:
//   baseDigest()  — always-on summary (totals, headline keywords, competitors)
//   contextFor()  — per-question retrieval: sorts/filters the FULL data in JS
//                   and injects only the slices that question needs.
// Sorting and filtering happen here, not in the model: exact, instant, and
// identical on the 0.6B and the 8B (small models can't do reliable tool calls).
// ---------------------------------------------------------------------------

const COUNTRY_WORDS = {
  us: /\b(us|usa|u\.s\.|america|american|united states)\b/i,
  ca: /\b(ca|canada|canadian)\b/i,
  gb: /\b(gb|uk|u\.k\.|britain|british|england|united kingdom)\b/i,
  au: /\b(au|australia|australian|aussie)\b/i,
  fr: /\b(fr|france|french)\b/i,
  es: /\b(es|spain|spanish)\b/i,
  mx: /\b(mx|mexico|mexican)\b/i,
  de: /\b(de|germany|german)\b/i,
  jp: /\b(jp|japan|japanese)\b/i,
  cn: /\b(cn|china|chinese)\b/i,
};
const CC_NAME = {
  us: "United States", ca: "Canada", gb: "United Kingdom", au: "Australia",
  fr: "France", es: "Spain", mx: "Mexico", de: "Germany", jp: "Japan", cn: "China",
};

const INTENT = {
  reviews: /\b(review|reviews|feedback|complain|complaint|users? say|sentiment|rating text)\b/i,
  competitors: /\b(competitor|competitors|rival|compet\w*|who else|versus|vs\.?|market share|owns)\b/i,
  history: /\b(history|trend|trending|over time|growth|last month|30[- ]day|past week|day by day|daily)\b/i,
  movers: /\b(mover|moved|move|drop|dropped|fell|falling|gain|gained|rose|rising|improv\w*|declin\w*|change[sd]?)\b/i,
  worst: /\b(worst|weak|weakest|lowest|bad|poor|struggling|losing|behind)\b/i,
  strategy: /\b(keyword|keywords|aso|target|targeting|listing|metadata|subtitle|title|rank for|optimi[sz]e|strategy|prioriti[sz]e|focus on|should we|worth it)\b/i,
};

const kwLine = (kw, v) => `${kw} rank ${v.rank ?? "unranked"}, popularity ${v.pop ?? 0}`;

/** Which storefront is this question about? Shared by retrieval and guards. */
export function detectCountry(question, data) {
  const ccs = Object.keys(COUNTRY_WORDS).filter((cc) => COUNTRY_WORDS[cc].test(String(question)));
  return ccs.find((c) => data?.keywords?.latest?.[c]) ?? null;
}

export { INTENT, CC_NAME };

/** Rank movement across the stored `recent` samples: [[idx, rank, pop], …] */
function movement(v) {
  const pts = (v.recent ?? []).filter((p) => p[1] != null);
  if (pts.length < 2) return null;
  const first = pts[0][1], last = pts[pts.length - 1][1];
  return { first, last, delta: first - last }; // positive = improved
}

// ---------------------------------------------------------------------------

let cached = null;

export async function loadData() {
  if (cached) return cached;
  const get = (p) => fetch(`data/${p}`, { cache: "no-cache" }).then((r) => r.json()).catch(() => null);
  const [latest, keywords, reviews, history, memory] = await Promise.all([
    get("latest.json"), get("keywords.json"), get("reviews.json"),
    get("history.json"), get("assistant-memory.json"),
  ]);
  cached = { latest, keywords, reviews, history, memory };
  return cached;
}

/** Apps ranked by how many tracked keywords they hold a top-10 slot for —
 *  the same "who owns these keywords" signal the dashboard shows. */
function competitorShare(keywords, cc = "us", limit = 6) {
  const kws = keywords?.latest?.[cc];
  if (!kws) return [];
  const counts = {};
  let total = 0;
  for (const v of Object.values(kws)) {
    if (!Array.isArray(v.top)) continue;
    total++;
    v.top.slice(0, 10).forEach((id) => (counts[id] = (counts[id] || 0) + 1));
  }
  return Object.entries(counts)
    .map(([id, n]) => ({ id, n, total, name: keywords.apps?.[id]?.name, stats: keywords.stats?.[cc]?.[id] }))
    .filter((r) => r.name && !/snore timeline/i.test(r.name))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------

export function baseDigest(d) {
  const lines = [];
  const { latest, keywords, reviews, memory } = d;

  // Kept deliberately small: every token here is re-processed on EVERY question,
  // and prefill is the single biggest GPU burst. Detail comes from contextFor().
  if (latest?.countries) {
    const entries = Object.entries(latest.countries).filter(([, v]) => v.count > 0);
    const total = entries.reduce((s, [, v]) => s + v.count, 0);
    const wavg = entries.reduce((s, [, v]) => s + v.avg * v.count, 0) / (total || 1);
    lines.push(`RATINGS (${latest.fetchedAt?.slice(0, 10)}): ${total} total, ${entries.length} countries with ratings, weighted avg ${wavg.toFixed(2)}.`);
    const top = entries.sort((a, b) => b[1].count - a[1].count).slice(0, 6);
    lines.push("Biggest storefronts: " + top.map(([cc, v]) => `${cc.toUpperCase()} ${v.count}@${v.avg.toFixed(2)}`).join(", "));
  }

  // Counts only — the model needs to know what exists, not every value.
  if (keywords?.latest) {
    const counts = Object.entries(keywords.latest)
      .map(([cc, kws]) => `${cc.toUpperCase()} ${Object.keys(kws).length}`)
      .join(", ");
    lines.push(`KEYWORDS TRACKED per country (r=rank, lower better; pop=popularity 5-100, where 5 means no measurable search demand): ${counts}. Exact values are supplied per question when relevant.`);
  }

  if (Array.isArray(reviews) && reviews.length) {
    lines.push(`REVIEWS: ${reviews.length} tracked. Newest: ` +
      [...reviews].sort((a, b) => new Date(b.firstSeen ?? b.date) - new Date(a.firstSeen ?? a.date))
        .slice(0, 2)
        .map((r) => `${r.rating}\u2605 ${r.cc?.toUpperCase()} "${r.title}"`).join(", "));
  }

  const notes = memory?.notes ?? [];
  if (notes.length) {
    lines.push("SAVED LEARNINGS: " + notes.slice(-8).map((n) => n.text).join(" | "));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-question retrieval
// ---------------------------------------------------------------------------

/**
 * Reads the question, pulls the matching slices out of the full dataset,
 * sorted and filtered so the model gets ranked facts rather than raw JSON.
 * Returns "" when nothing specific matched (base digest already covers it).
 */
export function contextFor(question, d) {
  if (!question || !d) return "";
  const q = String(question);
  const out = [];
  const { keywords, latest, reviews, history } = d;

  // --- which country is this about? -------------------------------------
  const ccs = Object.keys(COUNTRY_WORDS).filter((cc) => COUNTRY_WORDS[cc].test(q));
  const cc = ccs.find((c) => keywords?.latest?.[c]) ?? null;

  if (cc && keywords?.latest?.[cc]) {
    const rows = Object.entries(keywords.latest[cc])
      .map(([kw, v]) => ({ kw, v, pop: v.pop ?? 0, rank: v.rank ?? 999 }))
      .sort((a, b) => b.pop - a.pop || a.rank - b.rank);
    const shown = rows.slice(0, 30);
    out.push(
      `KEYWORD TABLE — ${CC_NAME[cc]} (${rows.length} tracked, top ${shown.length} by search popularity):\n` +
        shown.map((r) => kwLine(r.kw, r.v)).join(", "),
    );
    const cRating = latest?.countries?.[cc];
    if (cRating) out.push(`${CC_NAME[cc]} ratings: ${cRating.count} total, avg ${cRating.avg?.toFixed?.(2) ?? cRating.avg}.`);
  }

  // --- did they name a specific keyword? ---------------------------------
  const pool = keywords?.latest?.[cc ?? "us"] ?? {};
  const named = Object.keys(pool)
    .filter((kw) => kw.length >= 5 && q.toLowerCase().includes(kw.toLowerCase()))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  for (const kw of named) {
    const v = pool[kw];
    const mv = movement(v);
    const owners = (v.top ?? []).slice(0, 5).map((id) => keywords.apps?.[id]?.name).filter(Boolean);
    out.push(
      `KEYWORD DETAIL "${kw}" (${(cc ?? "us").toUpperCase()}): rank ${v.rank ?? "not in top 200"}, popularity ${v.pop ?? "?"}` +
        (mv ? `, moved ${mv.first} -> ${mv.last} over the stored window (${mv.delta > 0 ? "+" : ""}${mv.delta})` : "") +
        (owners.length ? `. Top apps ranking for it: ${owners.join(", ")}` : ""),
    );
  }

  // --- playbook buckets: apply the qualification matrix to live data -----
  if (INTENT.strategy.test(q)) {
    const src = keywords?.latest?.[cc ?? "us"] ?? {};
    const rows = Object.entries(src).map(([kw, v]) => ({ kw, v, pop: v.pop ?? 0, rank: v.rank ?? null }));
    const fmt = (list) => list.map((r) => kwLine(r.kw, r.v)).join(", ");
    const byPop = (a, b) => b.pop - a.pop;

    const defend = rows.filter((r) => r.pop >= 40 && r.rank != null && r.rank <= 10).sort(byPop);
    const push = rows.filter((r) => r.pop >= 50 && r.rank != null && r.rank > 10 && r.rank <= 60).sort(byPop);
    const aspire = rows.filter((r) => r.pop >= 60 && (r.rank == null || r.rank > 60)).sort(byPop);
    const vanity = rows.filter((r) => r.pop <= 5 && r.rank != null && r.rank <= 10);

    const blocks = [];
    if (push.length) blocks.push(`PUSH (best ROI — high popularity, rank 11-60, reachable with metadata alone): ${fmt(push.slice(0, 10))}`);
    if (defend.length) blocks.push(`DEFEND (already top 10 — usually earned by the title, don't spend keyword-field chars here): ${fmt(defend.slice(0, 10))}`);
    if (aspire.length) blocks.push(`ASPIRATIONAL (high demand, rank 61+/unranked — needs rating velocity; check relevance before targeting): ${fmt(aspire.slice(0, 8))}`);
    if (vanity.length) blocks.push(`VANITY (popularity 5, the noise floor, ranked top 10 — worth nothing, never defend): ${fmt(vanity.slice(0, 6))}`);
    if (blocks.length) {
      out.push(`PLAYBOOK BUCKETS — ${CC_NAME[cc ?? "us"]} (already scored against the qualification matrix):\n` + blocks.join("\n"));
    }
  }

  // --- rank movers -------------------------------------------------------
  if (INTENT.movers.test(q) || INTENT.worst.test(q)) {
    const src = keywords?.latest?.[cc ?? "us"] ?? {};
    const moved = Object.entries(src)
      .map(([kw, v]) => ({ kw, v, mv: movement(v) }))
      .filter((r) => r.mv && r.mv.delta !== 0)
      .sort((a, b) => Math.abs(b.mv.delta) - Math.abs(a.mv.delta))
      .slice(0, 8)
      .map((r) => `${r.kw} ${r.mv.first}->${r.mv.last} (${r.mv.delta > 0 ? "+" : ""}${r.mv.delta}, p${r.v.pop ?? 0})`);
    if (moved.length) out.push(`BIGGEST RANK MOVES — ${CC_NAME[cc ?? "us"]} (positive = improved): ` + moved.join("; "));
  }

  // --- weakest high-demand keywords (growth headroom) --------------------
  if (INTENT.worst.test(q)) {
    const src = keywords?.latest?.[cc ?? "us"] ?? {};
    const weak = Object.entries(src)
      .map(([kw, v]) => ({ kw, v, pop: v.pop ?? 0, rank: v.rank ?? 999 }))
      .filter((r) => r.pop >= 50 && r.rank > 20)
      .sort((a, b) => b.pop - a.pop)
      .slice(0, 8)
      .map((r) => kwLine(r.kw, r.v));
    if (weak.length) out.push(`HIGH-DEMAND KEYWORDS WE RANK POORLY ON — ${CC_NAME[cc ?? "us"]} (growth headroom): ` + weak.join(", "));
  }

  // --- reviews -----------------------------------------------------------
  if (INTENT.reviews.test(q) && Array.isArray(reviews)) {
    const pick = cc ? reviews.filter((r) => r.cc === cc) : reviews;
    const sorted = [...pick].sort((a, b) => new Date(b.firstSeen ?? b.date) - new Date(a.firstSeen ?? a.date));
    const low = [...pick].filter((r) => r.rating <= 3).slice(0, 3);
    if (sorted.length) {
      out.push(
        `REVIEWS${cc ? ` — ${CC_NAME[cc]}` : ""} (${pick.length} matching, newest first):\n` +
          sorted.slice(0, 8).map((r) => `${r.rating}★ ${r.cc?.toUpperCase()} ${r.date?.slice(0, 10)} "${r.title}": ${String(r.body ?? "").slice(0, 180)}`).join("\n"),
      );
    }
    if (low.length) {
      out.push("CRITICAL REVIEWS (3★ or lower): " + low.map((r) => `${r.rating}★ "${r.title}": ${String(r.body ?? "").slice(0, 160)}`).join(" | "));
    }
  }

  // --- competitors -------------------------------------------------------
  if (INTENT.competitors.test(q)) {
    const comp = competitorShare(keywords, cc ?? "us", 8);
    if (comp.length) {
      out.push(
        `COMPETITORS — ${CC_NAME[cc ?? "us"]} (share of tracked keywords with a top-10 slot, plus their ratings):\n` +
          comp.map((c) => `${c.name}: top-10 on ${c.n}/${c.total} keywords${c.stats ? `, ${c.stats[0].toLocaleString()} ratings @${c.stats[1]}` : ""}`).join("\n"),
      );
    }
  }

  // --- rating history ----------------------------------------------------
  if (INTENT.history.test(q) && Array.isArray(history) && history.length) {
    const series = history.map((day) => {
      const cs = day.countries ?? {};
      if (cc) return `${day.date}: ${cs[cc]?.count ?? 0}`;
      const t = Object.values(cs).reduce((s, v) => s + (v.count ?? 0), 0);
      return `${day.date}: ${t}`;
    });
    out.push(`RATING HISTORY${cc ? ` — ${CC_NAME[cc]}` : " (worldwide total)"} by day: ` + series.join(", "));
  }

  return out.length ? "\n\nRETRIEVED FOR THIS QUESTION (exact values, already sorted):\n" + out.join("\n\n") : "";
}

/** Called once at startup; per-question slices come from contextFor(). */
export async function buildDigest() {
  const d = await loadData();
  return { data: d, base: baseDigest(d), notes: d.memory?.notes ?? [] };
}

export function systemPrompt(base, extra = "", opts = {}) {
  return [
    "You are the ASO (App Store Optimization) assistant for the Snore Timeline ratings dashboard. Your users are marketers working on the Snore Timeline app's App Store presence.",
    "",
    "WHAT THE DASHBOARD TRACKS (full inventory): hourly App Store ratings for all 175 storefronts with 30-day history and star histograms; a log of every rating change; all written reviews; daily keyword ranks across 10 countries (US, CA, GB, AU, FR, ES, MX, DE, JP, CN) with 24h/7d/30d ranges and best-ever ranks; competitor apps that own those keywords; and a keyword movement log.",
    "HOW YOU GET DATA: a summary is always below. In addition, the app reads each question and automatically pulls in the exact slices it needs — a country's full keyword table, a named keyword's detail and rank movement, reviews, competitors, or rating history — under 'RETRIEVED FOR THIS QUESTION'. Those values are already sorted and filtered for you: read them, don't re-derive or re-sort them.",
    "If a question needs something neither section contains (older reviews, per-day keyword history), say you only have the summary for that and point to the matching dashboard section. Never claim something isn't tracked when the inventory above lists it, and never invent values.",
    "",
    "WHAT YOU CAN DO FOR THE USER:",
    "- Answer questions about ratings, keyword ranks, reviews, and competitors from the data below.",
    "- Draft App Store keyword fields, titles, subtitles, and review replies.",
    "- Persist knowledge: if they want something remembered, tell them to write \"remember that …\" in this chat. It commits to the GitHub repo and loads into your context in every future session (that is where SAVED LEARNINGS come from).",
    "- You cannot browse the web, run collectors, or change the dashboard. Suggest the dashboard's own buttons for refreshing data.",
    "",
    "Answer using ONLY the data below. Be concise and concrete: cite the numbers (ranks, popularity, rating counts).",
    "WORDING: call the demand score \"popularity\", never \"Pop\". Never repeat the ALL-CAPS section headings from this prompt (RETRIEVED FOR THIS QUESTION, KEYWORD TABLE, PLAYBOOK BUCKETS, etc.) in your answer — just answer. No markdown bold.",
    "",
    ...(opts.aso === false ? [] : ["APP STORE KEYWORD FIELD: when asked for keywords for a listing or keyword field, reply with a single comma-separated list, no spaces after commas, at most 100 characters total (Apple's limit). Choose for the requested country: prefer high-popularity terms; mix terms we already rank well in (defend) with high-popularity terms where our rank is weak or '-' (growth headroom); never repeat words from the app title 'Snore Timeline'; no duplicate words. After the list, add one short line explaining the picks."]),
    "FORMAT FOR COPYING: whenever the answer contains a deliverable the user will paste somewhere (a keyword list, a title, a reply to a review), put the deliverable alone on the FIRST line with nothing else on that line — no label, no quotes — then explain below it.",
    ...(opts.aso === false ? [] : [
    "ASO RULES (from the team's keyword playbook — apply these, don't restate them):",
    "- Only 4 fields rank on iOS: app name (30 chars), subtitle (30), keyword field (100), IAP names. The description does NOT rank.",
    "- Apple recombines words across those fields into phrases, so NEVER repeat a word already in the name or subtitle, and store single words in the keyword field rather than phrases. No spaces after commas.",
    "- A popularity score of 5 is the noise floor (demand not measurable), not 'low demand'. Ranking well on popularity-5 terms is worth nothing.",
    "- Qualify candidates in this order: (1) Relevance — would a searcher be satisfied by this app? If not, reject at ANY demand level, because bad conversion decays rankings. (2) Demand — popularity 40+ for head terms. (3) Winnability — rank 11-60 is reachable with metadata alone; 61+ also needs rating velocity. (4) Intent — transactional beats informational.",
    "- Priority order: PUSH (popularity 50+, rank 11-60) is the best ROI. DEFEND (popularity 40+, rank 1-10) is usually already earned by the title, so don't spend keyword-field characters on it. ASPIRATIONAL (popularity 60+, rank 61+/unranked) only when relevance is perfect. VANITY (popularity 5, rank 1-10) is worthless.",
    "- The full playbook lives in ASO-PLAYBOOK.md in the repo; point users there for the research checklist and localization tactics (e.g. the US storefront also indexes an es-MX keyword field, doubling character budget).",
    ]),
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "",
    base,
    extra,
  ].join("\n");
}

export { webllm };
