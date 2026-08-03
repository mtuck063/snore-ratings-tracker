/**
 * evals.js — browser eval runner for the data assistant.
 *
 * Loads cases from evals/cases.json, runs each against the production system
 * prompt + digest (imported from assistant-core.js, so evals can never drift
 * from what the panel actually sends), and grades answers with deterministic
 * checks. Add a case = add an object to cases.json; add a check type = add a
 * function to CHECKS below.
 */

import { TIERS, ThinkParser, buildDigest, contextFor, systemPrompt, webllm } from "./assistant-core.js?v=4";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Check registry. Each returns { ok, detail }.
// `ctx` = { answer, firstLine, tracked } where tracked(cc) → Set of keywords.
// ---------------------------------------------------------------------------

const CHECKS = {
  "first-line-max-chars": (c, ctx) => ({
    ok: ctx.firstLine.length <= c.value,
    detail: `first line is ${ctx.firstLine.length} chars (limit ${c.value})`,
  }),
  "first-line-min-commas": (c, ctx) => {
    const n = (ctx.firstLine.match(/,/g) ?? []).length;
    return { ok: n >= c.value, detail: `first line has ${n} commas (need ≥ ${c.value})` };
  },
  "max-answer-chars": (c, ctx) => ({
    ok: ctx.answer.length <= c.value,
    detail: `answer is ${ctx.answer.length} chars (limit ${c.value})`,
  }),
  "must-include": (c, ctx) => {
    const missing = c.value.filter((s) => !ctx.answer.toLowerCase().includes(s.toLowerCase()));
    return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" };
  },
  "must-not-include": (c, ctx) => {
    const found = c.value.filter((s) => ctx.answer.toLowerCase().includes(s.toLowerCase()));
    return { ok: found.length === 0, detail: found.length ? `contains forbidden: ${found.join(", ")}` : "clean" };
  },
  "must-match": (c, ctx) => {
    const ok = new RegExp(c.value, "i").test(ctx.answer);
    return { ok, detail: `${ok ? "matches" : "no match for"} /${c.value}/i` };
  },
  "items-from-tracked": (c, ctx) => {
    const tracked = ctx.tracked(c.cc);
    if (!tracked) return { ok: false, detail: `no tracked keywords for ${c.cc}` };
    const items = ctx.firstLine.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!items.length) return { ok: false, detail: "no comma items on first line" };
    const unknown = items.filter((i) => !tracked.has(i));
    const share = (items.length - unknown.length) / items.length;
    return {
      ok: share >= (c.min ?? 0.8),
      detail: `${Math.round(share * 100)}% of items are tracked ${c.cc.toUpperCase()} keywords (need ≥ ${Math.round((c.min ?? 0.8) * 100)}%)` +
        (unknown.length ? ` — untracked: ${unknown.join(", ")}` : ""),
    };
  },
};

// ---------------------------------------------------------------------------

let results = null;

async function run() {
  const tier = $("tier").value;
  const reps = Number($("reps").value);
  $("run").disabled = true;
  $("download").disabled = true;
  $("summary").textContent = "";
  $("cases").innerHTML = "";

  try {
    const [{ cases }, digestObj, kwJson] = await Promise.all([
      fetch("evals/cases.json", { cache: "no-cache" }).then((r) => r.json()),
      buildDigest(),
      fetch("data/keywords.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
    ]);
    const trackedByCc = {};
    for (const [cc, kws] of Object.entries(kwJson?.latest ?? {})) {
      trackedByCc[cc] = new Set(Object.keys(kws).map((k) => k.toLowerCase()));
    }
    const tracked = (cc) => trackedByCc[cc];

    // Cache check so the user isn't surprised by a multi-GB download
    const modelId = TIERS[tier].f16;
    const inCache = await webllm.hasModelInCache(modelId, webllm.prebuiltAppConfig).catch(() => false);
    if (!inCache && TIERS[tier].downloadMB > 1000) {
      const goAhead = confirm(`${modelId} isn't cached — this downloads ~${(TIERS[tier].downloadMB / 1000).toFixed(1)} GB. Continue?`);
      if (!goAhead) throw new Error("cancelled");
    }

    $("status").textContent = `Loading ${modelId}…`;
    const worker = new Worker(new URL("./assistant-worker.js", import.meta.url), { type: "module" });
    const engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
      appConfig: webllm.prebuiltAppConfig,
      initProgressCallback: (r) => ($("status").textContent = r.text),
    });

    results = { model: modelId, tier, reps, ranAt: new Date().toISOString(), cases: [] };
    let passCount = 0, totalCount = 0;

    for (const kase of cases) {
      const el = document.createElement("div");
      el.className = "case";
      el.innerHTML = `<h3>${kase.id} <span class="chip pending">running…</span></h3>
        <p class="desc">${kase.description ?? ""}</p><div class="reps"></div>`;
      $("cases").appendChild(el);

      const caseResult = { id: kase.id, runs: [] };
      let casePassed = true;

      for (let rep = 0; rep < reps; rep++) {
        $("status").textContent = `Running ${kase.id} (rep ${rep + 1}/${reps})…`;
        const t0 = performance.now();
        const resp = await engine.chat.completions.create({
          messages: [
            { role: "system", content: systemPrompt(digestObj.base, contextFor(kase.prompt, digestObj.data)) },
            { role: "user", content: kase.prompt },
          ],
          max_tokens: 1536,
        });
        const raw = resp.choices?.[0]?.message?.content ?? "";
        const parser = new ThinkParser();
        const chunks = [...parser.push(raw), ...parser.flush()];
        const thinking = chunks.filter((c) => c.kind === "think").map((c) => c.text).join("");
        const answer = chunks.filter((c) => c.kind === "answer").map((c) => c.text).join("").trim();
        const ctx = { answer, firstLine: answer.split("\n")[0].trim(), tracked };

        const checkResults = kase.checks.map((c) => {
          const fn = CHECKS[c.type];
          const r = fn ? fn(c, ctx) : { ok: false, detail: `unknown check type: ${c.type}` };
          return { type: c.type, ...r };
        });
        const passed = checkResults.every((r) => r.ok);
        casePassed &&= passed;
        passCount += passed ? 1 : 0;
        totalCount += 1;
        caseResult.runs.push({
          rep, passed, answer, thinking,
          seconds: Math.round((performance.now() - t0) / 100) / 10,
          checks: checkResults,
        });

        el.querySelector(".reps").insertAdjacentHTML("beforeend", `
          <ul class="checks">${reps > 1 ? `<li><strong>rep ${rep + 1}</strong></li>` : ""}
            ${checkResults.map((r) => `<li class="${r.ok ? "ok" : "bad"}">${r.type}: ${r.detail}</li>`).join("")}
          </ul>
          <details><summary>answer + thinking (${Math.round((performance.now() - t0) / 1000)}s)</summary>
            <pre>${answer.replace(/</g, "&lt;")}</pre>
            <pre>${thinking.replace(/</g, "&lt;") || "(no thinking)"}</pre>
          </details>`);
      }

      const chip = el.querySelector(".chip");
      chip.textContent = casePassed ? "PASS" : "FAIL";
      chip.className = `chip ${casePassed ? "pass" : "fail"}`;
      results.cases.push(caseResult);
    }

    await engine.unload().catch(() => {});
    worker.terminate();

    $("summary").textContent = `${passCount}/${totalCount} runs passed — ${results.model}`;
    $("status").textContent = "Done.";
    $("download").disabled = false;
  } catch (err) {
    $("status").textContent = `⚠ ${err.message ?? err}`;
  } finally {
    $("run").disabled = false;
  }
}

function download() {
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `eval-${results.tier}-${results.ranAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("run").onclick = run;
$("download").onclick = download;
