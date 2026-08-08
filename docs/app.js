const SPARK_DAYS = 30;
// How long a newly tracked keyword keeps its NEW chip in the table. Two weeks
// is long enough to build a visible sparkline, so the chip retires about when
// the row starts carrying real trend data.
const NEW_KW_MS = 14 * 24 * 60 * 60 * 1000;
const SPARK_W = 100;
const SPARK_H = 28;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const tooltip = document.getElementById("tooltip");

// Place the tooltip near the pointer, above it when there's room, clamped to
// the viewport.
function placeTooltip(e) {
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    tooltip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - tw - 8)}px`;
    tooltip.style.top = `${Math.max(8, e.clientY - th - 14)}px`;
}
// Touch screens have no pointerleave: a tap outside any tooltip source
// dismisses the tooltip instead.
const hideTooltip = () => {
    if (tooltip.hidden) return;
    tooltip.hidden = true;
    document.querySelectorAll(".spark-hover").forEach((h) => h.setAttribute("visibility", "hidden"));
};
document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".spark, .star-bar, [data-tip]")) hideTooltip();
});

// Column headers explain themselves through the same tooltip as the charts
// and star bars. The title attribute they replace needed a second of hover
// and never appeared on touch at all, so on a phone the explanation may as
// well not have existed.
// Anything carrying data-tip explains itself instantly, wherever it is. Bound
// by delegation rather than per element, because most of these are redrawn on
// every edit in the field builder and re-wiring each time is a leak waiting to
// happen.
function showTip(el, e) {
    tooltip.innerHTML = "";
    // An optional kicker, for chips whose own word names the answer without
    // naming the question. "CATEGORY" reads as a topic the keyword belongs to
    // until something says it describes the searcher instead.
    if (el.dataset.tipTitle) {
        const head = document.createElement("div");
        head.className = "tip-title";
        head.textContent = el.dataset.tipTitle;
        tooltip.appendChild(head);
    }
    const line = document.createElement("div");
    line.className = "tip-text";
    line.textContent = el.dataset.tip;
    tooltip.appendChild(line);
    placeTooltip(e);
}
document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target.closest("[data-tip]");
    if (el) showTip(el, e);
});
document.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    if (e.target.closest("[data-tip]")) hideTooltip();
});
// Reposition only while over a tip source, so this never steals the tooltip
// from the sparklines and star bars, which set it themselves.
document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    if (e.target.closest("[data-tip]") && !tooltip.hidden) placeTooltip(e);
});

// Touch has no hover, so the delegation above is half an interaction: on a
// phone every one of these explanations was unreachable unless it happened to
// sit on a header that does not sort. Not only the column meanings — the
// reason behind a score, the intent chips, how hard a phrase is to climb, the
// arithmetic behind a priority number. A tap does the explaining there.
document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    // A control does its own job on tap, and a sortable header sorts. Both
    // keep their tap; the sortable ones get the mark below instead.
    if (el.closest("button") || el.matches("th[data-sort]")) return;
    showTip(el, e);
});

function wireHeaderTips(root = document) {
    // A sortable header keeps its tap for sorting; reading what a column
    // means must not cost the user their sort order. So it carries a mark
    // that can afford the tap. Added from the tip rather than written into
    // the markup, so a column added later gets one by having something to
    // explain, and cannot be given an explanation with no way to reach it.
    for (const th of root.querySelectorAll("th[data-sort][data-tip]")) {
        if (th.querySelector(".th-info")) continue;
        const info = document.createElement("button");
        info.type = "button";
        info.className = "th-info";
        info.textContent = "?";
        info.setAttribute("aria-label", `What ${th.textContent.trim()} means`);
        info.addEventListener("click", (e) => {
            e.stopPropagation(); // the header's own tap sorts, this one does not
            showTip(th, e);
        });
        th.appendChild(info);
    }
}
wireHeaderTips();
// The tooltip is position:fixed, so scrolling moves the page out from under
// it; any scroll (page or a sideways table pan - hence capture) dismisses.
document.addEventListener("scroll", hideTooltip, { capture: true, passive: true });

const flag = (cc) =>
    String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));

// Keyword events live in one shard per month under data/kw-events/, listed by
// index.json. Returns the newest `want` events plus the total across all
// shards, fetching only as many months as it takes to reach `want`.
async function loadRecentKwEvents(want) {
    const grab = (p) =>
        fetch(`data/kw-events/${p}`, { cache: "no-cache" }).then((r) => r.json());
    const idx = await grab("index.json").catch(() => null);
    if (!idx?.months?.length) return { events: [], total: 0 };
    const out = [];
    for (const m of [...idx.months].reverse()) {
        out.unshift(...(await grab(`${m}.json`).catch(() => [])));
        if (out.length >= want) break;
    }
    return { events: out, total: idx.total ?? out.length };
}

const fmt = (n) => n.toLocaleString("en-US");

// "2012-10-26" -> "Oct 2012". Parsed as UTC so the day never shifts backwards
// in western timezones and lands the label on the previous month.
const monthYear = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(+d)
        ? "—"
        : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

// Whole-year age once an app is past its first birthday, one decimal below it,
// so a 10-month-old app reads "0.9y" instead of rounding to a misleading "1y".
const ageYears = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(+d)) return "—";
    const y = (Date.now() - +d) / (365.25 * 24 * 3600 * 1000);
    return y < 1 ? `${y.toFixed(1)}y` : `${Math.floor(y)}y`;
};

function deltaCell(delta) {
    const span = document.createElement("span");
    span.className = "delta";
    if (delta == null) {
        span.classList.add("flat");
        span.textContent = "—";
    } else if (delta > 0) {
        span.classList.add("up");
        span.textContent = `+${fmt(delta)}`;
    } else if (delta < 0) {
        span.classList.add("down");
        span.textContent = `−${fmt(Math.abs(delta))}`;
    } else {
        span.classList.add("flat");
        span.textContent = "0";
    }
    return span;
}

function sparkline(points, label, fmtVal = fmt, minSpan = 0, markDate = null, opts = {}) {
    // points: [{date, count}] oldest→newest, nulls already dropped
    // opts.w/opts.h override the tile size; opts.axes adds the furniture a
    // full-width chart needs (zero baseline, gridlines, value and date labels,
    // an area wash) that would swamp a 100×28 tile.
    const { w = SPARK_W, h = SPARK_H, axes = false } = opts;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("class", "spark");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    if (points.length < 2) return svg;

    const counts = points.map((p) => p.count);
    let min = Math.min(...counts);
    let max = Math.max(...counts);
    // Without a minimum span the y-axis zooms into whatever tiny range the
    // data has, drawing a 0.4-rank drift as a cliff. Pad to at least minSpan
    // so slope steepness stays proportional to real movement.
    if (minSpan && max - min < minSpan) {
        const extra = (minSpan - (max - min)) / 2;
        min -= extra;
        max += extra;
    }
    // Visitor counts sit on a zero baseline; without it the axis would zoom
    // into the data's range and the area wash would hang from a false floor.
    if (axes) min = Math.min(min, 0);
    const padL = axes ? 34 : 3;
    const padR = axes ? 8 : 3;
    const padT = axes ? 6 : 3;
    const padB = axes ? 20 : 3;
    const x = (i) => padL + (i / (points.length - 1)) * (w - padL - padR);
    const y = (v) =>
        max === min
            ? padT + (h - padT - padB) / 2
            : h - padB - ((v - min) / (max - min)) * (h - padT - padB);

    if (axes) {
        // Recessive furniture first so the data draws over it: hairlines at
        // clean values with labels in the left gutter, and a date tick every
        // week counting back from the newest point so "today" always has one.
        const rawStep = (max - min) / 3 || 1;
        const mag = 10 ** Math.floor(Math.log10(rawStep));
        const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep);
        for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("class", "spark-grid");
            line.setAttribute("x1", padL);
            line.setAttribute("x2", w - padR);
            line.setAttribute("y1", y(v).toFixed(1));
            line.setAttribute("y2", y(v).toFixed(1));
            svg.appendChild(line);
            const lab = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lab.setAttribute("class", "spark-tick");
            lab.setAttribute("x", padL - 6);
            lab.setAttribute("y", y(v).toFixed(1));
            lab.setAttribute("text-anchor", "end");
            lab.setAttribute("dy", "0.32em");
            lab.textContent = fmtVal(v);
            svg.appendChild(lab);
        }
        for (let i = points.length - 1; i >= 0; i -= 7) {
            const lab = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lab.setAttribute("class", "spark-tick");
            lab.setAttribute("x", x(i).toFixed(1));
            lab.setAttribute("y", h - 6);
            lab.setAttribute("text-anchor", i === points.length - 1 ? "end" : "middle");
            lab.textContent = new Date(points[i].date + "T00:00:00Z").toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
            });
            svg.appendChild(lab);
        }
    }

    // Per-segment coloring: any real move carries a color. Rank charts plot
    // -rank, so "up" is better for both chart kinds.
    //
    // This used to demand a whole unit, which hid genuine movement whenever it
    // arrived in pieces: #11 → #10.8 → #10 is a full place gained, but neither
    // step cleared the bar on its own, so a rising line read as flat. Legacy
    // rows hold a running average and are the only source of fractional
    // closes; every row written since stores an integer, so the bar only ever
    // cost accuracy. The epsilon absorbs float noise, nothing more.
    const segDir = (i) => {
        const d = counts[i] - counts[i - 1];
        return d > 0.05 ? " up" : d < -0.05 ? " down" : "";
    };

    // The release, as one rule the line crosses. Drawn first so it sits behind
    // the data, and placed between the last day before and the first day after
    // rather than on either of them: the release landed at some hour inside a
    // day, and putting the rule on a day would claim that day for one side.
    if (markDate) {
        const i = points.findIndex((p) => p.date > markDate);
        if (i > 0) {
            const rule = document.createElementNS("http://www.w3.org/2000/svg", "line");
            rule.setAttribute("class", "spark-mark");
            const mx = ((x(i - 1) + x(i)) / 2).toFixed(1);
            rule.setAttribute("x1", mx);
            rule.setAttribute("x2", mx);
            rule.setAttribute("y1", axes ? padT : 1);
            rule.setAttribute("y2", axes ? h - padB : h - 1);
            svg.appendChild(rule);
        }
    }
    if (axes && max > min) {
        const base = y(min).toFixed(1);
        const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
        area.setAttribute("class", "spark-area");
        area.setAttribute(
            "d",
            `M${x(0).toFixed(1)},${base}` +
                points.map((p, i) => `L${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join("") +
                `L${x(points.length - 1).toFixed(1)},${base}Z`
        );
        svg.appendChild(area);
    }
    for (let i = 1; i < points.length; i++) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("class", "spark-line" + segDir(i));
        path.setAttribute(
            "d",
            `M${x(i - 1).toFixed(1)},${y(counts[i - 1]).toFixed(1)}L${x(i).toFixed(1)},${y(counts[i]).toFixed(1)}`
        );
        svg.appendChild(path);
    }

    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "spark-dot" + (points.length > 1 ? segDir(points.length - 1) : ""));
    dot.setAttribute("r", 3);
    dot.setAttribute("cx", x(points.length - 1));
    dot.setAttribute("cy", y(counts.at(-1)));
    svg.appendChild(dot);

    const hover = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hover.setAttribute("class", "spark-hover");
    hover.setAttribute("r", 4);
    hover.setAttribute("visibility", "hidden");
    svg.appendChild(hover);

    const showTip = (e) => {
        const rect = svg.getBoundingClientRect();
        const rel = (e.clientX - rect.left - padL) / (w - padL - padR);
        const i = Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1))));
        hover.setAttribute("cx", x(i));
        hover.setAttribute("cy", y(points[i].count));
        hover.setAttribute("visibility", "visible");
        tooltip.innerHTML = `<span class="tip-value">${points[i].label ?? fmtVal(points[i].count)}</span><span class="tip-date">${points[i].date}</span>`;
        placeTooltip(e);
    };
    // Hover-tracking is mouse-only; touch would flash the tooltip while the
    // finger settles into a scroll.
    svg.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "touch") showTip(e);
    });
    // click, not pointerdown: a click only fires for a completed tap, so a
    // scroll that happens to start on the chart doesn't pop the tooltip.
    svg.addEventListener("click", showTip);
    // Touch fires pointerleave the moment the finger lifts, which would hide
    // the tooltip instantly; touch dismissal is the outside tap instead.
    svg.addEventListener("pointerleave", (e) => {
        if (e.pointerType === "touch") return;
        hover.setAttribute("visibility", "hidden");
        tooltip.hidden = true;
    });

    return svg;
}

function seriesFor(history, cc) {
    return history
        .slice(-SPARK_DAYS)
        .map((row) => ({ date: row.date, count: cc ? row.countries[cc]?.count : globalTotal(row) }))
        .filter((p) => p.count != null);
}

function globalTotal(row) {
    return Object.values(row.countries).reduce((sum, c) => sum + (c?.count ?? 0), 0);
}

// New 5-star ratings needed for the displayed (one-decimal) average to reach
// 5.0, i.e. true average >= 4.95: ceil(20 * n * (4.95 - avg)). 0 = already there.
// Fallback for storefronts without a histogram snapshot; the rounded average
// can push this one too high.
function fiveStarsToFive(count, avg) {
    if (!count || avg == null) return null;
    if (avg >= 4.95) return 0;
    return Math.ceil(20 * count * (4.95 - avg));
}

// Exact version from the star histogram: (S+5x)/(n+x) >= 4.95 solved for the
// smallest integer x reduces to 99n - 20S with S the total star sum.
function fiveStarsToFiveExact(counts) {
    if (!counts) return null;
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) return null;
    const stars = counts.reduce((s, c, i) => s + c * (5 - i), 0);
    return Math.max(0, 99 * n - 20 * stars);
}

// Per-country star additions of the last 24h, from the exactly-attributed
// delta events: cc -> { star: count }. Only additions; removals stay in the
// event log.
function starGains(events) {
    const dayAgo = Date.now() - 864e5;
    const gains = {};
    for (const ev of events) {
        if (ev.type !== "delta" || new Date(ev.at) < dayAgo) continue;
        const add = (star, n) => {
            if (n > 0) (gains[ev.cc] ??= {})[star] = (gains[ev.cc]?.[star] ?? 0) + n;
        };
        if (ev.stars && ev.to > ev.from) add(ev.stars, ev.to - ev.from);
        if (ev.starsMix) for (const [s, d] of Object.entries(ev.starsMix)) add(s, d);
    }
    return gains;
}

// Star histogram as a tiny stacked bar: segments in fixed 5★→1★ order
// (position carries identity), colored good→bad, 2px gaps, slivers kept
// visible by a min width. Exact counts live in the hover tooltip; a green +n
// after the bar marks ratings added in the last 24h.
function mixCell(counts, gains) {
    if (!counts || !counts.some((c) => c > 0)) return null;
    const wrap = document.createElement("span");
    wrap.className = "star-bar-wrap";

    const bar = document.createElement("span");
    bar.className = "star-bar";
    const label = counts
        .map((c, i) => (c > 0 ? `${c}×${5 - i}★` : null))
        .filter(Boolean)
        .join(" · ");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", label);
    counts.forEach((c, i) => {
        if (!c) return;
        const seg = document.createElement("span");
        seg.className = `star-seg s${5 - i}`;
        seg.style.flexGrow = c;
        bar.appendChild(seg);
    });
    const showTip = (e) => {
        tooltip.innerHTML = "";
        counts.forEach((c, i) => {
            if (!c) return;
            const star = 5 - i;
            const row = document.createElement("div");
            row.className = "tip-row";
            const sw = document.createElement("span");
            sw.className = `tip-swatch s${star}`;
            row.appendChild(sw);
            const val = document.createElement("span");
            val.className = "tip-value";
            val.textContent = `${c} × ${star}★`;
            row.appendChild(val);
            const g = gains?.[star];
            if (g) {
                const gp = document.createElement("span");
                gp.className = "tip-gain";
                gp.textContent = `+${g} today`;
                row.appendChild(gp);
            }
            tooltip.appendChild(row);
        });
        placeTooltip(e);
    };
    bar.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "touch") showTip(e);
    });
    // click, not pointerdown: scrolls that start on the bar stay scrolls.
    bar.addEventListener("click", showTip);
    bar.addEventListener("pointerleave", (e) => {
        if (e.pointerType === "touch") return; // dismissed by tapping outside
        tooltip.hidden = true;
    });
    wrap.appendChild(bar);

    // The gain slot always exists (empty when nothing changed) so every bar
    // occupies identical width and the column edges stay aligned.
    const total = Object.entries(gains ?? {}).reduce((s, [, n]) => s + n, 0);
    const gs = document.createElement("span");
    gs.className = "mix-gain";
    if (total > 0) {
        gs.textContent = `+${total}`;
        gs.title = Object.entries(gains)
            .sort((a, b) => b[0] - a[0])
            .map(([s, n]) => `+${n} ${s}-star`)
            .join(", ") + " in the last 24 h";
    }
    wrap.appendChild(gs);
    return wrap;
}

function row({ name, sub, total, delta, avg, mix, to5, spark, isTotal, title }) {
    const tr = document.createElement("tr");
    if (isTotal) tr.className = "total-row";
    else if (delta) tr.className = "changed";

    const tdCountry = document.createElement("td");
    tdCountry.textContent = name;
    if (title) tdCountry.title = title;
    if (sub) {
        const span = document.createElement("span");
        span.className = "country-name";
        span.textContent = sub;
        tdCountry.appendChild(span);
    }

    const tdTotal = document.createElement("td");
    tdTotal.className = "col-num";
    tdTotal.textContent = total == null ? "—" : fmt(total);
    if (total == null) tdTotal.classList.add("muted");

    const tdDelta = document.createElement("td");
    tdDelta.className = "col-num";
    tdDelta.appendChild(deltaCell(delta));

    const tdAvg = document.createElement("td");
    tdAvg.className = "col-num";
    tdAvg.textContent = avg == null ? "—" : avg.toFixed(1);
    if (avg == null) tdAvg.classList.add("muted");

    const tdMix = document.createElement("td");
    tdMix.className = "col-num";
    if (mix) tdMix.appendChild(mix);
    else {
        tdMix.textContent = "—";
        tdMix.classList.add("muted");
    }

    const tdTo5 = document.createElement("td");
    tdTo5.className = "col-num";
    if (to5 == null) {
        tdTo5.textContent = "—";
        tdTo5.classList.add("muted");
    } else if (to5 === 0) {
        tdTo5.textContent = "✓";
        tdTo5.classList.add("at-five");
    } else {
        tdTo5.textContent = fmt(to5);
    }

    const tdSpark = document.createElement("td");
    tdSpark.className = "col-spark";
    tdSpark.appendChild(spark);

    tr.append(tdCountry, tdTotal, tdDelta, tdAvg, tdMix, tdTo5, tdSpark);
    return tr;
}

// "just now" / "14m ago" / "3h ago" / "2d ago"; older than a week: the date.
function ago(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

// The lookup API has no CORS headers but supports JSONP, so the browser can
// query it directly for a live recheck without any server.
function jsonpLookup(cc) {
    return new Promise((resolve, reject) => {
        const cb = `__lookup_${cc}_${Math.floor(performance.now())}`;
        const script = document.createElement("script");
        const timer = setTimeout(() => fail(new Error("timeout")), 10000);
        const fail = (err) => {
            clearTimeout(timer);
            delete window[cb];
            script.remove();
            reject(err);
        };
        window[cb] = (data) => {
            clearTimeout(timer);
            delete window[cb];
            script.remove();
            resolve(data);
        };
        script.onerror = () => fail(new Error("load failed"));
        script.src = `https://itunes.apple.com/lookup?id=6751759381&country=${cc}&callback=${cb}`;
        document.head.appendChild(script);
    });
}

function starsSpan(rating) {
    const span = document.createElement("span");
    span.className = "stars";
    span.textContent = "★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating));
    span.setAttribute("aria-label", `${rating} out of 5 stars`);
    return span;
}

// Free keyless translate endpoint; returns [segments, ..., srcLang].
async function translateToEnglish(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const data = await fetch(url).then((r) => r.json());
    return {
        text: (data[0] ?? []).map((seg) => seg[0]).join(""),
        src: data[2] ?? "",
    };
}

// Heuristic tuned against the actual review corpus: every non-English review
// either uses letters beyond a-z (CJK, Cyrillic, accents) or, if pure ASCII,
// contains 2+ of these foreign function words, none of which are English
// (one hit isn't enough: a reviewer named "Dan" matches the Indonesian word).
const FOREIGN_WORDS = new Set(
    ("und nicht kein keine nur auch sehr ist das der wirklich jetzt oder " +
        "le les une des est pour avec tres cette " +
        "muy que para esta una los las con este pero " +
        "che il per molto questa " +
        "uma muito com por isso " +
        "het een niet erg deze " +
        "och att det inte den ikke og ett " +
        "yang dan untuk tidak ini ang mga").split(" ")
);
function likelyEnglish(text) {
    if (!/\p{L}/u.test(text)) return true; // nothing translatable (emoji-only)
    for (const ch of text) {
        if (/\p{L}/u.test(ch) && !/[a-zA-Z]/.test(ch)) return false;
    }
    const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
    return words.filter((w) => FOREIGN_WORDS.has(w)).length < 2;
}

// Review text is third-party content: build cards with textContent only.
function reviewCard(r, compact) {
    const card = document.createElement("div");
    card.className = compact ? "week-card" : "review-card";

    const head = document.createElement("div");
    head.className = "review-head";
    head.appendChild(starsSpan(r.rating));
    const title = document.createElement("span");
    title.className = "review-title";
    title.textContent = r.title;
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "review-body";
    body.textContent = compact && r.body.length > 120 ? `${r.body.slice(0, 120)}…` : r.body;
    card.appendChild(body);

    const metaLine = document.createElement("div");
    metaLine.className = "review-meta";
    const country = regionNames.of(r.cc.toUpperCase());
    const parts = [`${r.author} · ${flag(r.cc)} ${country}`];
    const when = r.date ?? r.firstSeen;
    if (when) parts.push(new Date(when).toLocaleDateString(undefined, { dateStyle: "medium" }));
    if (r.version) parts.push(`v${r.version}`);
    metaLine.textContent = parts.join(" · ");

    // On-demand translation, shown below the original so both stay visible.
    if (likelyEnglish(`${r.title} ${r.body}`)) {
        card.appendChild(metaLine);
        return card;
    }
    const tBtn = document.createElement("button");
    tBtn.className = "translate-btn";
    tBtn.textContent = "Translate";
    tBtn.addEventListener("click", async () => {
        tBtn.disabled = true;
        tBtn.textContent = "Translating…";
        try {
            const [title, bodyText] = await Promise.all([
                r.title ? translateToEnglish(r.title) : { text: "", src: "" },
                r.body ? translateToEnglish(r.body) : { text: "", src: "" },
            ]);
            if ((bodyText.src || title.src) === "en") {
                tBtn.textContent = "Already English";
                setTimeout(() => tBtn.remove(), 2000);
                return;
            }
            const box = document.createElement("div");
            box.className = "review-translation";
            if (title.text) {
                const t = document.createElement("div");
                t.className = "review-title";
                t.textContent = title.text;
                box.appendChild(t);
            }
            if (bodyText.text) {
                const b = document.createElement("div");
                b.className = "review-body";
                b.textContent = bodyText.text;
                box.appendChild(b);
            }
            card.insertBefore(box, metaLine);
            tBtn.remove();
        } catch {
            tBtn.disabled = false;
            tBtn.textContent = "Translation failed — tap to retry";
        }
    });
    metaLine.appendChild(document.createTextNode(" · "));
    metaLine.appendChild(tBtn);
    card.appendChild(metaLine);

    return card;
}

const reviewTime = (r) => new Date(r.date ?? r.firstSeen).getTime() || 0;

// One side of a starsMix: the levels it left (sign −1) or the levels it landed
// on (sign +1), highest star first. Counts are shown only above one, since a
// single move reads better as "★5 → ★4" than "★5×1 → ★4×1".
const starSide = (mix, sign) =>
    Object.entries(mix ?? {})
        .filter(([, n]) => (sign < 0 ? n < 0 : n > 0))
        .sort((a, b) => b[0] - a[0])
        .map(([s, n]) => (Math.abs(n) > 1 ? `★${s}×${Math.abs(n)}` : `★${s}`))
        .join(" ");

// Reviews written in the last 7 days, in a swipeable row at the top.
function renderWeekReviews(reviews) {
    const fresh = reviews
        .filter((r) => Date.now() - reviewTime(r) <= 7 * 864e5)
        .sort((a, b) => reviewTime(b) - reviewTime(a));
    if (!fresh.length) return;
    document.getElementById("week-reviews").hidden = false;
    const row = document.getElementById("week-row");
    for (const r of fresh) row.appendChild(reviewCard(r, true));
}

function renderReviews(reviews) {
    if (!reviews.length) return;
    reviews = [...reviews].sort((a, b) => reviewTime(b) - reviewTime(a));
    document.getElementById("reviews-section").hidden = false;
    const wrap = document.getElementById("reviews");
    const VISIBLE = 6;
    reviews.forEach((r, i) => {
        const card = reviewCard(r, false);
        card.hidden = i >= VISIBLE;
        wrap.appendChild(card);
    });
    if (reviews.length > VISIBLE) {
        const btn = document.createElement("button");
        btn.className = "show-more";
        btn.textContent = `Show all ${reviews.length} reviews`;
        btn.addEventListener("click", () => {
            wrap.querySelectorAll(".review-card").forEach((c) => (c.hidden = false));
            btn.remove();
        });
        wrap.appendChild(btn);
    }
}

// The three most recent changes, pinned above the table so a fresh rating is
// the first thing on the page. The full log stays in the events section.
function renderRecent(events) {
    if (!events.length) return;
    const box = document.getElementById("recent");
    box.hidden = false;

    // Rolling gains from the event log: new ratings only, so storefronts
    // merely added to tracking don't inflate the totals.
    const gainSince = (ms) =>
        events
            .filter((ev) => (ev.type === "delta" || ev.type === "first") && Date.now() - new Date(ev.at) <= ms)
            .reduce((sum, ev) => sum + (ev.to - (ev.from ?? 0)), 0);

    const head = document.createElement("div");
    head.className = "recent-head";
    const label = document.createElement("span");
    label.className = "recent-label";
    label.textContent = "Latest";
    head.appendChild(label);
    const sums = document.createElement("span");
    sums.className = "recent-sums";
    sums.innerHTML = [["last 24 h", 864e5], ["last 7 days", 7 * 864e5]]
        .map(([t, ms]) => {
            const g = gainSince(ms);
            return `<strong${g < 0 ? ' class="down"' : ""}>${g >= 0 ? "+" : "−"}${fmt(Math.abs(g))}</strong> ${t}`;
        })
        .join(" · ");
    head.appendChild(sums);
    box.appendChild(head);

    const list = document.createElement("div");
    list.className = "recent-list";
    // Every event in the 7-day window, so the sums above are verifiable by
    // eye: rows above the divider add up to the 24h figure, all rows to the
    // 7-day figure. Uncapped for that reason — a row cap silently dropped the
    // oldest events in the window, which left the sums unreconcilable against
    // the rows and against the per-country totals elsewhere. The window is the
    // only limit; a busy week makes a longer strip, which is the point.
    const weekEvents = events.filter((ev) => Date.now() - new Date(ev.at) <= 7 * 864e5).reverse();
    let pastDayDivider = false;
    for (const ev of weekEvents) {
        const when = new Date(ev.at);
        const isOld = Date.now() - when > 864e5;
        if (isOld && !pastDayDivider) {
            pastDayDivider = true;
            const div = document.createElement("div");
            div.className = "recent-divider";
            div.textContent = "earlier this week";
            list.appendChild(div);
        }
        // Rows in the 24h window show relative time — the same clock the
        // divider runs on, so "11h ago" vs a dated row below it reads
        // unambiguously even when both happened on the same calendar day.
        const timeText = isOld
            ? when.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : ago(ev.at);
        // A div, not a link. These read as a summary, and jumping the page to
        // the events section on a stray tap was surprising rather than useful —
        // the row already says everything the target would have shown.
        const item = document.createElement("div");
        item.className = isOld ? "recent-row old" : "recent-row";
        item.title = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
        const name = `${flag(ev.cc)} ${regionNames.of(ev.cc.toUpperCase())}`;
        const d = (ev.to ?? 0) - (ev.from ?? 0);
        // Single rating -> " ★5"; several in one run -> from starsMix, with
        // the count shown only when a star level has more than one ("★5" for
        // a homogeneous pair since the +2 already carries the quantity).
        let starText = "";
        if (ev.stars) starText = ` ★${ev.stars}`;
        else if (ev.starsMix) {
            const added = Object.entries(ev.starsMix).filter(([, n]) => n > 0).sort((a, b) => b[0] - a[0]);
            if (added.length === 1) starText = ` ★${added[0][0]}`;
            else if (added.length) starText = " " + added.map(([s, n]) => (n > 1 ? `★${s}×${n}` : `★${s}`)).join(" ");
        }
        const change =
            ev.type === "review"
                ? `★${ev.rating} review`
                : ev.type === "tracked"
                  ? "now tracked"
                  : ev.type === "edit"
                    ? `${starSide(ev.starsMix, -1)} → ${starSide(ev.starsMix, 1)}`
                    : (d > 0 ? `+${fmt(d)}` : `−${fmt(Math.abs(d))}`) + starText;
        // An edit is neither a gain nor a loss — the count never moved — so it
        // takes neither the green nor the red the other rows use.
        const tone = ev.type === "edit" ? ' class="flat"' : d < 0 && ev.type !== "review" ? ' class="down"' : "";
        item.innerHTML = `<span class="recent-name">${name}</span> <strong${tone}>${change}</strong> <span class="recent-time">${timeText}</span>`;
        list.appendChild(item);
    }
    box.appendChild(list);
}

function renderEvents(history, events) {
    // Events come from the collector's timestamped log, so every entry names
    // the country and the hour it was noticed, including intra-day changes.
    const list = document.getElementById("events");
    const first = history[0];
    const baselineCountries = Object.entries(first.countries).filter(([, c]) => c?.count > 0);
    const baselineTotal = baselineCountries.reduce((sum, [, c]) => sum + c.count, 0);

    let lastDate = null;
    for (const ev of [...events].reverse()) {
        const when = new Date(ev.at);
        const day = when.toLocaleDateString(undefined, { dateStyle: "medium" });
        if (day !== lastDate) {
            const head = document.createElement("li");
            head.className = "date-head";
            head.textContent = day;
            list.appendChild(head);
            lastDate = day;
        }
        const li = document.createElement("li");
        const time = `<span class="event-time">${when.toLocaleTimeString(undefined, { timeStyle: "short" })}</span>`;
        const name = `${flag(ev.cc)} ${regionNames.of(ev.cc.toUpperCase())}`;
        if (ev.type === "first") {
            li.className = "first-rating";
            li.innerHTML = `${time}${name} got its first rating${ev.to > 1 ? "s" : ""}<span class="badge first">FIRST</span><span class="event-note">${fmt(ev.to)} total${ev.avg != null ? `, ${ev.avg.toFixed(1)} avg` : ""}</span>`;
        } else if (ev.type === "tracked") {
            li.className = "tracked";
            li.innerHTML = `${time}${name} added to tracking<span class="badge new">NEW</span><span class="event-note">${fmt(ev.to)} existing rating${ev.to === 1 ? "" : "s"}</span>`;
        } else if (ev.type === "edit") {
            const n = Object.values(ev.starsMix ?? {}).reduce((s, v) => s + Math.max(0, v), 0);
            li.className = "edit";
            li.innerHTML =
                `${time}${name} ${fmt(n)} rating${n === 1 ? "" : "s"} changed star value` +
                `<span class="badge edit">${starSide(ev.starsMix, -1)} → ${starSide(ev.starsMix, 1)}</span>` +
                `<span class="event-note">total unchanged</span>`;
        } else if (ev.type === "review") {
            li.innerHTML = `${time}${name} new written review<span class="badge review">★${Number(ev.rating) || "?"}</span>`;
            if (ev.title) {
                const note = document.createElement("span");
                note.className = "event-note";
                note.textContent = `“${ev.title}”`;
                li.appendChild(note);
            }
        } else {
            const d = ev.to - ev.from;
            let starBadge = ev.stars ? `<span class="badge review">★${ev.stars}</span>` : "";
            if (ev.starsMix) {
                starBadge = Object.entries(ev.starsMix)
                    .sort((a, b) => b[0] - a[0])
                    .map(([s, n]) => `<span class="badge review">${n > 0 ? "+" : "−"}${Math.abs(n)} ★${s}</span>`)
                    .join("");
            }
            li.innerHTML = `${time}${name} ${d > 0 ? `+${fmt(d)}` : `−${fmt(Math.abs(d))}`} rating${Math.abs(d) === 1 ? "" : "s"}${starBadge}<span class="event-note">${fmt(ev.from)} → ${fmt(ev.to)}</span>`;
        }
        list.appendChild(li);
    }

    if (events.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No changes recorded yet. New ratings appear here within an hour of landing.";
        list.appendChild(li);
    }

    const baseline = document.createElement("li");
    baseline.className = "date-head";
    baseline.textContent = `${first.date} · baseline`;
    list.appendChild(baseline);
    const baseLi = document.createElement("li");
    baseLi.className = "empty";
    baseLi.textContent = `Tracking started with ${fmt(baselineTotal)} lifetime ratings across ${baselineCountries.length} countries.`;
    list.appendChild(baseLi);
    // Same reason the table waits: the heading and its subtitle are in the
    // markup, so an unhidden section is a title with nothing under it until
    // the fetches land. The baseline lines above mean this always has content.
    document.getElementById("events-section").hidden = false;
}

// Keyword rankings: one table, tab per market. Rank sparklines plot -rank so
// an improving keyword trends upward like every other chart on the page.
//
// `glossary` maps a foreign term to its English meaning. It ships as a file
// rather than calling a translation service because the page is static and a
// key cannot be kept secret in it — and because a fixed gloss stays put, where
// machine translation would quietly reword the same term between visits.
// Why a term is grouped where it is. Shown on the chip rather than in a
// legend, because a legend is a thing you read once and a tooltip is a thing
// you read when you are actually wondering.
// Two registers on purpose. The tooltip is the short reminder you get while
// reading a table; the legend is where someone meets the word for the first
// time, and there it needs a plain sentence and a real example rather than a
// definition written for someone who already knows.
const INTENT_TIP = {
    symptom: "Someone describing the problem, not shopping for an app yet.",
    category: "Someone shopping for an app like yours, and close to installing one.",
    feature: "Someone after one specific capability.",
    adjacent: "A neighbouring need this app partly serves.",
    brand: "Someone searching for a particular app by name.",
    offtarget: "Not what this app does. Scored zero, so it never reaches the chase list.",
    mine: "Your own app's name.",
};
// What each intent is called on screen, where that differs from what it is
// called in the data. "Category" is the App Store's word for Health & Fitness,
// so on a phrase like "cpap sleep tracker" it reads as which shelf the app sits
// on rather than as a fact about the person searching. "Shopping" says the
// thing the tag actually means, and pairs with the symptom copy, which already
// describes its searcher as not shopping for an app yet.
//
// The key stays "category" in the regex that assigns it, the fit table, the CSS
// and all 327 tagged terms. Renaming those would be a data migration to change
// a word on a chip.
const INTENT_LABEL = { category: "shopping" };
const intentLabel = (intent) => INTENT_LABEL[intent] ?? intent;
// The chip says CATEGORY, which reads as a fact about the keyword until you
// know it is a fact about the person typing it. The title supplies the missing
// half. Applied through a helper because four places draw these chips and a
// fifth will eventually.
function tagIntent(el, intent) {
    el.dataset.tipTitle = "Searcher intent";
    el.dataset.tip = INTENT_TIP[intent] ?? "";
}
// Short forms for the score breakdown, where a full sentence would not fit.
// Each says what the multiplier cost rather than only who is searching: symptom
// and category both score a full 1 and between them take most of the chase
// list, so a line that only described the searcher would read as a no-op on
// nearly every row anyone actually sees. Mirrors FIT in scripts/aso.mjs.
const FIT_SHORT = {
    symptom: "full weight, a problem-aware searcher converts best here",
    category: "full weight, they are shopping for an app like yours",
    feature: "wants one capability, so a small discount",
    adjacent: "a neighbouring need, so half the demand counts",
    brand: "somebody else's marketing, so most of the demand is discounted",
    offtarget: "not this app's category, so none of the demand counts",
    mine: "your own app name, so there is nothing to win",
};
// Who a difficulty reading is about. Which apps were graded matters as much as
// the number: "the five I have to pass are enormous" and "page one is enormous,
// and I am at #90" are different situations, and the collector only started
// recording the apps directly above us recently — anything measured before that
// is graded against page one and has to say so.
const hardWho = (hard) =>
    hard.basis === "above"
        ? `the ${hard.blockers} app${hard.blockers === 1 ? "" : "s"} directly above you`
        : "page one, since the apps immediately above you are not recorded yet";

// Bands for the difficulty chip. Deliberately coarse: the inputs are public
// proxies for competitive strength, not measurements, so three buckets are as
// much precision as the number can carry.
const HARD_BAND = (n) => (n >= 65 ? "hard" : n >= 45 ? "steady" : "soft");

const INTENT_HELP = {
    symptom:
        "Someone describing the problem in their own words. They have not decided an app is the answer yet, so they respond to a listing that names the problem back at them.",
    category:
        "Someone who already knows apps like yours exist and is choosing between them. The most competitive kind, and the closest to installing.",
    feature:
        "Someone after one specific capability. Worth chasing when your app genuinely leads with it, and misleading when it does not.",
    adjacent: "A neighbouring need your app partly serves.",
    brand:
        "Someone searching for a particular app by name. Real demand, but no keyword in your field will win it.",
    offtarget:
        "Not what your app does. Scored zero so it stays out of the chase list, and out of the field recommendation.",
    mine: "Your own app's name. Ranking first here is expected rather than an opportunity.",
};

// The chase list: which phrases are worth the next move. Kept separate from
// the field card because it answers a different question — what to aim at,
// rather than what to write.
// What to actually do about a phrase. The list was a ranking with a fact
// beside each row, and "covered — this is a ranking gap" is a diagnosis with no
// next step: eight of the twelve rows said it, and none of them said what to
// try. Apple does not weigh the three fields equally, so where a word sits is
// itself a lever, and when there is no lever left that is worth saying too.
// Words Apple does not allow in the app name or subtitle. Its metadata rules
// bar prices there, so "promote free into the subtitle" is advice that gets an
// update rejected. Localised, because the rule is about the meaning and every
// storefront has its own word for it.
const NO_PROMOTE = new Set([
    "free", "gratis", "gratuit", "gratuito", "kostenlos", "無料", "免费", "免費", "무료",
]);

const YEAR = /^(19|20)\d{2}$/;

function actionFor(t, alt, b, keys) {
    const title = new Set(b.titleKeys ?? []);
    const sub = new Set(b.subtitleKeys ?? []);
    const label = (u) => b.labels?.[u] ?? u;

    if (t.covered === false && t.missing?.length) {
        // A year is one of the few things Apple is happy to see in an app
        // name, and the name outranks the keyword field, so "Snore Timeline
        // 2026" is the stronger placement for a phrase ending in a year.
        const years = t.missing.filter((w) => YEAR.test(w));
        const rest = t.missing.filter((w) => !YEAR.test(w));
        if (years.length) {
            const now = new Date().getFullYear();
            const stale = years.filter((y) => Number(y) < now);
            const parts = [
                `Put ${years.map((y) => `“${y}”`).join(" and ")} in your app name rather than the keyword field — Apple allows a year there, and weighs the name above the field.`,
            ];
            if (rest.length) {
                parts.push(`${rest.map((w) => `“${w}”`).join(" and ")} can go in the keyword field.`);
            }
            if (stale.length) {
                parts.push(
                    `Worth checking the demand first: ${stale.map((y) => `“${y}”`).join(", ")} ${stale.length === 1 ? "is" : "are"} behind us, and searchers move to ${now} and ${now + 1}.`
                );
            }
            // Only the non-year words go to the draft. Offering to add the year
            // to the keyword field contradicts the sentence above it.
            const restKeys = alt.filter((u) => !keys.has(u) && !YEAR.test(b.labels?.[u] ?? u));
            return { kind: "wording", text: parts.join(" "), ...(restKeys.length && { add: restKeys }) };
        }
        return {
            kind: "wording",
            text: `Add ${t.missing.map((w) => `“${w}”`).join(" and ")} to your keyword field. Apple cannot rank this phrase until every word is somewhere in your listing.`,
            add: alt.filter((u) => !keys.has(u)),
        };
    }
    if (t.rank != null && t.rank <= 10) {
        return { kind: "elsewhere", text: "Already on page one. Defend it rather than spend characters on it." };
    }
    // Which of its words are carried only by the weakest of the three fields,
    // and of those, which are allowed upstairs at all.
    const weak = (alt ?? []).filter((u) => !title.has(u) && !sub.has(u));
    const promotable = weak.filter((u) => !NO_PROMOTE.has(label(u)) && !NO_PROMOTE.has(u));
    const barred = weak.filter((u) => !promotable.includes(u));
    if (promotable.length) {
        const note = barred.length
            ? ` (${barred.map((u) => `“${label(u)}”`).join(", ")} has to stay in the keyword field — Apple does not allow price words in the name or subtitle.)`
            : "";
        const where = promotable.every((u) => YEAR.test(label(u)))
            ? "Moving it into the app name is the wording lever left here — Apple allows a year there."
            : "Promoting one into the subtitle is the wording lever left here.";
        return {
            kind: "wording",
            text: `Every word is present, but ${promotable.map((u) => `“${label(u)}”`).join(", ")} ${promotable.length === 1 ? "sits" : "sit"} only in the keyword field, which Apple weighs below the title and subtitle. ${where}${note}`,
        };
    }
    if (barred.length) {
        return {
            kind: "elsewhere",
            text: `The only word not already in your title or subtitle is ${barred.map((u) => `“${label(u)}”`).join(", ")}, and Apple does not allow price words there. The keyword field is where it has to live, so the wording is as good as it gets — this one climbs on installs, ratings and conversion.`,
        };
    }
    return {
        kind: "elsewhere",
        text: "Your title and subtitle already spell this out, so there is no wording change left. Rank here moves on installs, ratings and how well the screenshots convert.",
    };
}

function renderPlan(host, cc, plan, onRefresh) {
    host.replaceChildren();
    const m = plan?.markets?.[cc];
    if (!m?.chase?.length) {
        host.hidden = true;
        return;
    }
    host.hidden = false;

    // Ranked against your field when you have pasted one. The shipped list is
    // scored against the seed in the repo, which is somebody's note about your
    // listing rather than your listing.
    const rescored = rescoreFor(cc, plan);
    const chase = rescored
        ? [...rescored.entries()]
              .map(([kw, t]) => ({ kw, score: t.score, pop: t.pop, rank: t.rank, intent: t.intent, why: t.why }))
              .filter((c) => c.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, m.chase.length)
        : m.chase;

    const card = document.createElement("div");
    card.className = "plan-card";
    const h = document.createElement("h3");
    h.textContent = "Where to push next";
    card.appendChild(h);
    card.appendChild(
        line(
            "",
            "Ranked by what climbing is worth, so most of these are phrases you already rank for — page one is the top ten, and the top three take most of the taps. Popularity is the 5–100 demand score from Apple's autocomplete, weighted by how far you have left to climb, how hard the apps in the way are to pass, whether this app converts that searcher, and whether your listing carries the words." +
                (rescored ? " Scored against the field you pasted above." : ""),
            "muted"
        )
    );

    const ol = document.createElement("ol");
    ol.className = "plan-chase";
    const olElse = document.createElement("ol");
    olElse.className = "plan-chase";
    const b = m.builder;
    const byKw = new Map((b?.terms ?? []).map((t) => [t.kw, t]));
    const parse = (text) =>
        (text ?? "")
            .split(/[,\u3001\uff0c\n\s]+/)
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean)
            .map((w) => b?.wordKeys?.[w] ?? w);
    const fieldKeys = new Set(parse(storedField(cc) ?? b?.current));
    // What the builder is holding right now, so the button offers only words it
    // would actually change. The draft starts from the recommendation, which
    // already carries most of what your saved field is missing.
    const draftKeys = new Set(draftByCc.get(cc) ?? parse(m.recommended?.field));

    for (const c of chase) {
        const li = document.createElement("li");
        const score = document.createElement("span");
        score.className = "plan-score";
        score.textContent = c.score;
        // Coverage comes from the rescore when you have pasted a field, so the
        // multiplier and the words missing describe the same listing the score
        // was computed against, rather than the seed in the repo.
        const termFull = rescored?.get(c.kw) ?? m.terms[c.kw] ?? {};
        const f = termFull.factors;
        if (f) {
            // The arithmetic behind the number, in the order the score applies
            // it. A ranking anyone is expected to act on should be able to show
            // where it came from.
            //
            // Look the coverage multiplier up the way scoring does rather than
            // dividing the score by the base: base ships rounded to three
            // decimals, so the division returns 0.99 or 1.01 for what is
            // exactly 1, and the page then prints that drift as if it were a
            // real factor.
            const levers = plan.levers ?? { covered: 1, unknown: 1, cheap: 1.25, dear: 0.85 };
            // Without a pasted field the seed only records title and subtitle,
            // so a word absent from both may still be in the keyword field.
            const fieldKnown = rescored != null || !m.coverage?.partial;
            const missCount = (termFull.missing ?? []).length;
            const graded = termFull.covered !== undefined;
            const lever = !graded
                ? 1
                : termFull.covered
                  ? levers.covered
                  : !fieldKnown
                    ? (levers.unknown ?? 1)
                    : missCount <= 2
                      ? levers.cheap
                      : levers.dear;
            // A multiplier of 1 means three different things, and telling
            // someone every word is already in their listing when the page
            // never saw their keyword field is the worst of them.
            const leverWhy = !graded
                ? "no listing recorded for this market, so coverage is not graded"
                : termFull.covered
                  ? "every word already in your listing"
                  : !fieldKnown
                    ? `missing ${missCount} word${missCount === 1 ? "" : "s"} from your title and subtitle, but your keyword field is unknown, so this neither helps nor hurts`
                    : lever > 1
                      ? `${missCount} word${missCount === 1 ? "" : "s"} missing, which is the cheapest kind of fix`
                      : "several words missing, so it is a rewrite rather than an edit";
            // Bands mirror winnability() in scripts/aso.mjs. Say what the
            // multiplier cost, not just what the rank is: on a list sorted by
            // score almost every survivor carries the full 1, so a line that
            // only describes the rank reads as a no-op to whoever got here.
            const reachWhy =
                c.rank == null
                    ? "unranked, so the demand is real but nothing has proven it can rank"
                    : c.rank <= 3
                      ? `#${c.rank} is top three, so the taps are already yours`
                      : c.rank <= 10
                        ? `#${c.rank} is page one, so most of the win is banked`
                        : c.rank <= 50
                          ? `full weight, #${c.rank} is the band where a metadata edit shows`
                          : c.rank <= 100
                            ? `#${c.rank} is past page one, so an edit moves it slower`
                            : `#${c.rank} is far back, so an edit moves it slowly`;
            // Difficulty grades the apps in the way rather than the distance
            // to them, so it is a separate step from headroom. Terms with no
            // reading (the top slot, or a market with nothing recorded) carry
            // a flat 1 and the line is left out rather than shown as a no-op.
            const hard = termFull.hard;
            const easeWhy = !hard ? null : `${hardWho(hard)}: ${hard.why}`;
            const step = (n) => Math.round(n * 100) / 100;
            const x = (n) => n.toFixed(2).replace(/\.?0+$/, "");
            const afterReach = step(c.pop * f.reach);
            const afterEase = step(afterReach * (f.ease ?? 1));
            const afterFit = step(afterEase * f.fit);
            score.dataset.tip =
                `${c.pop} popularity\n` +
                `× ${x(f.reach)} rank headroom (${reachWhy}) = ${afterReach}\n` +
                (easeWhy ? `× ${x(f.ease ?? 1)} difficulty ${hard.score}/100 (${easeWhy}) = ${afterEase}\n` : "") +
                `× ${x(f.fit)} searcher fit (${FIT_SHORT[c.intent] ?? c.intent}) = ${afterFit}\n` +
                `× ${x(lever)} coverage (${leverWhy}) = ${c.score}`;
        }
        const kwEl = document.createElement("strong");
        kwEl.textContent = c.kw;
        const chip = document.createElement("span");
        chip.className = `badge kw-intent intent-${c.intent}`;
        chip.textContent = intentLabel(c.intent);
        tagIntent(chip, c.intent);

        // Why it is worth chasing, in the terms the score is made of.
        const why = document.createElement("span");
        why.className = "plan-why";
        // Where you stand, in the only unit that matters: how far from the
        // part of the results people actually look at. "Currently #18" reads
        // as an achievement until you know page one ends at ten.
        const standing =
            c.rank == null
                ? "not in the top 200 yet, so this would be starting from nothing"
                : c.rank <= 3
                  ? `you are #${c.rank} — most of the taps for this phrase are already yours`
                  : c.rank <= 10
                    ? `you are #${c.rank}, on page one, ${c.rank - 3} place${c.rank - 3 === 1 ? "" : "s"} off the top three that take most of the taps`
                    : c.rank <= 50
                      ? `you already rank #${c.rank}, ${c.rank - 10} place${c.rank - 10 === 1 ? "" : "s"} below page one`
                      : `you rank #${c.rank}, well outside page one, but the demand justifies a push`;
        why.textContent = `${c.pop} popularity — ${standing}.`;

        const term = m.terms[c.kw];
        const bt = byKw.get(c.kw);
        const alt = bt?.alts?.[0] ?? [];
        const action = actionFor(term ?? {}, alt, b ?? {}, fieldKeys);
        const act = document.createElement("span");
        act.className = "plan-action";
        act.textContent = action.text;
        // Words the draft is already carrying need no button, and saying so is
        // more useful than a button that appears to do nothing when clicked.
        const toAdd = (action.add ?? []).filter((u) => !draftKeys.has(u));
        if (action.add?.length && !toAdd.length) {
            act.textContent +=
                " The draft field above already includes them, so copying that into App Store Connect fixes this.";
        }

        li.append(score, kwEl, chip);
        // How hard the phrase is to climb, beside how much there is to gain.
        // The two are independent, and a plan that shows only the second sends
        // you at the phrase with the most demand and the least chance.
        const hardFull = m.terms[c.kw]?.hard;
        if (hardFull) {
            const band = HARD_BAND(hardFull.score);
            const hardChip = document.createElement("span");
            hardChip.className = `badge kw-hard hard-${band}`;
            hardChip.textContent = `${band} climb`;
            hardChip.dataset.tip =
                `Difficulty ${hardFull.score}/100, grading ${hardWho(hardFull)}: ${hardFull.why}. ` +
                `It ranks phrases against each other from public signals — ratings, names, release dates — ` +
                `and is not a probability of winning.`;
            li.appendChild(hardChip);
        }
        // Nothing left to do here in this card, which is a finished state
        // rather than an omission. Marking it says the wording work landed.
        if (action.kind === "elsewhere") {
            const done = document.createElement("span");
            done.className = "badge kw-done";
            done.textContent = "wording done";
            done.dataset.tip =
                "Every word of this phrase is already in your title or subtitle. No keyword field change can improve it.";
            li.appendChild(done);
        }
        li.append(why, act);

        // One click to try it, since the field it belongs in is on this page.
        if (toAdd.length) {
            const btn = document.createElement("button");
            btn.className = "plan-copy plan-try";
            btn.textContent = `Add ${toAdd.map((u) => b.labels?.[u] ?? u).join(", ")} to the draft`;
            btn.addEventListener("click", () => {
                const draft = new Set(draftKeys);
                for (const u of toAdd) draft.add(u);
                draftByCc.set(cc, [...draft]);
                onRefresh?.();
            });
            li.appendChild(btn);
        }
        (action.kind === "elsewhere" ? olElse : ol).appendChild(li);
    }
    // Two lists, because they need different decisions. The first is work you
    // can do in this card. The second is demand you are close to and cannot
    // reach with a word — worth knowing precisely because the lever is
    // somewhere else, and burying it at the top of the actionable list made a
    // keyword change look like the answer.
    if (ol.children.length) card.appendChild(ol);
    if (olElse.children.length) {
        const h4 = document.createElement("p");
        h4.className = "fb-label plan-else-head";
        h4.textContent = "Wording done — these now move on ratings and conversion";
        card.appendChild(h4);
        card.appendChild(
            line(
                "",
                "Your listing already says everything these phrases need, so there is nothing left to change here. They climb on installs, ratings and how well the screenshots convert.",
                "muted"
            )
        );
        card.appendChild(olElse);
    }

    host.appendChild(card);
    makeCollapsible(h, "push", true)(
        `${chase.length} worth a change${olElse.children.length ? `, ${olElse.children.length} already done` : ""}`
    );
}

// Shared by both panels.
function line(label, value, cls) {
    const p = document.createElement("p");
    p.className = "plan-line" + (cls ? ` ${cls}` : "");
    if (label) {
        const b = document.createElement("span");
        b.className = "plan-label";
        b.textContent = label;
        p.appendChild(b);
    }
    p.appendChild(document.createTextNode(value));
    return p;
}

function expandable(head, items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "gap-head";
    btn.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "gap-caret";
    caret.textContent = "\u25b8";
    btn.append(caret, ...head);
    const list = document.createElement("ul");
    list.className = "gap-terms";
    list.hidden = true;
    for (const t of items) {
        const ti = document.createElement("li");
        if (typeof t === "string") ti.textContent = t;
        else {
            // A phrase and what it is worth, so a list of eight wins is not
            // eight equal-looking lines when one of them carries half the demand.
            const name = document.createElement("span");
            name.textContent = t.text;
            const val = document.createElement("span");
            val.className = "gap-term-val";
            val.textContent = t.meta;
            ti.className = "gap-term-row";
            ti.append(name, val);
        }
        list.appendChild(ti);
    }
    btn.addEventListener("click", () => {
        list.hidden = !list.hidden;
        caret.textContent = list.hidden ? "\u25b8" : "\u25be";
        btn.setAttribute("aria-expanded", String(!list.hidden));
    });
    li.append(btn, list);
    return li;
}

// Sections fold away and stay that way. The page is thirteen screens tall and
// most visits care about one part of it; which part differs by person, so the
// choice is remembered rather than guessed at.
function makeCollapsible(headEl, key, defaultOpen = true) {
    const store = `asoOpen:${key}`;
    const body = headEl.parentElement;
    // The competitor panel defers this to a microtask, so a second render in
    // the same turn — two market tabs tapped inside one frame — clears the
    // panel before the first header is ever wired. That header has no section
    // left to fold, and reaching for its parent threw. Stale work, and the
    // live header gets a call of its own, so there is nothing to do but stop.
    if (!body) return () => {};
    let open = (localStorage.getItem(store) ?? (defaultOpen ? "1" : "0")) === "1";
    headEl.classList.add("sec-toggle");
    headEl.setAttribute("role", "button");
    headEl.setAttribute("tabindex", "0");
    const caret = document.createElement("span");
    caret.className = "sec-caret";
    headEl.prepend(caret);
    // A closed section still has room to say what is inside it, which beats a
    // bare strip you have to open to find out whether you wanted it.
    const summary = document.createElement("span");
    summary.className = "sec-sum";
    headEl.appendChild(summary);
    const apply = () => {
        body.classList.toggle("sec-collapsed", !open);
        caret.textContent = open ? "\u25be" : "\u25b8";
        headEl.setAttribute("aria-expanded", String(open));
    };
    apply();
    const toggle = () => {
        open = !open;
        localStorage.setItem(store, open ? "1" : "0");
        apply();
    };
    headEl.addEventListener("click", toggle);
    headEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
        }
    });
    return (text) => (summary.textContent = text);
}

// Your pasted field, per market, as the page stored it.
const storedField = (cc) => localStorage.getItem(`asoField:${cc}`);
// The working field per market, kept across re-renders of the builder.
const draftByCc = new Map();

// Re-score every phrase against the field you actually have, rather than the
// seed committed to the repo. Only the coverage factor is recomputed here: the
// rest of the score — demand, rank headroom, who is searching — cannot change
// with your keyword field, and ships already multiplied together as `base`.
function rescoreFor(cc, plan) {
    const m = plan?.markets?.[cc];
    const b = m?.builder;
    const raw = storedField(cc);
    if (!b || raw == null || !raw.trim()) return null;

    const labels = b.labels ?? {};
    const wordKeys = b.wordKeys ?? {};
    const keyOf = new Map(Object.entries(labels).map(([k, v]) => [v, k]));
    const show = (u) => labels[u] ?? u;
    const keys = new Set(
        raw
            .split(/[,\u3001\uff0c\n\s]+/)
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean)
            .map((w) => wordKeys[w] ?? keyOf.get(w) ?? w)
    );
    const sat = (u) => keys.has(u) || (/[\u3040-\u30ff\u4e00-\u9fff]/.test(u) && [...keys].some((p) => p.includes(u)));

    const levers = plan.levers ?? { covered: 1, cheap: 1.25, dear: 0.85 };
    const out = new Map();
    for (const t of b.terms) {
        const term = m.terms[t.kw];
        if (!term) continue;
        const covered = t.alts.some((a) => a.every(sat));
        // The cheapest way left to satisfy it, which is what to report missing.
        const missingKeys = covered
            ? []
            : (t.alts.map((a) => a.filter((u) => !sat(u))).sort((a, c) => a.length - c.length)[0] ?? []);
        const missing = missingKeys.map(show);
        const lever = covered ? levers.covered : missingKeys.length <= 2 ? levers.cheap : levers.dear;
        const where = t.rank == null ? "unranked" : `#${t.rank}`;
        // Same sentences as scripts/aso.mjs, because the same facts deserve the
        // same words wherever they are computed.
        const why = !covered
            ? `${t.pop} pop, ${where}, listing has no ${missing.map((x) => `"${x}"`).join(", ")}`
            : t.rank == null
              ? `${t.pop} pop, unranked, words are all in the listing`
              : t.rank <= 10
                ? `${t.pop} pop, ${where}, page one already`
                : `${t.pop} pop, ${where}, covered — this is a ranking gap, not a wording one`;
        out.set(t.kw, {
            ...term,
            covered,
            ...(missing.length ? { missing } : {}),
            score: Math.round(100 * (term.base ?? 0) * lever),
            why,
        });
    }
    return out;
}

// What the tags on each row mean, spelled out on the page rather than hidden
// in a tooltip, and doubling as filters. "CATEGORY" explains nothing until
// someone tells you it is about the searcher, not about the app.
function renderLegend(host, cc, plan, filter, onChange, counts) {
    host.replaceChildren();
    const terms = plan?.markets?.[cc]?.terms;
    if (!terms) {
        host.hidden = true;
        return;
    }
    host.hidden = false;
    const head = document.createElement("div");
    head.className = "recent-label";
    head.textContent = "What the tags mean, and filtering by them";
    host.appendChild(head);
    const intro = document.createElement("p");
    intro.className = "plan-line muted";
    intro.textContent = "Each keyword is tagged by who is searching it. Tap a tag to show only those rows:";
    host.appendChild(intro);

    const ul = document.createElement("ul");
    ul.className = "kw-legend-list";
    const present = new Set(Object.values(terms).map((t) => t.intent));
    const anyGap = Object.values(terms).some((t) => t.covered === false);

    // Intents are mutually exclusive, so selecting several means "any of
    // these"; "words missing" asks a different question about the same row, so
    // it narrows whatever is selected rather than joining it.
    const row = (cls, label, tip, on, toggle, egs = []) => {
        const li = document.createElement("li");
        li.className = "kw-legend-row" + (on ? " on" : "");
        const btn = document.createElement("button");
        btn.className = "kw-legend-toggle";
        btn.setAttribute("aria-pressed", String(on));
        const chip = document.createElement("span");
        chip.className = `badge ${cls}`;
        chip.textContent = label;
        const text = document.createElement("span");
        text.textContent = tip;
        if (egs.length) {
            const eg = document.createElement("span");
            eg.className = "kw-legend-eg";
            eg.textContent = ` e.g. ${egs.map((x) => `“${x}”`).join(", ")}`;
            text.appendChild(eg);
        }
        btn.append(chip, text);
        btn.addEventListener("click", () => {
            toggle();
            onChange();
        });
        li.appendChild(btn);
        return li;
    };

    // Two real phrases per tag, the highest-demand ones this market tracks. A
    // definition tells you what the word means; an example tells you what it
    // looks like, and one of those is faster to read.
    const examples = {};
    for (const [kw, t] of Object.entries(terms)) {
        (examples[t.intent] ??= []).push({ kw, pop: t.pop ?? 0 });
    }
    for (const list of Object.values(examples)) list.sort((a, b) => b.pop - a.pop);

    for (const [intent, help] of Object.entries(INTENT_HELP)) {
        if (!present.has(intent)) continue;
        ul.appendChild(
            row(
                `kw-intent intent-${intent}`,
                intentLabel(intent),
                help,
                filter.intents.has(intent),
                () => {
                    if (filter.intents.has(intent)) filter.intents.delete(intent);
                    else filter.intents.add(intent);
                },
                (examples[intent] ?? []).slice(0, 2).map((e) => e.kw)
            )
        );
    }
    if (anyGap) {
        ul.appendChild(
            row(
                "kw-gap",
                "words missing",
                "Your title, subtitle and keyword field between them do not contain every word in this phrase. You can still rank for it, and most phrases flagged here do, because Apple matches word forms and weighs signals beyond your text. But a phrase whose words you carry is one you can influence directly. Tap a row to see what is missing.",
                filter.gapOnly,
                () => {
                    filter.gapOnly = !filter.gapOnly;
                }
            )
        );
    }
    host.appendChild(ul);

    if (filter.intents.size || filter.gapOnly) {
        const count = document.createElement("p");
        count.className = "plan-line muted";
        count.textContent = `Showing ${counts.shown} of ${counts.total} keywords.`;
        host.appendChild(count);
        const clear = document.createElement("button");
        clear.className = "plan-copy";
        clear.textContent = "Show all keywords";
        clear.addEventListener("click", () => {
            filter.intents.clear();
            filter.gapOnly = false;
            onChange();
        });
        host.appendChild(clear);
    }
    // Open when a filter is on, or the rows would be hidden with no visible
    // reason for the table being short.
    const legendSummary = makeCollapsible(head, "legend", filter.intents.size > 0 || filter.gapOnly);
    legendSummary(
        filter.intents.size || filter.gapOnly
            ? `filtered to ${counts.shown} of ${counts.total}`
            : `${present.size} tags`
    );
}

// The field card: everything about the 100 characters you control, in one
// place. The listing context, the working field, what it covers, what it is
// aimed at, and what one more word would buy.
//
// This used to be three panels that restated each other — a "Listing" card
// naming the recommendation, a "Add one word" card ranking missing words
// against the current listing, and a builder ranking the same words against
// the working field. Two of them answered the same question with different
// numbers whenever the working field was edited.
//
// Coverage is recomputed here on every click, but none of the language rules
// are: scripts/aso.mjs ships each phrase with the unit-sets that satisfy it,
// so this only asks whether one of those sets is satisfied by what is picked.
const FIELD_MAX = 100;

function renderBuilder(host, cc, plan, onFieldSaved, onDraftChange) {
    host.replaceChildren();
    const m = plan?.markets?.[cc];
    const b = m?.builder;
    if (!b?.terms?.length) {
        host.hidden = true;
        return;
    }
    host.hidden = false;

    const labels = b.labels ?? {};
    const wordKeys = b.wordKeys ?? {};
    const keyOf = new Map(Object.entries(labels).map(([k, v]) => [v, k]));
    const show = (u) => labels[u] ?? u;

    // Parse a written field into match keys. A word no tracked phrase uses
    // resolves to nothing, which is the right answer: it cannot affect
    // coverage. CJK entries pass through, since units there match by
    // containment against whatever the field carries.
    const parseField = (text) =>
        (text ?? "")
            // Space is a separator too: "apple watch" in the field is two
            // indexed words, and treating it as one unit made it show up as
            // both dropped and added in the same comparison.
            .split(/[,\u3001\uff0c\n\s]+/)
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean)
            .map((w) => wordKeys[w] ?? keyOf.get(w) ?? w);

    // Your field lives in your browser. scripts/metadata.json only ever seeds
    // it, and that file is a note someone typed, not a reading from App Store
    // Connect.
    const storeKey = `asoField:${cc}`;
    let savedRaw = localStorage.getItem(storeKey);
    const currentRaw = savedRaw ?? b.current ?? "";
    // Three states, not two. A box showing the repo seed has nothing to save
    // and is not mid-save, and calling that "saving…" forever reads as a bug
    // that never resolves.
    let dirty = false;

    const recommended = parseField(m.recommended?.field);
    // Survives the re-render that saving your field triggers; losing a draft
    // because you corrected a typo in the box above it would be its own bug.
    let picked = new Set(draftByCc.get(cc) ?? recommended);
    const remember = () => draftByCc.set(cc, [...picked]);

    const sat = (u, set = picked) =>
        set.has(u) || (/[\u3040-\u30ff\u4e00-\u9fff]/.test(u) && [...set].some((p) => p.includes(u)));
    const holdsIn = (t, set) => t.alts.some((a) => a.every((u) => sat(u, set)));

    let setSummary = null;
    const charsOf = (set) => [...set].map(show).join(",").length;
    const popTotal = b.terms.reduce((n, t) => n + t.pop, 0);

    // Why the builder's denominator is smaller than the table's. The table and
    // the competitor panel count every tracked keyword; this field can only win
    // the ones a keyword is allowed to buy, so competitor names, your own name,
    // and off-category phrases are out. Unexplained, two numbers for the same
    // market look like a bug.
    const tracked = Object.keys(m.terms ?? {});
    const inBuilder = new Set(b.terms.map((t) => t.kw));
    const excluded = {};
    for (const kw of tracked) {
        if (inBuilder.has(kw)) continue;
        const intent = m.terms[kw].intent;
        const bucket = ["brand", "mine", "offtarget"].includes(intent) ? intent : "unbuyable";
        excluded[bucket] = (excluded[bucket] ?? 0) + 1;
    }
    const excludedWords = {
        brand: (n) => `${n} competitor name${n === 1 ? "" : "s"}`,
        mine: () => "your own app name",
        offtarget: (n) => `${n} outside this app's category`,
        unbuyable: (n) => `${n} no keyword field can express`,
    };
    const denominatorTip =
        `${b.terms.length} of the ${tracked.length} keywords tracked for this market are winnable with a keyword field. ` +
        `The rest: ${Object.entries(excluded).map(([k, n]) => excludedWords[k](n)).join(", ")}.`;

    const h = document.createElement("h3");
    h.textContent = "Keyword field builder";
    // What the card is for, in the order you would do it. Everything here was
    // legible on its own and added up to no instruction: a reader could tell
    // what each number meant and still not know what they were meant to do.
    const how = document.createElement("p");
    how.className = "plan-line muted";
    // Sits directly above the box it describes. Between the heading and the
    // title and subtitle it split the listing context in half and explained a
    // field the reader had not reached yet.
    how.textContent =
        "Your keywords are a 100-character field of their own, on top of those. Paste what you have now, try changes against it, and copy the result back when it wins more than it gives up.";

    // Listing context: the two fields Apple pools with the keyword field, which
    // you cannot edit here but which decide what the field still has to carry.
    const context = document.createElement("div");
    context.className = "fb-context";
    const l = m.listing;
    if (l) {
        context.appendChild(
            line("Title", l.title ? `${l.title}  (${l.title.length}/30)` : "\u2014")
        );
        context.appendChild(
            l.subtitle
                ? line("Subtitle", `${l.subtitle}  (${l.subtitleChars}/30)`)
                : line("Subtitle", "none set \u2014 Apple fills the slot with your category, and 30 indexed characters go unspent", "warn")
        );
        // How much the other two fields already do. "16 of 73 covered" with an
        // empty keyword field looks broken until you know the title and
        // subtitle are indexed too and are carrying those phrases on their own.
        const freeCovers = b.terms.filter((t) => holdsIn(t, new Set())).length;
        // Listed as written, not as the stems they match on: "snor, timelin"
        // is the internal form and reads as a typo.
        const freeWords = [
            ...new Set(`${l.title ?? ""} ${l.subtitle ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)),
        ];
        context.appendChild(
            line(
                "",
                `Apple matches a search against all three together — title, subtitle and keyword field — so a word already in the title or subtitle costs nothing in the keyword field. Those two alone already cover ${freeCovers} of ${b.terms.length} phrases: everything buildable from ${freeWords.join(", ")}.`,
                "muted"
            )
        );
    }

    // Your real field, typed once and kept.
    const yours = document.createElement("div");
    yours.className = "fb-yours";
    const yoursLabel = document.createElement("label");
    yoursLabel.className = "fb-label";
    yoursLabel.textContent = "Your keywords in App Store Connect";
    yoursLabel.htmlFor = `fb-input-${cc}`;
    // A textarea, not a single line: a 100-character field scrolled sideways in
    // an input is a field you cannot read to check.
    const input = document.createElement("textarea");
    input.id = `fb-input-${cc}`;
    input.className = "fb-input";
    input.rows = 2;
    input.value = currentRaw;
    input.placeholder = "paste it straight from App Store Connect: recorder,monitor,cpap,\u2026";
    input.spellcheck = false;

    // What Apple counts: the entries joined by commas. Pasted text arrives with
    // spaces after commas, quotes round the whole thing and stray newlines, and
    // none of those are in the field itself.
    const tidy = (text) =>
        (text ?? "")
            .replace(/^[\s"']+|[\s"']+$/g, "")
            .split(/[,\u3001\uff0c\n]+/)
            .map((w) => w.trim())
            .filter(Boolean)
            .filter((w, i, all) => all.indexOf(w) === i)
            .join(",");
    const yoursNote = document.createElement("span");
    yoursNote.className = "fb-yours-note";
    // Duplication is a property of the field you typed, so it belongs under the
    // box you typed it in. Sitting up in the listing context it named a word
    // without saying which field carried it.
    const yoursWaste = document.createElement("span");
    yoursWaste.className = "fb-yours-waste";
    const claimedKeys = new Set(b.claimed ?? []);
    const refreshNote = () => {
        const clean = tidy(input.value);
        const keys = new Set(parseField(clean));

        // Words the title or subtitle already carries. Apple pools all three
        // fields, so a second copy ranks for nothing and the characters are
        // simply gone.
        const dupes = clean
            .split(",")
            .filter(Boolean)
            .filter((w) => claimedKeys.has(wordKeys[w.toLowerCase()] ?? keyOf.get(w.toLowerCase()) ?? w.toLowerCase()));
        const wasted = dupes.reduce((n, w) => n + w.length + 1, 0);
        yoursWaste.textContent = dupes.length
            ? `${dupes.join(", ")} ${dupes.length === 1 ? "is" : "are"} already in your title or subtitle, so ${wasted} of these characters buy nothing.`
            : "";
        const n = b.terms.filter((t) => holdsIn(t, keys)).length;
        yoursNote.classList.toggle("over", clean.length > FIELD_MAX);
        const state = dirty
            ? "saving\u2026"
            : savedRaw != null
              ? "saved in this browser"
              // Named for what it is rather than where it is stored. Nobody
              // standing in App Store Connect needs a path in this repo.
              : "a placeholder, not read from App Store Connect \u2014 paste yours to replace it";
        yoursNote.textContent = clean
            ? `${clean.length}/${FIELD_MAX} characters, covering ${n} of ${b.terms.length} phrases` +
              (clean.length > FIELD_MAX ? " \u00b7 over the limit" : "") +
              ` \u00b7 ${state}`
            // No file paths and no half-truths: with the box empty the builder
            // has nothing to compare against, and saying which file the
            // fallback came from helps nobody standing in App Store Connect.
            : "Paste your keywords to compare them against the draft below.";
    };
    refreshNote();
    yours.append(yoursLabel, input, yoursNote, yoursWaste);

    const stats = document.createElement("div");
    stats.className = "fb-stats";
    const mix = document.createElement("div");
    mix.className = "fb-mix";
    const panel = document.createElement("div");
    panel.className = "fb-panel";
    // The draft field gets the same shape as the box above it: a label, the
    // field as one monospace string, a character count. Two boxes that look
    // alike read as two versions of the same thing, which a row of loose chips
    // never did — it read as a tag cloud, or as the recommendation, which it
    // stops being the moment you change a word.
    const draft = document.createElement("div");
    draft.className = "fb-draft";
    const chipHead = document.createElement("p");
    chipHead.className = "fb-label";
    const preview = document.createElement("div");
    preview.className = "fb-preview";
    const chipRow = document.createElement("div");
    chipRow.className = "fb-chips";
    const suggest = document.createElement("div");
    suggest.className = "fb-suggest";
    const buttons = document.createElement("div");
    buttons.className = "fb-actions";

    const act = (label, fn) => {
        const btn = document.createElement("button");
        btn.className = "plan-copy";
        btn.textContent = label;
        btn.addEventListener("click", fn);
        buttons.appendChild(btn);
        return btn;
    };

    // A tile can open to the phrases behind its number. "55 of 73 covered" is
    // a claim about a specific 55 and a specific 18, and the only way to judge
    // whether the trade is good is to see which is which.
    // Two faults the box above does not already cover. Words the title or
    // subtitle repeats are reported under the field itself, since duplication
    // is a property of what you typed. These two are properties of the phrases
    // being tracked: a word no tracked phrase can use, and a word naming a
    // year that has already passed.
    //
    // Recomputed here rather than read from aso.json so it follows the field
    // in the box as it is edited. The rule is the same set arithmetic coverage
    // uses, so the two cannot drift.
    const unitList = b.units ?? [];
    const thisYear = new Date().getFullYear();
    const isPastYear = (w) => /^(19|20)\d{2}$/.test(w) && Number(w) < thisYear;
    const rawWords = (text) =>
        (text ?? "")
            .split(/[,、，\n\s]+/)
            .map((w) => w.trim())
            .filter(Boolean);

    const freeWords = new Set(b.free ?? []);
    const wasteOf = (text) => {
        const dead = [];
        const gratis = [];
        const stale = [];
        for (const w of rawWords(text)) {
            if (isPastYear(w)) {
                stale.push(w);
                continue;
            }
            const lower = w.toLowerCase();
            const key = wordKeys[lower] ?? keyOf.get(lower) ?? lower;
            // Already counted under the field box as a duplicate. Counting it
            // twice would read as two separate problems with one word.
            if (claimedKeys.has(key)) continue;
            // Separated from `dead` because the confidence differs. Apple
            // matching articles and pronouns for free is a measured finding;
            // a word no tracked phrase uses is only unmeasurable.
            if (freeWords.has(key) || freeWords.has(lower)) gratis.push(w);
            else if (!unitList.some((u) => sat(u, new Set([key])))) dead.push(w);
        }
        // The comma each word costs is part of what dropping it returns.
        const cost = (ws) => ws.reduce((n, w) => n + w.length + 1, 0);
        return { dead, gratis, stale, chars: cost(dead) + cost(gratis) };
    };

    const waste = document.createElement("div");
    waste.className = "fb-waste";

    function drawWaste() {
        waste.replaceChildren();
        const text = input.value.trim() || b.current || "";
        const w = wasteOf(text);
        if (!w.dead.length && !w.gratis.length && !w.stale.length) {
            waste.hidden = true;
            return;
        }
        waste.hidden = false;
        const h4 = document.createElement("h4");
        h4.textContent = w.chars
            ? `${w.chars} of ${text.length} characters may be buying nothing`
            : "Worth a second look";
        waste.appendChild(h4);

        const row = (label, words, tip) => {
            const p = document.createElement("p");
            p.className = "plan-line";
            if (tip) p.dataset.tip = tip;
            const b1 = document.createElement("span");
            b1.className = "plan-label";
            b1.textContent = label;
            p.appendChild(b1);
            p.appendChild(document.createTextNode(words.join(", ")));
            waste.appendChild(p);
        };
        if (w.gratis.length)
            row(
                "already free",
                w.gratis,
                "Apple matches articles, prepositions, conjunctions and pronouns without your carrying them. Measured, not assumed: every tracked phrase whose only gap was one of these was already ranking without it. These characters are recoverable outright."
            );
        if (w.dead.length)
            row(
                "no phrase uses",
                w.dead,
                "No phrase this market tracks can be built from these. That is not proof they are useless: they may be earning on a phrase nobody thought to track. It does mean nothing here can show you what they are worth."
            );
        if (w.stale.length) {
            row(
                "past year",
                w.stale,
                `It is ${thisYear}. These only unlock phrases naming an earlier year. The demand is real today and dated: the score halves it for every year elapsed rather than ignoring it, so a phrase heavy enough to still pay is still recommended.`
            );
            const terms = m.staleYear?.terms ?? [];
            if (terms.length) {
                const ul = document.createElement("ul");
                ul.className = "fb-waste-terms";
                for (const t of terms.slice(0, 4)) {
                    const li = document.createElement("li");
                    li.textContent = `${t.kw} · ${t.pop} pop · ${t.rank ? "#" + t.rank : "unranked"}`;
                    ul.appendChild(li);
                }
                waste.appendChild(ul);
            }
            // The recommendation is scored with the same discount, so when it
            // keeps one of these words it has already weighed the fade and
            // decided the demand still pays. Saying so is the difference
            // between two panels disagreeing and one of them showing its work.
            const rec = new Set(rawWords(m.recommended?.field).map((w) => w.toLowerCase()));
            const kept = w.stale.filter((x) => rec.has(x.toLowerCase()));
            if (kept.length)
                waste.appendChild(
                    line(
                        "",
                        `The recommendation below keeps ${kept.join(", ")} anyway: at half weight the demand behind it still pays for the characters. Drop it if you think that demand goes before your next release does.`,
                        "muted"
                    )
                );
        }
    }

    let openPanel = null;
    const tile = (value, label, cls, tip, panel) => {
        const d = document.createElement("div");
        d.className = "fb-tile" + (cls ? ` ${cls}` : "") + (panel ? " openable" : "");
        if (tip) d.dataset.tip = tip;
        const v = document.createElement("div");
        v.className = "fb-tile-num";
        v.textContent = value;
        const t = document.createElement("div");
        t.className = "fb-tile-label";
        t.textContent = label;
        d.append(v, t);
        if (panel) {
            const more = document.createElement("span");
            more.className = "fb-tile-more";
            more.textContent = openPanel === panel.key ? "hide" : "show";
            d.appendChild(more);
            d.addEventListener("click", () => {
                openPanel = openPanel === panel.key ? null : panel.key;
                draw();
            });
        }
        return d;
    };

    function draw() {
        remember();
        drawWaste();
        const yourKeys = new Set(parseField(input.value));
        const yourCovers = input.value.trim() ? b.terms.filter((t) => holdsIn(t, yourKeys)).length : null;
        const yourPop = input.value.trim()
            ? b.terms.filter((t) => holdsIn(t, yourKeys)).reduce((n, t) => n + t.pop, 0)
            : null;

        const covered = b.terms.filter((t) => holdsIn(t, picked));
        const coveredPop = covered.reduce((n, t) => n + t.pop, 0);
        const chars = charsOf(picked);

        // What the title and subtitle carry on their own. The totals are for
        // all three fields pooled, so clearing the keyword field leaves 16 of
        // 73 standing and the tile looked stuck. Splitting out this field's own
        // contribution says which part of the number the words below bought.
        const free = b.terms.filter((t) => holdsIn(t, new Set()));
        const freePop = free.reduce((n, t) => n + t.pop, 0);

        stats.replaceChildren(
            tile(`${chars}/${FIELD_MAX}`, "characters", chars > FIELD_MAX ? "over" : ""),
            tile(
                `${covered.length}/${b.terms.length}`,
                "phrases covered",
                "",
                `${denominatorTip} Of those, title and subtitle cover ${free.length} on their own, so these hundred characters are winning the other ${covered.length - free.length}.`,
                { key: "phrases" }
            ),
            tile(coveredPop.toLocaleString("en-US"), `popularity of ${popTotal.toLocaleString("en-US")}`),
            yourPop == null
                ? tile("\u2014", "vs your keywords", "", "Paste your keywords above to compare")
                : // Which way round, spelled out. "+426 pop vs your field" was
                  // read as your field being ahead by 426, when it is the draft
                  // that is ahead — a sign convention is not an explanation.
                  tile(
                      (coveredPop - yourPop >= 0 ? "+" : "\u2212") +
                          Math.abs(coveredPop - yourPop).toLocaleString("en-US"),
                      // Names both sides. "+426 more popularity than your
                      // keywords" left it to the reader to guess what the 426
                      // belonged to.
                      coveredPop === yourPop
                          ? `the draft keywords tie yours (yours cover ${yourCovers})`
                          : coveredPop > yourPop
                            ? `more popularity in the draft keywords than in yours (yours cover ${yourCovers})`
                            : `less popularity in the draft keywords than in yours (yours cover ${yourCovers})`,
                      coveredPop >= yourPop ? "good" : "bad",
                      coveredPop > yourPop
                          ? "The draft keywords above are ahead. Copying them into App Store Connect is the gain."
                          : coveredPop < yourPop
                            ? "Your saved keywords are ahead of the draft keywords. Keep what you have, or edit the draft until it wins."
                            : "Both cover the same demand."
                  )
        );

        // The phrases behind the count, when a tile is open. Covered and
        // uncovered side by side, each with its demand, because "55 of 73" is a
        // claim about a particular 55 and a particular 18.
        panel.replaceChildren();
        panel.hidden = openPanel !== "phrases";
        if (openPanel === "phrases") {
            const column = (title, list, cls) => {
                const col = document.createElement("div");
                // The covered list runs four times as long as the others and is
                // marked so it can take the width and flow into two columns.
                col.className = "fb-panel-col" + (cls === "covered" ? " fb-panel-col-wide" : "");
                const h4 = document.createElement("p");
                h4.className = "fb-label";
                h4.textContent = `${title} (${list.length})`;
                col.appendChild(h4);
                const ul = document.createElement("ul");
                ul.className = "fb-panel-list";
                for (const t of [...list].sort((a, c) => c.pop - a.pop)) {
                    const li = document.createElement("li");
                    const name = document.createElement("span");
                    name.className = "fb-panel-name";
                    // The phrase carries the covered/uncovered colour; the chip
                    // keeps its own. Colouring the wrapper painted the badges
                    // green too, which threw away the one thing they encode.
                    const text = document.createElement("span");
                    text.className = "fb-panel-text";
                    text.textContent = t.kw;
                    name.appendChild(text);
                    // Who is searching it, same chip as the table below. A list
                    // of sixty phrases is a funnel, not a pile, and covering
                    // sixty feature phrases is a different listing from covering
                    // sixty symptom ones.
                    const chip = document.createElement("span");
                    chip.className = `badge kw-intent intent-${t.intent}`;
                    chip.textContent = intentLabel(t.intent);
                    tagIntent(chip, t.intent);
                    name.appendChild(chip);
                    if (t.note) {
                        const note = document.createElement("span");
                        note.className = "fb-panel-note";
                        note.textContent = t.note;
                        name.appendChild(note);
                    }
                    const val = document.createElement("span");
                    val.className = "gap-term-val";
                    val.textContent = `${t.pop} popularity`;
                    li.className = cls;
                    li.append(name, val);
                    ul.appendChild(li);
                }
                col.appendChild(ul);
                return col;
            };
            // The keywords a field cannot win, listed rather than counted. The
            // tile said "9 excluded" and named the categories, which is a
            // summary of a list the reader could reasonably want to check.
            const outOfScope = tracked
                .filter((kw) => !inBuilder.has(kw))
                .map((kw) => ({
                    kw,
                    pop: m.terms[kw].pop ?? 0,
                    intent: m.terms[kw].intent,
                    note: ["brand", "mine", "offtarget"].includes(m.terms[kw].intent)
                        ? null
                        : "no keyword field can express this phrase",
                }));
            panel.append(
                mix,
                column("Covered", covered, "covered"),
                column("Not covered", b.terms.filter((t) => !covered.includes(t)), "uncovered"),
                column("Not winnable with a keyword field", outOfScope, "outofscope")
            );
        }

        // Which kind of searcher the field is aimed at. Two fields can cover the
        // same count of phrases and reach different people.
        mix.replaceChildren();
        const byIntent = {};
        for (const t of covered) byIntent[t.intent] = (byIntent[t.intent] ?? 0) + t.pop;
        const mixTotal = Object.values(byIntent).reduce((a, c) => a + c, 0) || 1;
        const bar = document.createElement("div");
        bar.className = "fb-bar";
        const legend = document.createElement("div");
        legend.className = "fb-legend";
        for (const [intent, pop] of Object.entries(byIntent).sort((a, c) => c[1] - a[1])) {
            const seg = document.createElement("span");
            seg.className = `fb-seg intent-${intent}`;
            seg.style.width = `${(pop / mixTotal) * 100}%`;
            seg.dataset.tip = `${intentLabel(intent)}: ${pop} popularity`;
            bar.appendChild(seg);
            const key = document.createElement("span");
            key.className = "fb-key";
            const dot = document.createElement("span");
            dot.className = `fb-dot intent-${intent}`;
            key.append(dot, document.createTextNode(`${intentLabel(intent)} ${Math.round((pop / mixTotal) * 100)}%`));
            tagIntent(key, intent);
            legend.appendChild(key);
        }
        mix.append(bar, legend);

        // The chips are the field being built. Unlabelled they read as a tag
        // cloud, and the two things you need to know are that they are your
        // draft field and that clicking one removes it.
        const sameAs = (other) =>
            other.size === picked.size && [...picked].every((u) => other.has(u));
        const origin = sameAs(new Set(recommended))
            ? "the recommendation"
            : yourCovers != null && sameAs(yourKeys)
              ? "your App Store Connect field"
              : "edited by you";
        chipHead.textContent = `Draft keywords \u2014 ${origin}`;
        const built = [...picked].map(show).join(",");
        preview.replaceChildren();
        // An empty draft needs an empty state, not the word "empty" sitting
        // where the field's contents go — it read as a field containing that.
        const code = document.createElement("code");
        if (built) code.textContent = built;
        else {
            code.className = "fb-preview-blank";
            code.textContent =
                "No words yet. Add one below, or reset to the recommendation. Your title and subtitle still cover some phrases on their own.";
        }
        const count = document.createElement("span");
        count.className = "fb-preview-count" + (built.length > FIELD_MAX ? " over" : "");
        count.textContent = `${built.length}/${FIELD_MAX}`;
        preview.append(code, count);

        chipRow.replaceChildren();
        const useful = new Set(covered.flatMap((t) => t.alts.find((a) => a.every((u) => sat(u))) ?? []));
        // Wasted words first: they are the ones to reclaim characters from.
        const chipRank = (u) => (claimedKeys.has(u) ? 0 : useful.has(u) ? 2 : 1);
        for (const u of [...picked].sort((x, y) => chipRank(x) - chipRank(y))) {
            // Three states, not two. A word your title or subtitle already
            // carries looks idle here because no phrase needs it *from this
            // field* — but phrases do use it, and they rank. Calling that "not
            // completing any phrase" reads as "no phrase wants this word",
            // which is the opposite of true.
            const duplicate = claimedKeys.has(u);
            const chip = document.createElement("button");
            chip.className = "fb-chip" + (duplicate ? " dupe" : useful.has(u) ? "" : " idle");
            chip.dataset.tip = duplicate
                ? "Already in your title or subtitle. The phrases using it rank either way, so these characters buy nothing here."
                : useful.has(u)
                  ? "Carrying at least one covered phrase"
                  : "Not completing any phrase right now \u2014 dead characters unless something else joins it";
            chip.append(document.createTextNode(show(u)));
            const x = document.createElement("span");
            x.className = "fb-x";
            x.textContent = "\u00d7";
            chip.appendChild(x);
            chip.addEventListener("click", () => {
                picked.delete(u);
                draw();
            });
            chipRow.appendChild(chip);
        }

        // What one more word buys, given everything already picked, and which
        // phrases it would buy. This replaces the separate shopping list, which
        // ranked the same words against the saved listing instead of against
        // the field being edited, and so disagreed the moment you changed one.
        // Every uncovered phrase, keyed by the cheapest set of words that would
        // complete it. Keyed by the set rather than by single words, so a
        // phrase needing two is offered as a pair instead of vanishing — that
        // gap is what the separate "still uncovered" list existed to cover.
        const gain = new Map();
        for (const t of b.terms) {
            if (covered.includes(t)) continue;
            const need = t.alts
                .map((a) => a.filter((u) => !sat(u)))
                .sort((a, c) => a.length - c.length || a.join().length - c.join().length)[0];
            if (!need?.length) continue;
            const key = [...need].sort().join("\u0001");
            const entry = gain.get(key) ?? { pop: 0, terms: [], need };
            entry.pop += t.pop;
            entry.terms.push(t.kw);
            gain.set(key, entry);
        }
        suggest.replaceChildren();
        const sLabel = document.createElement("p");
        sLabel.className = "fb-label";
        sLabel.textContent = "Add these, unlock those";
        suggest.appendChild(sLabel);
        const ranked = [...gain.values()].sort((a, c) => c.pop - a.pop).slice(0, 10);
        if (!ranked.length) {
            suggest.appendChild(line("", "Every phrase this field can win is already covered.", "muted"));
        }
        const sUl = document.createElement("ul");
        sUl.className = "plan-gaps";
        for (const g of ranked) {
            const words = g.need.map(show);
            const cost = words.join(",").length + (picked.size ? 1 : 0);
            const add = document.createElement("button");
            add.className = "fb-add";
            add.textContent = `+ ${words.join(", ")}`;
            add.dataset.tip = `${chars + cost}/${FIELD_MAX} characters if added`;
            add.addEventListener("click", (e) => {
                e.stopPropagation();
                for (const u of g.need) picked.add(u);
                draw();
            });
            const n = document.createElement("span");
            n.className = "fb-add-gain";
            n.textContent = `${g.terms.length} phrase${g.terms.length === 1 ? "" : "s"} \u00b7 ${g.pop} popularity`;
            sUl.appendChild(expandable([add, n], g.terms));
        }
        suggest.appendChild(sUl);

        setSummary?.(
            `${covered.length} of ${b.terms.length} phrases covered \u00b7 ${chars}/${FIELD_MAX} characters`
        );
        refreshNote();
        // The chase card's advice depends on what the draft holds, so it has to
        // follow the draft. Without this its buttons offered words the draft
        // already had, and went silent about words it no longer did.
        onDraftChange?.();
    }

    const normalise = () => {
        const clean = tidy(input.value);
        if (clean !== input.value) input.value = clean;
        localStorage.setItem(storeKey, clean);
        savedRaw = clean;
        dirty = false;
        draw();
        onFieldSaved?.();
    };
    input.addEventListener("blur", normalise);
    input.addEventListener("paste", () => setTimeout(normalise, 0));

    let saveTimer = null;
    input.addEventListener("input", () => {
        dirty = true;
        refreshNote();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            localStorage.setItem(storeKey, input.value);
            savedRaw = input.value;
            dirty = false;
            // draw() rebuilds the numbers below and leaves this box alone, so
            // it is safe mid-sentence. onFieldSaved re-renders the whole
            // keyword section including this textarea, which took the caret
            // with it about a second into typing — that waits for blur.
            draw();
            // Long enough to sit through a pause mid-phrase. At 400ms the
            // numbers below flickered between keystrokes while a field was
            // still half-typed.
        }, 1200);
    });

    act("Reset to recommended", () => {
        picked = new Set(recommended);
        draw();
    });
    act("Load my keywords", () => {
        picked = new Set(parseField(tidy(input.value)));
        draw();
    });
    act("Clear", () => {
        picked = new Set();
        draw();
    });

    const chipHint = document.createElement("p");
    chipHint.className = "fb-hint";
    chipHint.textContent =
        "Click a word to drop it, or add one from the list below. When these cover more than your own keywords, copy them into App Store Connect.";
    draft.append(chipHead, preview, chipRow, chipHint, buttons);
    host.append(h, context, how, yours, waste, draft, stats, panel, suggest);
    setSummary = makeCollapsible(h, "builder", false);
    draw();
}

// A rival's own listing: subtitle, screenshots, and a way to go and look.
//
// One lookup call per app per open, memoised for the session. Nothing here is
// load-bearing: every piece is appended only once it arrives, so a blocked or
// slow call leaves the keyword lists below it exactly as they were.
const rivalCache = new Map();
function rivalHeader(id, cc, meta, plan) {
    const box = document.createElement("div");
    box.className = "rival-head";

    // Collected, not fetched: the subtitle is not in the lookup API, and the
    // product page that carries it sends no CORS header. Absent until the next
    // aso.mjs run has seen this app, which is why it renders only when present.
    const sub = plan?.markets?.[cc]?.rivals?.[id]?.subtitle;
    if (sub) {
        const p = document.createElement("p");
        p.className = "rival-sub";
        p.textContent = sub;
        box.appendChild(p);
    }

    const link = document.createElement("a");
    link.className = "rival-link";
    link.href = `https://apps.apple.com/${cc}/app/id${id}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `Open ${meta.name ?? "this app"} in the App Store →`;
    box.appendChild(link);

    const shelf = document.createElement("div");
    shelf.className = "rival-shots";
    box.appendChild(shelf);

    const key = `${id}:${cc}`;
    const load =
        rivalCache.get(key) ??
        fetch(`https://itunes.apple.com/lookup?id=${id}&country=${cc}`)
            .then((r) => r.json())
            .then((j) => j.results?.[0] ?? null)
            .catch(() => null);
    rivalCache.set(key, load);
    load.then((app) => {
        // Phone shots first, iPad only when there are no phone ones: an app
        // that ships both would otherwise show the same screens twice.
        const shots = (app?.screenshotUrls?.length ? app.screenshotUrls : app?.ipadScreenshotUrls) ?? [];
        if (!shots.length) {
            shelf.remove();
            return;
        }
        // All of them, not a sample. Apple allows ten and the apps worth
        // reading use most of them; the last few are where the feature claims
        // and the pricing screens live, which is the part worth seeing. The
        // strip scrolls, so the count costs layout nothing.
        for (const url of shots) {
            const a = document.createElement("a");
            a.href = url.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/626x0w.$1");
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            const img = document.createElement("img");
            img.className = "rival-shot";
            img.src = url;
            img.alt = "";
            // No loading="lazy" here, unlike the icons. These are built only
            // once a row is opened, so they are already deferred by intent, and
            // Chrome never fires the lazy load for an image inserted mid-click
            // inside a fresh row: the six stalled at complete=false forever,
            // showing six empty frames.
            a.appendChild(img);
            shelf.appendChild(a);
        }
    });
    return box;
}

// What the last release did to this market, written by scripts/release.mjs.
//
// The panel exists because the table below cannot answer the question on its
// own. Every rank in it moves whether or not you ship anything, so the number
// that matters is not how the changed phrases moved, it is how they moved
// against the phrases nothing touched. That comparison is the one line here
// the rest of the dashboard has no place for.
//
// It is also the only panel that says "too early" out loud. Apple re-indexes a
// changed keyword field over days, and a day-one glance at a rank column would
// otherwise read as a verdict on a release that has not been indexed yet.
// The newest release with both sides on record, and the newest date any
// release is known to have gone live. They differ for exactly as long as a
// release sits recorded but unsealed, which is the window where the charts can
// already mark it and the panel still has nothing to say.
const newestSealed = (releases) => [...(releases ?? [])].reverse().find((r) => r.effect) ?? null;
const releaseMarkDay = (releases) =>
    ([...(releases ?? [])].reverse().find((r) => r.at)?.at ?? "").slice(0, 10) || null;

const STAGE_NOTE = {
    indexing: "Apple is still re-indexing the new keyword field, so the rank numbers below cannot answer anything yet. Coverage can: it is arithmetic, and it was true the moment the release went live.",
    provisional: "Early. One noisy day can still swing these numbers, so treat a small move as no move.",
    settled: "Far enough out to read as a result.",
};

function renderRelease(host, cc, rel, kw) {
    host.replaceChildren();
    const e = rel?.effect;
    const m = e?.markets?.[cc];
    if (!m) {
        host.hidden = true;
        return;
    }
    host.hidden = false;
    const card = document.createElement("div");
    card.className = "plan-card release-card";

    const h = document.createElement("h3");
    h.textContent = `Since ${rel.version}`;
    const when = document.createElement("span");
    when.className = "release-when";
    const at = new Date(rel.at);
    when.textContent = `live ${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, day ${e.days}`;
    when.title = at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    h.appendChild(when);
    card.appendChild(h);
    card.appendChild(line("", STAGE_NOTE[e.stage] ?? "", "muted"));

    const pop = (term) => kw?.latest?.[cc]?.[term]?.pop ?? null;
    const withPop = (terms) =>
        terms
            .slice()
            .sort((a, b) => (pop(b) ?? 0) - (pop(a) ?? 0))
            .map((t) => (pop(t) ? `${t} (${pop(t)})` : t))
            .join(", ");

    const tiles = document.createElement("div");
    tiles.className = "fb-stats";
    const tile = (value, label, cls, tip) => {
        const d = document.createElement("div");
        d.className = "fb-tile" + (cls ? ` ${cls}` : "");
        if (tip) d.dataset.tip = tip;
        const v = document.createElement("div");
        v.className = "fb-tile-num";
        v.textContent = value;
        const t = document.createElement("div");
        t.className = "fb-tile-label";
        t.textContent = label;
        d.append(v, t);
        tiles.appendChild(d);
    };
    const sign = (n) => (n == null ? "—" : n > 0 ? `+${n}` : String(n));

    const cov = m.coverage;
    if (cov.after != null) {
        const d = cov.after - cov.before;
        tile(
            cov.comparable ? `${cov.before} → ${cov.after}` : `${cov.after}`,
            cov.comparable ? `of ${cov.of} phrases covered` : `of ${cov.of} covered, no before`,
            cov.comparable ? (d > 0 ? "good" : d < 0 ? "bad" : "") : "",
            cov.comparable
                ? "Phrases whose words the listing carries somewhere across title, subtitle and keyword field. Apple cannot rank you for a phrase you cannot build, so this is the ceiling the release moved. It is arithmetic, not a measurement: no waiting needed."
                : "This market had no keyword field on record before the release, so the before side was graded on title and subtitle alone and there is nothing honest to compare against. The current number is real; the change is not."
        );
    }
    tile(
        String(m.appeared.length),
        m.appeared.length === 1 ? "phrase newly ranked" : "phrases newly ranked",
        m.appeared.length ? "good" : "",
        "Phrases that were nowhere in the top 200 before the release and are now. A keyword change usually shows up like this rather than as a slow climb."
    );
    tile(
        cov.comparable ? sign(m.lift) : "n/a",
        "lift vs untouched",
        cov.comparable ? (m.lift > 0 ? "good" : m.lift < 0 ? "bad" : "") : "",
        cov.comparable
            ? `Places the phrases whose coverage changed gained beyond the phrases nothing touched, over the same days. The second half is the control: if both cohorts moved together, the market moved and the release did not. Changed ${m.target.n}, untouched ${m.control.n}.`
            : "Not available here. Without a keyword field on record before the release, almost every phrase counts as changed, which leaves no control group to measure against."
    );
    tile(
        m.shotsChanged === null ? "—" : m.shotsChanged ? "changed" : "same",
        "screenshots",
        "",
        (m.shotsChanged === null
            ? "Unknown: no screenshot set was on record before this release went live, and Apple serves only the current one. Recorded from now on, so the next release can answer it. "
            : "") +
            "Screenshots move conversion, and conversion is not measured anywhere in this repo. App Store Connect → Analytics → Impressions, Product Page Views and Conversion Rate by territory is the only place this can be judged."
    );
    card.appendChild(tiles);

    if (!cov.comparable)
        card.appendChild(
            line(
                "",
                "This market's keyword field was not written down until the release shipped, so the before side was graded on title and subtitle alone. Coverage and lift are not readable here. The rank moves below still are.",
                "warn"
            )
        );
    if (cov.comparable && cov.gained.length) card.appendChild(line("gained ", withPop(cov.gained)));
    if (cov.comparable && cov.lost.length) card.appendChild(line("lost ", withPop(cov.lost), "warn"));
    if (m.appeared.length)
        card.appendChild(
            line("newly ranked ", m.appeared.map((r) => `${r.kw} #${r.rank}`).join(", "), "good-line")
        );
    if (m.vanished.length)
        card.appendChild(
            line("dropped out ", m.vanished.map((r) => `${r.kw} (was #${r.was})`).join(", "), "warn")
        );

    // Movers are shown only once rank means something. During indexing they
    // are yesterday's noise wearing a release's name.
    if (e.stage !== "indexing" && m.movers.length) {
        const ul = document.createElement("ul");
        ul.className = "release-movers";
        for (const r of m.movers.slice(0, 6)) {
            const li = document.createElement("li");
            li.className = r.gain > 0 ? "up" : "down";
            li.textContent = `${sign(r.gain)}  ${r.kw}  #${r.before} → #${r.after}`;
            li.title = `${r.cohort === "target" ? "coverage changed in this release" : r.cohort === "control" ? "covered before and after, untouched" : "not covered either side"}`;
            ul.appendChild(li);
        }
        card.appendChild(ul);
    }

    if (m.noisy)
        card.appendChild(
            line(
                "",
                `${m.noisy} phrase${m.noisy === 1 ? "" : "s"} held out of these numbers: they already move more than 30 places on their own, within a day or between days, which is larger than anything a release would do to them.`,
                "muted"
            )
        );

    host.appendChild(card);
}

async function renderKeywords(kw, glossary = {}, plan = null, applePop = null, releases = []) {
    if (!kw?.latest || !Object.keys(kw.latest).length) return;
    // Two different questions about the same log. The panel needs a release
    // with both sides recorded, because there is nothing to compare until then.
    // The rule on the charts needs only a date, so it appears as soon as a
    // release is on the record, whether or not anyone has sealed it yet.
    const release = newestSealed(releases);
    const releaseDay = releaseMarkDay(releases);
    document.getElementById("keywords-section").hidden = false;
    if (kw.fetchedAt) {
        const updated = document.getElementById("kw-updated");
        updated.hidden = false;
        updated.textContent = `Keywords checked ${ago(kw.fetchedAt)}`;
        updated.title = new Date(kw.fetchedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }
    const tabs = document.getElementById("kw-tabs");
    const tbody = document.querySelector("#keywords tbody");
    const marketCcs = Object.keys(kw.latest);

    // Best rank ever and the previous day's rank, from the daily history.
    const bestRank = {};
    for (const row of kw.history) {
        for (const [cc, kws] of Object.entries(row.markets ?? {})) {
            for (const [term, v] of Object.entries(kws)) {
                if (v[0] == null) continue;
                // Daily minimum when the row has one (aggregated days), else
                // the single sample: Best means best ever measured.
                const dayBest = v[2] ?? v[0];
                bestRank[cc] ??= {};
                bestRank[cc][term] = Math.min(bestRank[cc][term] ?? Infinity, Math.round(dayBest));
            }
        }
    }
    const rankText = (r) => (r == null ? "—" : `#${r}`);

    // Top-5 lists hold bare app ids; names/icons resolve through the shared
    // apps map (legacy [id, name] pairs still supported).
    const appsMeta = kw.apps ?? {};
    const appEntry = (e) => {
        const id = Array.isArray(e) ? e[0] : e;
        const meta =
            appsMeta[id] ??
            (Array.isArray(e) ? { name: e[1] } : { name: id === "6751759381" ? "Snore Timeline" : `app ${id}` });
        return { id, ...meta };
    };
    const appLabel = ({ id, name, icon }) => {
        const frag = document.createDocumentFragment();
        if (icon) {
            const img = document.createElement("img");
            img.className = "kw-app-icon";
            img.src = icon;
            img.alt = "";
            img.loading = "lazy";
            frag.appendChild(img);
        }
        frag.appendChild(document.createTextNode(id === "6751759381" ? `${name} — you` : name));
        return frag;
    };

    // Sortable by demand or by rank; header click toggles direction.
    // Default: rank, best first (unranked keywords sink to the bottom).
    const sort = { key: "rank", dir: 1 };
    let currentCc = marketCcs[0];
    // Sticky across market switches: someone who cannot read the CN column
    // cannot read the JP one either, so asking twice would be busywork.
    let showEnglish = false;
    // Which tags the table is limited to. Intents are OR'd with each other;
    // gapOnly narrows whatever that leaves.
    const filter = { intents: new Set(), gapOnly: false };
    // Only worth offering where it would change something. An English market
    // has no glossed terms, so the button would sit there doing nothing.
    const translatable = (cc) => Object.keys(kw.latest[cc] ?? {}).some((t) => glossary[t]);

    const render = (cc) => {
        currentCc = cc;
        translate.hidden = !translatable(cc);
        translate.textContent = showEnglish ? "Show original" : "Show English";
        translate.classList.toggle("active", showEnglish);
        const refreshPlan = () =>
            renderPlan(document.getElementById("kw-plan"), cc, plan, () => render(currentCc));
        refreshPlan();
        renderRelease(document.getElementById("kw-release"), cc, release, kw);
        renderBuilder(document.getElementById("kw-builder"), cc, plan, () => render(currentCc), refreshPlan);
        tbody.replaceChildren();
        const rescored = rescoreFor(cc, plan);
        const shipped = plan?.markets?.[cc]?.terms ?? {};
        const aso = rescored ? { ...shipped, ...Object.fromEntries(rescored) } : shipped;
        // Whether the whole listing is on the record. Without a pasted field
        // the seed holds only title and subtitle, so a word absent from both
        // may be sitting in the keyword field and must not be reported as
        // missing from it.
        const fieldKnown = rescored != null || !plan?.markets?.[cc]?.coverage?.partial;
        const val = ([term, e]) =>
            sort.key === "rank" ? (e.rank ?? Infinity) : sort.key === "score" ? (aso[term]?.score ?? 0) : e.pop;
        const entries = Object.entries(kw.latest[cc])
            .filter(([term]) => {
                if (!filter.intents.size && !filter.gapOnly) return true;
                const t = aso[term];
                if (filter.intents.size && !filter.intents.has(t?.intent)) return false;
                if (filter.gapOnly && t?.covered !== false) return false;
                return true;
            })
            .sort((a, b) => (val(a) - val(b)) * sort.dir || (a[1].rank ?? 999) - (b[1].rank ?? 999));
        renderLegend(document.getElementById("kw-legend"), cc, plan, filter, () => render(currentCc), {
            shown: entries.length,
            total: Object.keys(kw.latest[cc]).length,
        });
        // Yesterday's row: the stable comparison baseline. Runs minutes apart
        // all diff against the same anchor, so manual runs can't wobble Δ.
        const curDate = (kw.fetchedAt ?? "").slice(0, 10);
        const prevDayRow = [...kw.history].reverse().find((r) => r.date < curDate) ?? null;

        for (const [term, cur] of entries) {
            const tr = document.createElement("tr");

            const tdKw = document.createElement("td");
            // Translated view leads with the meaning and keeps the original
            // alongside it: the term is still what Apple ranks and what you
            // would paste into the store, so it cannot be hidden outright.
            const gloss = showEnglish ? glossary[term] : null;
            tdKw.textContent = gloss ?? term;
            if (gloss) {
                const orig = document.createElement("span");
                orig.className = "kw-original";
                orig.textContent = term;
                tdKw.appendChild(orig);
            }
            // Intent, and whether the listing can rank for this at all. Both
            // are the same size chip on purpose: a term you have no words for
            // is not a worse ranking, it is a different problem.
            const asoTerm = aso[term];
            if (asoTerm) {
                const chip = document.createElement("span");
                chip.className = `badge kw-intent intent-${asoTerm.intent}`;
                chip.textContent = intentLabel(asoTerm.intent);
                tagIntent(chip, asoTerm.intent);
                tdKw.appendChild(chip);
                if (asoTerm.covered === false) {
                    const gap = document.createElement("span");
                    gap.className = "badge kw-gap";
                    gap.textContent = "words missing";
                    const gone = (asoTerm.missing ?? []).join(", ");
                    gap.dataset.tipTitle = "Listing coverage";
                    // Name the fields, because "your listing" is the thing the
                    // reader has to go and edit and it is three separate boxes
                    // in App Store Connect.
                    gap.dataset.tip = fieldKnown
                        ? `Missing from your title, subtitle or keyword field: ${gone}`
                        : `Missing from your title or subtitle: ${gone}. This market's keyword field is not recorded, so it may already be there.`;
                    tdKw.appendChild(gap);
                }
            }
            // Newly tracked terms have no history yet, so their delta columns
            // and sparkline read as blank rather than as "no movement". The
            // chip says which blanks are because the keyword is new.
            if (cur.since && (Date.now() - new Date(`${cur.since}T00:00:00Z`)) < NEW_KW_MS) {
                const chip = document.createElement("span");
                chip.className = "badge new kw-new";
                chip.textContent = "NEW";
                chip.title = `Tracking started ${cur.since}`;
                tdKw.appendChild(chip);
            }
            // Tap the keyword to expand who holds its top 5.
            if (cur.top?.length) {
                tdKw.classList.add("kw-name");
                tdKw.addEventListener("click", () => {
                    const next = tr.nextElementSibling;
                    if (next?.classList.contains("kw-detail")) {
                        next.remove();
                        return;
                    }
                    tbody.querySelectorAll(".kw-detail").forEach((d) => d.remove());
                    const det = document.createElement("tr");
                    det.className = "kw-detail";
                    const td = document.createElement("td");
                    td.colSpan = 9;
                    // The missing words lead, above the competitor list. The
                    // legend told people to tap the row for them and the row
                    // only ever opened the top ten, which made the instruction
                    // wrong rather than merely incomplete.
                    if (asoTerm?.covered === false) {
                        const gap = document.createElement("div");
                        gap.className = "kw-detail-gap";
                        const lead = document.createElement("span");
                        lead.textContent = fieldKnown
                            ? "Your title, subtitle and keyword field never say "
                            : "Your title and subtitle never say ";
                        gap.appendChild(lead);
                        (asoTerm.missing ?? []).forEach((w, i) => {
                            if (i) gap.appendChild(document.createTextNode(", "));
                            const code = document.createElement("code");
                            code.textContent = w;
                            gap.appendChild(code);
                        });
                        const tail = document.createElement("span");
                        // Was asoTerm.partial, which scoring never writes onto
                        // a term, so this read undefined and every market
                        // without a recorded keyword field got told its gap was
                        // the first thing to fix.
                        tail.textContent = !fieldKnown
                            ? " — judged on title and subtitle alone, since this market's keyword field is not recorded."
                            : cur.rank != null
                              ? ` — yet it ranks #${cur.rank}, which means Apple is matching on something other than your text. That ranking is not one you control.`
                              : " — which is the first thing to fix before expecting a position here.";
                        gap.appendChild(tail);
                        td.appendChild(gap);
                    }
                    const ol = document.createElement("ol");
                    cur.top.forEach((e) => {
                        const entry = appEntry(e);
                        const li = document.createElement("li");
                        li.appendChild(appLabel(entry));
                        if (entry.id === "6751759381") li.classList.add("you");
                        ol.appendChild(li);
                    });
                    td.appendChild(ol);
                    if (cur.rank != null && cur.rank > 5) {
                        const note = document.createElement("div");
                        note.className = "kw-detail-note";
                        note.textContent = `you: #${cur.rank}`;
                        td.appendChild(note);
                    }
                    det.appendChild(td);
                    tr.after(det);
                });
            }

            const tdPop = document.createElement("td");
            tdPop.className = "col-num";
            tdPop.textContent = cur.pop;
            // Where the number comes from, on the number rather than on the
            // keyword beside it. Pop is measured by how early a phrase appears
            // in Apple's autocomplete and how high it sits in that list, so the
            // prefix and position are the whole derivation.
            const band =
                cur.pop >= 70 ? "High demand." : cur.pop <= 5 ? "No measurable demand." : "";
            // Apple's own 5-100 index, on the rows that have one. Written only
            // where a value exists rather than as a column: it answers for a
            // handful of head terms per market, and an empty cell on all the
            // rest would be read as a zero rather than as a silence.
            const applePopVal = applePop?.markets?.[cc]?.terms?.[term]?.pop;
            const appleLine =
                applePopVal == null
                    ? ""
                    : ` Apple's own index puts it at ${applePopVal} of 100${
                          applePopVal > cur.pop ? ", higher than the reading here" : applePopVal < cur.pop ? ", lower than the reading here" : ", the same reading"
                      }.`;
            tdPop.dataset.tip =
                (cur.prefix
                    ? `${band} Popularity ${cur.pop} of 100: Apple suggests “${term}” once you have typed “${cur.prefix}”, ` +
                      `and it sits at position ${cur.pos} in that list. Earlier and higher means more people search it.`
                    : `${band || "Popularity 5 of 100."} Apple's autocomplete never suggests this phrase, so there is no demand signal for it.`) +
                appleLine;
            if (cur.pop <= 5) tdPop.classList.add("muted");
            else if (cur.pop >= 70) tdPop.classList.add("pop-hot");
            const prevDayVals = prevDayRow?.markets?.[cc]?.[term];
            // Pop baseline: the oldest sample in the rolling 24h window (i.e.
            // the value ~24 hours ago); yesterday's daily value fills in until
            // pop samples accumulate.
            const popSamples = (cur.recent ?? []).filter((s) => s[2] != null);
            const prevPop = popSamples.length > 1 ? popSamples[0][2] : prevDayVals?.[1];
            if (prevPop != null && prevPop !== cur.pop) {
                const pd = document.createElement("span");
                pd.className = `pop-delta ${cur.pop > prevPop ? "up" : "down"}`;
                pd.textContent = `${cur.pop > prevPop ? "▲" : "▼"}${Math.abs(cur.pop - prevPop)}`;
                tdPop.appendChild(pd);
            }
            // Tap the score for its arithmetic and, if it moved, a numeric
            // before/after decomposition. Mirrors popScore in the collector:
            // 5 base + up to 66.5 earliness + up to 28.5 list position.
            const popParts = (prefix, pos) => {
                if (!prefix) return null;
                const depth = term.length === 2 ? 1 : 1 - (prefix.length - 2) / (term.length - 2);
                const early = 0.7 * 95 * depth;
                const posPts = 0.3 * 95 * ((10 - (pos - 1)) / 10);
                return { early, posPts };
            };
            tdPop.classList.add("kw-pop");
            tdPop.addEventListener("click", (e) => {
                tooltip.innerHTML = "";
                const add = (text, cls) => {
                    const div = document.createElement("div");
                    div.className = cls;
                    div.textContent = text;
                    tooltip.appendChild(div);
                };
                add(`Demand ${cur.pop} / 100`, "tip-value");
                const now = popParts(cur.prefix, cur.pos);
                if (now) {
                    add(`5 base`, "tip-text");
                    add(
                        `+ ${now.early.toFixed(1)} of 66.5 · appears after “${cur.prefix}” (${cur.prefix.length} of ${term.length} letters typed — earlier is more)`,
                        "tip-text"
                    );
                    add(`+ ${now.posPts.toFixed(1)} of 28.5 · suggestion #${cur.pos} of 10`, "tip-text");
                } else {
                    add("Never appears in App Store autocomplete at any prefix — floor score of 5.", "tip-text");
                }
                // Intra-day flux stays visible even when it reverted.
                if (popSamples.length > 1) {
                    const vals = popSamples.map((s) => s[2]);
                    const lo = Math.min(...vals);
                    const hi = Math.max(...vals);
                    if (lo !== hi) add(`Last 24 h: ranged ${lo}–${hi}`, "tip-change");
                }
                const ds = cur.daySurf;
                if (ds && ds[0] != null && ds[0] !== cur.pop) {
                    const [dPop, dPrefix, dPos] = ds;
                    add(
                        `Yesterday ${dPop}: ${dPrefix ? `at “${dPrefix}” #${dPos}` : "not surfacing"}`,
                        "tip-change"
                    );
                    const then = popParts(dPrefix, dPos);
                    if (now && then) {
                        const dEarly = now.early - then.early;
                        const dPosP = now.posPts - then.posPts;
                        const bits = [];
                        if (Math.abs(dEarly) >= 0.5)
                            bits.push(`prefix “${dPrefix}” → “${cur.prefix}”: ${dEarly > 0 ? "+" : ""}${dEarly.toFixed(1)} pts`);
                        if (Math.abs(dPosP) >= 0.5)
                            bits.push(`position #${dPos} → #${cur.pos}: ${dPosP > 0 ? "+" : ""}${dPosP.toFixed(1)} pts`);
                        if (bits.length) add(`Change: ${bits.join(" · ")}`, "tip-change");
                    } else if (now && !then) {
                        add(`Change: started surfacing (+${(now.early + now.posPts).toFixed(1)} pts)`, "tip-change");
                    } else if (!now && then) {
                        add(`Change: stopped surfacing (−${(then.early + then.posPts).toFixed(1)} pts)`, "tip-change");
                    }
                } else if (prevPop != null && prevPop !== cur.pop) {
                    add(`Yesterday ${prevPop} — surfacing details start recording tomorrow.`, "tip-change");
                }
                placeTooltip(e);
            });

            const tdRank = document.createElement("td");
            tdRank.className = "col-num";
            tdRank.textContent = rankText(cur.rank);
            if (cur.rank == null) tdRank.classList.add("muted");
            else if (cur.rank <= 3) {
                tdRank.classList.add("rank-top");
                tdRank.title = "Top 3";
            } else if (cur.rank <= 10) {
                tdRank.classList.add("rank-page1");
                tdRank.title = "Top 10";
            }

            const tdDelta = document.createElement("td");
            tdDelta.className = "col-num";
            // Δ: where you stand now against yesterday's close — the exact
            // quantities the sparkline's last segment draws, so the arrow can
            // never contradict the trend line. Today's stored close is the
            // latest rank while the day is still running, so this reads as the
            // live move rather than a partial day's mean.
            const todayRow = kw.history.at(-1);
            const todayClose =
                (todayRow?.date === curDate ? todayRow.markets?.[cc]?.[term]?.[0] : null) ?? cur.rank;
            let baseClose = prevDayVals?.[0];
            if (baseClose == null) baseClose = (cur.recent ?? []).find(([, r]) => r != null)?.[1];
            const span = document.createElement("span");
            span.className = "delta";
            if (todayClose == null || baseClose == null) {
                span.classList.add("flat");
                span.textContent = "—";
            } else {
                const diff = Math.round(todayClose - baseClose); // positive = slipped
                if (diff === 0) {
                    span.classList.add("flat");
                    span.textContent = "=";
                    span.title = `Steady vs yesterday's close (#${baseClose})`;
                } else if (diff < 0) {
                    span.classList.add("up");
                    span.textContent = `▲${-diff}`;
                    span.title = `Yesterday's close #${baseClose} → now #${todayClose}`;
                } else {
                    span.classList.add("down");
                    span.textContent = `▼${diff}`;
                    span.title = `Yesterday's close #${baseClose} → now #${todayClose}`;
                }
            }
            tdDelta.appendChild(span);

            const rangeText = (ranks) => {
                if (!ranks.length) return "—";
                const min = Math.min(...ranks);
                const max = Math.max(...ranks);
                return min === max ? `#${min}` : `#${min}–${max}`;
            };

            const td24 = document.createElement("td");
            td24.className = "col-num muted";
            td24.textContent = rangeText((cur.recent ?? []).map(([, r]) => r).filter((r) => r != null));
            td24.title = "Rank range over the last 24 hours of runs";

            const td7d = document.createElement("td");
            td7d.className = "col-num muted";
            const week = [];
            for (const hrow of kw.history.slice(-7)) {
                const v = hrow.markets?.[cc]?.[term];
                if (!v || v[0] == null) continue;
                week.push(Math.round(v[2] ?? v[0]), Math.round(v[3] ?? v[0]));
            }
            td7d.textContent = rangeText(week);
            td7d.title = "Rank range over the last 7 days";

            // Best ever, and how far the current rank sits from it. The gap is
            // never positive — best is a running minimum, so today can only
            // match it or trail it — which is why sitting at your best shows a
            // tick rather than a "0" that reads like a measurement.
            const tdBest = document.createElement("td");
            tdBest.className = "col-num muted";
            const best = bestRank[cc]?.[term];
            tdBest.textContent = rankText(best);
            if (best != null && cur.rank != null) {
                const gap = cur.rank - best;
                const off = document.createElement("span");
                off.className = "best-gap";
                if (gap === 0) {
                    off.textContent = "✓";
                    off.classList.add("at-best");
                    off.title = "Currently at its best rank";
                } else {
                    off.textContent = `−${gap}`;
                    off.title = `${gap} behind its best of #${best}`;
                }
                tdBest.appendChild(off);
            }

            const tdSpark = document.createElement("td");
            tdSpark.className = "col-spark";
            const points = kw.history
                .slice(-SPARK_DAYS)
                .map((row) => {
                    const v = row.markets?.[cc]?.[term];
                    if (!v || v[0] == null) return null;
                    // Closing rank, with the day's range beside it so a quiet
                    // day and a day that swung 34 places do not read alike.
                    const [close, , min, max] = v;
                    const range = min != null && max != null && min !== max ? ` (${min}–${max})` : "";
                    return { date: row.date, count: -close, label: `#${close}${range}` };
                })
                .filter(Boolean);
            tdSpark.appendChild(
                sparkline(points, `${term} rank, last 30 days`, (v) => `#${-v}`, 4, releaseDay)
            );

            // Priority sits beside demand deliberately: the two disagree
            // often, and the disagreement is the whole point of the column.
            const tdScore = document.createElement("td");
            tdScore.className = "col-num kw-score";
            if (asoTerm) {
                tdScore.textContent = asoTerm.score;
                tdScore.dataset.tip = asoTerm.why;
                if (asoTerm.score === 0) tdScore.classList.add("muted");
                else if (asoTerm.score >= 70) tdScore.classList.add("score-hot");
            } else {
                tdScore.textContent = "—";
                tdScore.classList.add("muted");
            }

            tr.append(tdKw, tdPop, tdScore, tdRank, tdDelta, td24, td7d, tdBest, tdSpark);
            tbody.appendChild(tr);
        }

        // The table is the tallest thing on the page by a wide margin — 82 rows
        // for one market. It opens at a screenful, the way the ratings table
        // already hides its unrated storefronts, and the choice sticks.
        const CAP = 25;
        const rows = [...tbody.querySelectorAll("tr")];
        if (rows.length > CAP) {
            let all = localStorage.getItem("asoAllRows") === "1";
            const applyCap = () => {
                rows.forEach((tr, i) => (tr.hidden = !all && i >= CAP));
                more.textContent = all
                    ? `Show the top ${CAP} only`
                    : `Show all ${rows.length} keywords`;
            };
            const moreTr = document.createElement("tr");
            moreTr.className = "kw-more-row";
            const moreTd = document.createElement("td");
            moreTd.colSpan = 9;
            const more = document.createElement("button");
            more.className = "plan-copy";
            more.addEventListener("click", () => {
                all = !all;
                localStorage.setItem("asoAllRows", all ? "1" : "0");
                applyCap();
            });
            moreTd.appendChild(more);
            moreTr.appendChild(moreTd);
            applyCap();
            tbody.appendChild(moreTr);
        }

        // Aggregate: how many of this market's tracked keywords each app
        // holds a top-5 slot on. Your own share is part of the picture.
        const comp = document.getElementById("kw-competitors");
        comp.replaceChildren();
        const slots = new Map();
        let measured = 0;
        // Rows collected before the top-ten change carry only five ids, and a
        // top-10 count derived from those would just restate the top-5 one.
        // The column shows "—" until a run has filled the deeper data in.
        let deep = false;
        for (const [term, cur] of Object.entries(kw.latest[cc])) {
            if (!cur.top?.length) continue;
            measured++;
            if (cur.top.length > 5) deep = true;
            cur.top.forEach((raw, i) => {
                const { id } = appEntry(raw);
                const e = slots.get(id) ?? { top5: 0, top10: 0, firsts: 0, at: [] };
                if (i < 5) e.top5++;
                e.top10++;
                if (i === 0) e.firsts++;
                // Which keywords, not just how many. The counts say a rival owns
                // 27 of your phrases; the list says which 27, which is the part
                // you can act on.
                e.at.push({ kw: term, place: i + 1, pop: cur.pop ?? 0 });
                slots.set(id, e);
            });
        }
        if (measured) {
            comp.hidden = false;
            const head = document.createElement("div");
            head.className = "recent-label";
            head.textContent = "Who owns these keywords";
            comp.appendChild(head);
            queueMicrotask(() =>
                // Open by default: it is context you read alongside the table
                // rather than a task you go looking for.
                makeCollapsible(head, "competitors", true)(`${top.length} apps in this market`)
            );
            const note = document.createElement("p");
            note.className = "kw-comp-note";
            note.textContent =
                "Age is from each app's first App Store release. Ratings and score are " +
                "for this storefront only, so they change as you switch markets.";
            comp.appendChild(note);

            // Ranked by top-five ownership, with top-ten breaking ties: the
            // five is still the column that says who is actually winning.
            const top = [...slots.entries()]
                .sort((a, b) => b[1].top5 - a[1].top5 || b[1].top10 - a[1].top10)
                .slice(0, 8);
            // Your own share always shows, even from outside the top 8.
            if (!top.some(([id]) => id === "6751759381")) {
                top.push(["6751759381", slots.get("6751759381") ?? { top5: 0, top10: 0, firsts: 0, at: [] }]);
            }

            const table = document.createElement("table");
            table.className = "kw-comp-table";
            const thead = document.createElement("thead");
            const hrow = document.createElement("tr");
            for (const [label, cls, tip] of [
                ["App", ""],
                ["Top-5", "col-num", "Tracked keywords where this app is one of the first five results"],
                ["Top-10", "col-num", "Tracked keywords where this app is anywhere on page one, the first ten results"],
                ["#1", "col-num", "Tracked keywords where this app is the very first result"],
                ["Released", "col-num"],
                ["Age", "col-num"],
                ["Ratings", "col-num", "Lifetime ratings in this storefront"],
                ["Δ 1d", "col-num", "Ratings gained in this storefront since the last reading at least a day old, with the equivalent in users at ~75 per rating. Blank where there is no earlier reading yet."],
                ["Users", "col-num", "Estimated lifetime users in this storefront: ratings × 75, the rule of thumb for how many users it takes to produce one rating"],
                ["Score", "col-num"],
            ]) {
                const th = document.createElement("th");
                th.textContent = label;
                if (cls) th.className = cls;
                if (tip) th.dataset.tip = tip;
                // No storefront label or switcher here: the panel sits directly
                // under the market tabs now, so the selected tab is in view
                // while reading it and a second selector would just compete.
                hrow.appendChild(th);
            }
            thead.appendChild(hrow);
            table.appendChild(thead);

            const tb = document.createElement("tbody");
            const perCc = kw.stats?.[cc] ?? {};
            // Growth baseline: the newest logged snapshot at least twenty hours
            // back, so the figure reads as a day's gain rather than whatever
            // happened since the last run a few hours ago. The collector keeps
            // one snapshot per six hours across thirty, so there is normally
            // one sitting in the window, and the 36-hour cap keeps the span
            // near the day the column claims.
            //
            // Measured against the reading it is subtracted from, not against
            // the wall clock: `perCc` is frozen at kw.fetchedAt, so aging the
            // window on Date.now() slid it forward while the current values
            // stood still, and the span quietly shrank by however long ago the
            // last run was. A page opened six hours after a run was labelling
            // eighteen hours of growth "Δ 1D".
            const readingAt = new Date(kw.fetchedAt).getTime();
            const baseline = (kw.statsLog ?? [])
                .filter((s) => {
                    const age = readingAt - new Date(s.at);
                    return age >= 20 * 3600e3 && age <= 36 * 3600e3;
                })
                .pop();
            const basePerCc = baseline?.markets?.[cc] ?? {};

            // Market sizing on the ~75-users-per-rating rule of thumb, summed
            // over the apps in this table only — the actual keyword-owning
            // competitors. The full tracked set (~150 apps) includes giants
            // like Calm that brush against broad sleep keywords without
            // competing here; Calm alone gains more users a day than this
            // whole niche, so including them buried the addressable number.
            const USERS_PER_RATING = 75;
            const fmtUsers = (n) =>
                n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
                : n >= 1e4 ? `${Math.round(n / 1e3)}k`
                : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
                : `${Math.round(n)}`;
            const tableIds = top.map(([id]) => id);
            const marketRatings = tableIds.reduce((s, id) => s + (perCc[id]?.[0] ?? 0), 0);
            let marketNewRatings = 0;
            let baselineSeen = false;
            for (const id of tableIds) {
                const r = perCc[id]?.[0];
                const was = basePerCc[id];
                if (r != null && was != null) {
                    baselineSeen = true;
                    marketNewRatings += r - was;
                }
            }

            for (const [id, e] of top) {
                const row = document.createElement("tr");
                if (id === "6751759381") row.className = "you";
                const meta = appEntry(id);

                // Tap the row for the keywords behind the counts, best placing
                // first. Building it on demand keeps the table itself cheap.
                if (e.at?.length) {
                    row.classList.add("kw-comp-open");
                    row.addEventListener("click", () => {
                        const next = row.nextElementSibling;
                        if (next?.classList.contains("kw-comp-detail")) {
                            next.remove();
                            return;
                        }
                        tb.querySelectorAll(".kw-comp-detail").forEach((d) => d.remove());
                        const det = document.createElement("tr");
                        det.className = "kw-comp-detail";
                        const td = document.createElement("td");
                        td.colSpan = 10;
                        // What the listing itself says, above the keywords it
                        // wins. The counts tell you a rival owns your phrases;
                        // the subtitle and the screenshots are the part you can
                        // read and answer.
                        //
                        // Screenshots and the store link come from the lookup
                        // API on open rather than from a data file: the browser
                        // may call it (it sends access-control-allow-origin: *),
                        // ten URLs per app across eleven markets is a file this
                        // repo does not need to carry, and a screenshot fetched
                        // now cannot be a month stale. The subtitle is the one
                        // piece that must be collected, since it has never been
                        // in the API and the product page blocks the browser.
                        td.appendChild(rivalHeader(id, cc, meta, plan));
                        const firsts = e.at.filter((a) => a.place === 1);
                        const rest = e.at.filter((a) => a.place > 1);
                        const group = (label, list) => {
                            if (!list.length) return;
                            const h = document.createElement("div");
                            h.className = "kw-comp-detail-head";
                            h.textContent = label;
                            const ul = document.createElement("ul");
                            ul.className = "kw-comp-kws";
                            for (const a of [...list].sort((x, y) => y.pop - x.pop)) {
                                const li = document.createElement("li");
                                const name = document.createElement("code");
                                name.textContent = a.kw;
                                const at = document.createElement("span");
                                at.textContent = `#${a.place} · ${a.pop} pop`;
                                li.append(name, at);
                                ul.appendChild(li);
                            }
                            td.append(h, ul);
                        };
                        group(`#1 for ${firsts.length} keyword${firsts.length === 1 ? "" : "s"}`, firsts);
                        group(`Also on page one for ${rest.length}`, rest);
                        det.appendChild(td);
                        row.after(det);
                    });
                }

                const tdName = document.createElement("td");
                tdName.className = "kw-comp-name";
                tdName.appendChild(appLabel(meta));

                // Share alongside the count, because the denominator moves with
                // the market: 51/82 and 51/65 are not the same performance, and
                // comparing markets by the raw count quietly misleads.
                const share = (n) => {
                    const s = document.createElement("span");
                    s.className = "kw-comp-pct";
                    s.textContent = `${Math.round((n / measured) * 100)}%`;
                    return s;
                };

                const tdSlots = document.createElement("td");
                tdSlots.className = "col-num";
                tdSlots.append(`${e.top5}/${measured}`, share(e.top5));

                const tdSlots10 = document.createElement("td");
                tdSlots10.className = "col-num muted";
                if (deep) tdSlots10.append(`${e.top10}/${measured}`, share(e.top10));
                else tdSlots10.textContent = "—";

                const tdFirst = document.createElement("td");
                tdFirst.className = "col-num muted";
                tdFirst.textContent = e.firsts ? `${e.firsts}×` : "—";

                const tdRel = document.createElement("td");
                tdRel.className = "col-num muted";
                tdRel.textContent = meta.released ? monthYear(meta.released) : "—";

                const tdAge = document.createElement("td");
                tdAge.className = "col-num";
                tdAge.textContent = meta.released ? ageYears(meta.released) : "—";

                const [ratings, score] = perCc[id] ?? [];
                const tdRatings = document.createElement("td");
                tdRatings.className = "col-num muted";
                tdRatings.textContent = ratings == null ? "—" : ratings.toLocaleString();

                // How fast they are gaining. Blank until a snapshot old enough
                // to measure against exists, which is the first day after this
                // shipped, and blank for an app that was not in the top lists
                // back then so has no earlier reading.
                const wasRatings = basePerCc[id];
                const tdGrowth = document.createElement("td");
                tdGrowth.className = "col-num";
                if (ratings == null || wasRatings == null) {
                    tdGrowth.textContent = "—";
                    tdGrowth.classList.add("muted");
                } else {
                    const d = ratings - wasRatings;
                    tdGrowth.textContent = d > 0 ? `+${fmt(d)}` : d < 0 ? fmt(d) : "0";
                    tdGrowth.classList.add("kw-comp-growth", d > 0 ? "up" : d < 0 ? "down" : "flat");
                    if (d) {
                        // The same delta in users, inline: this is the number
                        // the ratings movement actually stands for.
                        const users = document.createElement("span");
                        users.className = "kw-comp-pct";
                        users.textContent = `(${d > 0 ? "+" : "−"}${fmtUsers(Math.abs(d) * USERS_PER_RATING)})`;
                        tdGrowth.appendChild(users);
                        tdGrowth.title = `≈ ${d > 0 ? "+" : "−"}${fmt(Math.abs(d) * USERS_PER_RATING)} users/day`;
                    }
                }

                const tdUsers = document.createElement("td");
                tdUsers.className = "col-num muted";
                tdUsers.textContent = ratings == null ? "—" : `~${fmtUsers(ratings * USERS_PER_RATING)}`;

                const tdScore = document.createElement("td");
                tdScore.className = "col-num muted";
                tdScore.textContent = score ? score.toFixed(2) : "—";

                row.append(tdName, tdSlots, tdSlots10, tdFirst, tdRel, tdAge, tdRatings, tdGrowth, tdUsers, tdScore);
                tb.appendChild(row);
            }
            table.appendChild(tb);
            // This table is rebuilt on every market switch, so its headers need
            // wiring each time; the page-level pass only sees the static ones.
            wireHeaderTips(table);
            // Only the table pans sideways; the heading and note stay put.
            const scroller = document.createElement("div");
            scroller.className = "kw-comp-scroll";
            scroller.appendChild(table);
            comp.appendChild(scroller);

            // The headline number the columns build up to: how big this
            // storefront's tracked market is and how fast it is growing, on
            // the same ~75-users-per-rating assumption the columns use.
            if (marketRatings) {
                const sizing = document.createElement("p");
                sizing.className = "kw-comp-note";
                const apps = tableIds.filter((id) => perCc[id]?.[0] != null).length;
                sizing.textContent =
                    `Market size, estimated at ~75 users per rating: ~${fmtUsers(marketRatings * USERS_PER_RATING)} ` +
                    `lifetime users across the ${apps} apps above` +
                    (baselineSeen && marketNewRatings > 0
                        ? `, currently gaining ~${fmtUsers(marketNewRatings * USERS_PER_RATING)} new users a day.`
                        : ".");
                comp.appendChild(sizing);
            }
        }
    };

    // One entry point for both switchers (tabs here, the dropdown on the
    // competitor table's App header), so the active tab can never disagree
    // with what the tables show. The translate button carries no data-cc and
    // loses its active class in the sweep; render() restores it right after.
    const setMarket = (cc) => {
        tabs.querySelectorAll(".kw-tab").forEach((b) => b.classList.toggle("active", b.dataset.cc === cc));
        render(cc);
    };

    for (const cc of marketCcs) {
        const btn = document.createElement("button");
        btn.className = "kw-tab";
        btn.dataset.cc = cc;
        btn.textContent = `${flag(cc)} ${cc.toUpperCase()}`;
        btn.addEventListener("click", () => setMarket(cc));
        tabs.appendChild(btn);
    }
    tabs.firstChild.classList.add("active");

    const translate = document.createElement("button");
    translate.className = "kw-tab kw-translate";
    translate.addEventListener("click", () => {
        showEnglish = !showEnglish;
        render(currentCc);
    });
    tabs.appendChild(translate);

    const sortHeaders = document.querySelectorAll("#keywords th[data-sort]");
    const updateArrows = () => {
        for (const th of sortHeaders) {
            th.querySelector(".sort-arrow").textContent =
                th.dataset.sort === sort.key ? (sort.dir === 1 ? "▲" : "▼") : "";
        }
    };
    for (const th of sortHeaders) {
        th.addEventListener("click", () => {
            const key = th.dataset.sort;
            if (sort.key === key) sort.dir *= -1;
            else Object.assign(sort, { key, dir: key === "pop" ? -1 : 1 });
            updateArrows();
            render(currentCc);
        });
    }
    updateArrows();
    render(marketCcs[0]);

    // Movement log: notable rank moves and newly appearing suggestions. Only
    // the newest 30 here — keyword-log.html carries the full history. Events
    // are sharded by month, so this walks back from the newest shard and stops
    // as soon as it has enough, which is one fetch except in a month's first
    // days. The index carries the full total so the link can name it without
    // loading anything else.
    const { events: recentKwEvents, total: kwEventTotal } = await loadRecentKwEvents(30);
    const kwEvents = recentKwEvents.slice(-30).reverse();
    if (kwEventTotal > kwEvents.length) {
        const link = document.getElementById("kw-log-link");
        if (link) {
            link.hidden = false;
            link.querySelector("a").textContent =
                `See all ${kwEventTotal.toLocaleString()} changes →`;
        }
    }
    if (kwEvents.length) {
        const list = document.getElementById("kw-events");
        list.hidden = false;
        for (const ev of kwEvents) {
            const li = document.createElement("li");
            const when = new Date(ev.at);
            const day = `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toLocaleTimeString(undefined, { timeStyle: "short" })}`;
            const time = `<span class="event-time">${day}</span>`;
            if (ev.type === "hint") {
                li.innerHTML = `${time}${flag(ev.cc)} Apple now suggests <strong></strong> under “${ev.prefix}”<span class="badge new">NEW</span>`;
                li.querySelector("strong").textContent = `“${ev.term}”`;
            } else if (ev.type === "autotrack") {
                li.className = "first-rating";
                li.innerHTML = `${time}${flag(ev.cc)} now tracking <strong></strong><span class="badge new">AUTO</span>`;
                li.querySelector("strong").textContent = `“${ev.term}”`;
            } else {
                const better = ev.to != null && (ev.from == null || ev.to < ev.from);
                li.className = better ? "first-rating" : "";
                li.innerHTML = `${time}${flag(ev.cc)} <strong></strong> ${rankText(ev.from)} → ${rankText(ev.to)}`;
                li.querySelector("strong").textContent = ev.kw;
            }
            list.appendChild(li);
        }
    }
}

async function main() {
    const meta = document.getElementById("meta");
    let latest, history, events, reviews, kwData, hist, glossary, pageviews, plan, applePop, releases;
    try {
        // no-cache: revalidate every load so the data files can't come from
        // differently-aged browser caches and contradict each other.
        [latest, history, events, reviews, kwData, hist, glossary, pageviews, plan, applePop, releases] = await Promise.all([
            fetch("data/latest.json", { cache: "no-cache" }).then((r) => r.json()),
            fetch("data/history.json", { cache: "no-cache" }).then((r) => r.json()),
            fetch("data/events.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => []),
            fetch("data/reviews.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => []),
            fetch("data/keywords.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
            fetch("data/histograms.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
            // Hand-written and rarely edited, so it can come from cache; an
            // absent file just means the table stays in its original language.
            fetch("data/glossary.json").then((r) => r.json()).catch(() => ({})),
            fetch("data/pageviews.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
            // Intent, coverage and priority, written by scripts/aso.mjs. Absent
            // on a repo that has never run it, which only costs the extra
            // column and the panel above the table.
            fetch("data/aso.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
            // Apple's own popularity index, written by hand runs of
            // scripts/popularity.mjs. Absent on a repo that has never set the
            // cookie up, and even where it exists it answers for a handful of
            // head terms, so it annotates the tooltip and nothing more.
            fetch("data/popularity.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
            // The release log, written by scripts/release.mjs. Absent until a
            // release has been recorded, which costs the panel and the rule on
            // the charts and nothing else.
            fetch("data/releases.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => []),
        ]);
    } catch {
        meta.textContent = "No data yet. Run the collect workflow once to seed data/.";
        return;
    }

    const releaseDay = releaseMarkDay(releases);

    // Website traffic: daily visitors from GoatCounter, collected by
    // scripts/pageviews.mjs on the same hourly run as ratings. The section
    // stays hidden until the first day of data exists, so the dashboard looks
    // unchanged if the token is missing or the counter is ever removed.
    if (pageviews?.days && Object.keys(pageviews.days).length) {
        const days = Object.entries(pageviews.days)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date));
        const byDate = Object.fromEntries(days.map((d) => [d.date, d.count]));
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
        const sum = (n) => days.slice(-n).reduce((s, d) => s + d.count, 0);
        const tile = (num, label) => {
            const div = document.createElement("div");
            div.className = "traffic-tile";
            const val = document.createElement("div");
            val.className = "traffic-num";
            val.textContent = fmt(num);
            const lab = document.createElement("div");
            lab.className = "traffic-label";
            lab.textContent = label;
            div.append(val, lab);
            return div;
        };
        const trafficRow = document.getElementById("traffic-row");
        trafficRow.append(
            tile(byDate[today] ?? 0, "today so far"),
            tile(byDate[yesterday] ?? 0, "yesterday"),
            tile(sum(7), "last 7 days"),
            tile(sum(30), "last 30 days")
        );
        // Unhide before drawing: the chart is sized from clientWidth, which is
        // 0 while the section is display:none.
        document.getElementById("traffic-section").hidden = false;

        const chartWrap = document.getElementById("traffic-chart");
        const last30 = days.slice(-30);
        const drawChart = () => {
            const w = chartWrap.clientWidth;
            if (w && last30.length) {
                chartWrap.replaceChildren(
                    sparkline(last30, "Daily website visitors, last 30 days", fmt, 0, null, {
                        w,
                        h: 200,
                        axes: true,
                    })
                );
            }
        };
        drawChart();
        let chartW = chartWrap.clientWidth;
        new ResizeObserver(() => {
            if (chartWrap.clientWidth !== chartW) {
                chartW = chartWrap.clientWidth;
                drawChart();
            }
        }).observe(chartWrap);

        // Country split: a rolling 30-day snapshot from the collector.
        // GoatCounter's location counts run on a different unit than the
        // visitor totals in the tiles (they sum higher), so the panel shows
        // each country's share rather than a number that would visibly
        // disagree with "last 30 days". Stays hidden when the data file
        // predates the per-country collector.
        const ranked = Object.entries(pageviews.countries?.counts ?? {}).sort(
            (a, b) => b[1] - a[1]
        );
        const grand = ranked.reduce((s, [, n]) => s + n, 0);
        const pct = (n) => (n / grand >= 0.005 ? `${Math.round((n / grand) * 100)}%` : "<1%");
        if (ranked.length) {
            const most = ranked[0][1];
            const list = document.getElementById("traffic-countries");
            for (const [cc, n] of ranked.slice(0, 8)) {
                const row = document.createElement("div");
                row.className = "traffic-country";
                const top = document.createElement("div");
                top.className = "tc-top";
                const name = document.createElement("span");
                name.textContent =
                    cc === "??" ? "🌐 Unknown" : `${flag(cc)} ${regionNames.of(cc.toUpperCase())}`;
                const count = document.createElement("span");
                count.className = "tc-count";
                count.textContent = pct(n);
                top.append(name, count);
                const track = document.createElement("div");
                track.className = "tc-track";
                const fill = document.createElement("div");
                fill.className = "tc-fill";
                fill.style.width = `${Math.max(2, (n / most) * 100)}%`;
                track.appendChild(fill);
                row.append(top, track);
                list.appendChild(row);
            }
            if (ranked.length > 8) {
                const rest = ranked.slice(8);
                const more = document.createElement("div");
                more.className = "tc-more";
                more.textContent = `+${rest.length} more · ${pct(rest.reduce((s, [, n]) => s + n, 0))}`;
                list.appendChild(more);
            }
            document.getElementById("traffic-countries-wrap").hidden = false;
        }
    }

    const tbody = document.querySelector("#ratings tbody");

    // Rolling last-24h gains from the event log — the same window the Latest
    // strip sums, so the two can never disagree. (Day-row diffs bucket by UTC
    // date and made a morning rating vanish from the column at UTC midnight.)
    const gain24 = {};
    for (const ev of events) {
        if ((ev.type === "delta" || ev.type === "first") && Date.now() - new Date(ev.at) <= 864e5) {
            gain24[ev.cc] = (gain24[ev.cc] ?? 0) + (ev.to - (ev.from ?? 0));
        }
    }
    const entries = Object.entries(latest.countries).map(([cc, cur]) => ({
        cc,
        cur,
        delta: cur ? (gain24[cc] ?? 0) : null,
    }));

    entries.sort(
        (a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || (b.cur?.count ?? -1) - (a.cur?.count ?? -1)
    );

    const total = globalTotal(latest);
    const totalDelta = Object.values(gain24).reduce((s, n) => s + n, 0);
    const rated_ = Object.values(latest.countries).filter((c) => c?.count > 0 && c.avg != null);
    const worldStars = rated_.reduce((s, c) => s + c.count * c.avg, 0);
    const worldCount = rated_.reduce((s, c) => s + c.count, 0);
    const worldAvg = worldCount ? worldStars / worldCount : null;
    const worldCounts = hist
        ? Object.values(hist.countries).reduce(
              (sum, h) => sum.map((n, i) => n + (h.counts[i] ?? 0)),
              [0, 0, 0, 0, 0]
          )
        : null;
    const gains = starGains(events);
    const worldGains = {};
    for (const g of Object.values(gains))
        for (const [s, n] of Object.entries(g)) worldGains[s] = (worldGains[s] ?? 0) + n;
    tbody.appendChild(
        row({
            name: "🌍 Worldwide",
            sub: "all storefronts",
            total,
            delta: totalDelta,
            avg: worldAvg,
            mix: mixCell(worldCounts, worldGains),
            to5: fiveStarsToFiveExact(worldCounts) ?? fiveStarsToFive(worldCount, worldAvg),
            spark: sparkline(seriesFor(history, null), "Global total, last 30 days", fmt, 0, releaseDay),
            isTotal: true,
        })
    );

    const rated = entries.filter((e) => (e.cur?.count ?? 0) > 0 || e.delta);
    const unrated = entries.filter((e) => !rated.includes(e));
    const rowByCc = new Map();

    const render = ({ cc, cur, delta }, hidden) => {
        const countryName = regionNames.of(cc.toUpperCase());
        const tr = row({
            name: `${flag(cc)} ${countryName}`,
            sub: cc.toUpperCase(),
            title: countryName,
            total: cur?.count ?? null,
            delta,
            avg: cur?.avg ?? null,
            mix: mixCell(hist?.countries[cc]?.counts, gains[cc]),
            to5: fiveStarsToFiveExact(hist?.countries[cc]?.counts) ?? fiveStarsToFive(cur?.count, cur?.avg),
            spark: sparkline(seriesFor(history, cc), `${countryName} ratings, last 30 days`, fmt, 0, releaseDay),
        });
        tr.hidden = hidden;
        if (hidden) tr.classList.add("unrated");
        rowByCc.set(cc, tr);
        tbody.appendChild(tr);
    };

    rated.forEach((e) => render(e, false));

    if (unrated.length) {
        const toggleTr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 7;
        const btn = document.createElement("button");
        btn.className = "toggle-unrated";
        btn.textContent = `Show ${unrated.length} storefronts with no ratings yet`;
        btn.addEventListener("click", () => {
            const show = btn.dataset.open !== "1";
            btn.dataset.open = show ? "1" : "";
            btn.textContent = show
                ? "Hide unrated storefronts"
                : `Show ${unrated.length} storefronts with no ratings yet`;
            tbody.querySelectorAll("tr.unrated").forEach((tr) => (tr.hidden = !show));
        });
        td.appendChild(btn);
        toggleTr.appendChild(td);
        tbody.appendChild(toggleTr);
        unrated.forEach((e) => render(e, true));
    }

    // Shown only now it has rows. The markup ships with the header row already
    // written, so leaving it visible meant a bare strip of column headings sat
    // at the top of the page for as long as the fetches took, then jumped as
    // the body filled in underneath it.
    document.getElementById("ratings-wrap").hidden = false;

    renderRecent(events);
    // Not awaited: the table paints synchronously and only the movement strip
    // waits on its shard, so blocking the rest of the page on that fetch would
    // buy nothing. Caught so a missing shard cannot surface as an unhandled
    // rejection and take the reviews below it down with it.
    renderKeywords(kwData, glossary, plan, applePop, releases).catch((err) => console.warn("keyword section:", err));
    renderWeekReviews(reviews);
    renderReviews(reviews);
    renderEvents(history, events);

    const stamp = (iso) =>
        new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    meta.textContent = "";
    const addMeta = (text, title) => {
        const span = document.createElement("span");
        span.className = "meta-item";
        span.textContent = text;
        if (title) span.title = title;
        meta.appendChild(span);
    };
    addMeta(`Ratings in ${rated.length} of ${entries.filter((e) => e.cur).length} storefronts`);
    addMeta(`Last change ${ago(latest.fetchedAt)}`, stamp(latest.fetchedAt));

    // Collector health, in the one place anyone actually looks. Alerting only
    // fires on failure, which means a healthy system is invisible and you
    // cannot tell "fine" from "nobody has checked". These bounds mirror
    // scripts/check-freshness.mjs; if one moves, move the other.
    // One heartbeat file per collector: they shared one until two writers on a
    // single line of compact JSON gave the collectors a rebase conflict.
    const HEALTH = { ratings: 12, keywords: 16 };
    const health = Object.fromEntries(
        await Promise.all(
            Object.keys(HEALTH).map(async (key) => [
                key,
                await fetch(`data/status-${key}.json`, { cache: "no-cache" })
                    .then((r) => r.json())
                    .catch(() => null),
            ])
        )
    );
    const stale = [];
    for (const [key, hours] of Object.entries(HEALTH)) {
        const at = health[key]?.at;
        if (!at) { stale.push(`${key}: never reported`); continue; }
        const age = (Date.now() - new Date(at)) / 3600e3;
        if (age > hours) stale.push(`${key}: ${age.toFixed(0)}h ago`);
    }
    const failing = Object.entries(health)
        .filter(([, v]) => (v?.failed ?? v?.rankFailures ?? 0) > 0)
        .map(([k, v]) => `${k}: ${v.failed ?? v.rankFailures} fetch failures`);
    if (health.ratings?.at) {
        addMeta(`Checked ${ago(health.ratings.at)}`, stamp(health.ratings.at));
    }
    if (stale.length || failing.length) {
        const warn = document.createElement("span");
        warn.className = "meta-item meta-warn";
        warn.textContent = stale.length ? "Collector stalled" : "Collector erroring";
        warn.title = [...stale, ...failing].join("\n");
        meta.appendChild(warn);
    }

    // Live recheck: query Apple directly from the browser for the 20 biggest
    // storefronts. Display-only; the hourly workflow records changes officially.
    const checkRow = document.createElement("div");
    checkRow.id = "check-row";
    const checkBtn = document.createElement("button");
    checkBtn.className = "check-now";
    checkBtn.textContent = "Quick check (live view)";
    checkBtn.title = "Queries Apple from this browser and shows changes immediately; nothing is saved";
    checkRow.appendChild(checkBtn);
    meta.insertAdjacentElement("afterend", checkRow);

    // Owner-only: dispatch the collector workflow so the check is recorded,
    // not just displayed. The fine-grained token (this repo, Actions
    // read/write) lives only in this browser's localStorage — never in the
    // repo, where it would be public and auto-revoked.
    const recordBtn = document.createElement("button");
    recordBtn.className = "check-now";
    recordBtn.textContent = "Full update (~3 min)";
    recordBtn.title = "Runs the ratings + keywords collectors on GitHub and saves the results (owner token required)";
    checkRow.appendChild(recordBtn);

    // Live progress for a dispatched update. The old flow said "queued" and
    // then nothing for three minutes, so the only question worth asking — is
    // it working or is it stuck? — had to be answered in the Actions tab.
    // This polls the same API that tab does and reports each stage in its own
    // units: the ratings run's current step, how many keyword shards have
    // landed, and whether the deploy that publishes them has run.
    const runPanel = document.createElement("div");
    runPanel.id = "run-panel";
    runPanel.hidden = true;
    checkRow.insertAdjacentElement("afterend", runPanel);

    const REPO = "mtuck063/snore-ratings-tracker";
    const POLL_MS = 5000;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const ghGet = async (path, token) => {
        const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
            cache: "no-store",
        });
        // A token that expires mid-run has to surface as itself, not as a
        // stage that mysteriously stops advancing.
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error("token"), { auth: true });
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        return res.json();
    };

    const STAGES = [
        { key: "ratings", label: "Ratings", wf: "collect.yml" },
        { key: "keywords", label: "Keywords", wf: "keywords.yml" },
        { key: "pages", label: "Publish" },
    ];

    const since = (iso) => {
        const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    };

    const renderRunPanel = (state) => {
        runPanel.hidden = false;
        runPanel.textContent = "";
        for (const { key, label } of STAGES) {
            const st = state[key];
            // Linked to its run when there is one, so "why did that fail" is
            // one tap away rather than a hunt through the Actions tab.
            const row = document.createElement(st.url ? "a" : "div");
            row.className = `run-row ${st.state}`;
            if (st.url) {
                row.href = st.url;
                row.target = "_blank";
                row.rel = "noopener";
            }
            const dot = document.createElement("span");
            dot.className = "run-dot";
            const name = document.createElement("span");
            name.className = "run-name";
            name.textContent = label;
            const detail = document.createElement("span");
            detail.className = "run-detail";
            detail.textContent = st.detail;
            const time = document.createElement("span");
            time.className = "run-time";
            time.textContent = st.at ? since(st.at) : "";
            row.append(dot, name, detail, time);
            runPanel.appendChild(row);
        }
    };

    // The ratings run is a single job, so its steps are the progress bar:
    // "Fetch ratings" is the long one and "Commit data" means the numbers
    // are already in the repo.
    const ratingsStage = (run, jobs) => {
        if (!run) return { state: "wait", detail: "queuing…" };
        const base = { at: run.run_started_at ?? run.created_at, url: run.html_url };
        if (run.status === "completed")
            return { ...base, state: run.conclusion === "success" ? "done" : "fail",
                detail: run.conclusion === "success" ? "collected 175 storefronts" : `run ${run.conclusion}` };
        const steps = jobs[0]?.steps ?? [];
        if (!steps.length) return { ...base, state: "wait", detail: "waiting for a runner" };
        const active = steps.find((s) => s.status === "in_progress");
        const done = steps.filter((s) => s.status === "completed").length;
        return { ...base, state: "run",
            detail: `${active ? active.name : "step"} · ${Math.min(done + 1, steps.length)} of ${steps.length}` };
    };

    // The keyword run fans out one job per market shard, which is exactly the
    // unit worth counting: "9 of 16" answers how far along it is, where a
    // percentage of nothing in particular would not.
    const keywordsStage = (run, jobs) => {
        if (!run) return { state: "wait", detail: "queuing…" };
        const base = { at: run.run_started_at ?? run.created_at, url: run.html_url };
        if (run.status === "completed")
            return { ...base, state: run.conclusion === "success" ? "done" : "fail",
                detail: run.conclusion === "success" ? "merged and pushed" : `run ${run.conclusion}` };
        const shards = jobs.filter((j) => j.name.startsWith("collect"));
        const merge = jobs.find((j) => j.name === "merge");
        if (merge?.status === "in_progress") return { ...base, state: "run", detail: "merging the partials" };
        if (shards.length) {
            const done = shards.filter((j) => j.status === "completed").length;
            const running = shards.filter((j) => j.status === "in_progress").length;
            const tail = running ? `, ${running} collecting` : done === shards.length ? ", merge queued" : "";
            return { ...base, state: "run", detail: `${done}/${shards.length} market shards${tail}` };
        }
        if (jobs.some((j) => j.name === "plan")) return { ...base, state: "run", detail: "planning the job list" };
        return { ...base, state: "wait", detail: "waiting for a runner" };
    };

    // Publishing is a separate workflow that only exists once a collector has
    // pushed, so it can only be found after the fact — and a run that changed
    // nothing pushes nothing, which is a finished update, not a stuck one.
    const pagesStage = (run, settledFor) => {
        if (!run)
            return settledFor > 45
                ? { state: "done", detail: "nothing changed, nothing to publish" }
                : { state: "wait", detail: "waits for the collectors to push" };
        const base = { at: run.run_started_at ?? run.created_at, url: run.html_url };
        if (run.status !== "completed") return { ...base, state: "run", detail: "deploying the site" };
        return { ...base, state: run.conclusion === "success" ? "done" : "fail",
            detail: run.conclusion === "success" ? "published" : `deploy ${run.conclusion}` };
    };

    // Polls until every stage has settled, then reloads: the whole point of
    // the button is the data on this page, and the page is showing the copy
    // that was current before the run.
    async function trackUpdate(token, dispatchedAt) {
        const state = {
            ratings: { state: "wait", detail: "queuing…" },
            keywords: { state: "wait", detail: "queuing…" },
            pages: { state: "wait", detail: "waits for the collectors to push" },
        };
        const runs = { ratings: null, keywords: null, pages: null };
        renderRunPanel(state);
        // Separate from the poll: elapsed times should tick like a clock, not
        // jump five seconds at a time.
        const ticker = setInterval(() => renderRunPanel(state), 1000);
        const deadline = Date.now() + 12 * 60e3;
        let bothDoneAt = null;
        try {
            while (Date.now() < deadline) {
                for (const { key, wf } of STAGES.filter((s) => s.wf)) {
                    if (!runs[key]) {
                        const list = await ghGet(
                            `/actions/workflows/${wf}/runs?event=workflow_dispatch&per_page=5`, token);
                        runs[key] = (list.workflow_runs ?? [])
                            .find((r) => new Date(r.created_at) >= dispatchedAt) ?? null;
                    } else if (runs[key].status !== "completed") {
                        runs[key] = await ghGet(`/actions/runs/${runs[key].id}`, token);
                    }
                    const jobs = runs[key]
                        ? ((await ghGet(`/actions/runs/${runs[key].id}/jobs?per_page=100`, token)).jobs ?? [])
                        : [];
                    state[key] = key === "ratings"
                        ? ratingsStage(runs[key], jobs)
                        : keywordsStage(runs[key], jobs);
                }
                const collectorsDone = ["ratings", "keywords"]
                    .every((k) => runs[k]?.status === "completed");
                if (collectorsDone && !bothDoneAt) bothDoneAt = Date.now();
                if (!runs.pages || runs.pages.status !== "completed") {
                    const list = await ghGet(`/actions/runs?per_page=20`, token);
                    runs.pages = (list.workflow_runs ?? []).find(
                        (r) => r.name === "pages build and deployment" && new Date(r.created_at) >= dispatchedAt
                    ) ?? runs.pages;
                }
                state.pages = pagesStage(runs.pages, bothDoneAt ? (Date.now() - bothDoneAt) / 1000 : 0);
                renderRunPanel(state);

                if (Object.values(state).some((s) => s.state === "fail")) return "failed";
                if (Object.values(state).every((s) => s.state === "done")) return "done";
                await nap(POLL_MS);
            }
            return "timeout";
        } finally {
            clearInterval(ticker);
            renderRunPanel(state);
        }
    }

    recordBtn.addEventListener("click", async () => {
        let token = localStorage.getItem("ghDispatchToken");
        if (!token) {
            token = prompt("GitHub token")?.trim();
            if (!token) return;
            localStorage.setItem("ghDispatchToken", token);
        }
        recordBtn.disabled = true;
        recordBtn.textContent = "Queuing runs…";
        // Slack for clock skew between this browser and GitHub: a run created
        // a second "before" the click is still our run.
        const dispatchedAt = new Date(Date.now() - 45000);
        try {
            // Ratings and keywords both; they share a concurrency group, so
            // the runs queue politely rather than fighting over the push.
            const results = await Promise.all(
                ["collect.yml", "keywords.yml"].map((wf) =>
                    fetch(
                        `https://api.github.com/repos/mtuck063/snore-ratings-tracker/actions/workflows/${wf}/dispatches`,
                        {
                            method: "POST",
                            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
                            body: JSON.stringify({ ref: "main" }),
                        }
                    )
                )
            );
            const ok = results.filter((r) => r.status === 204).length;
            if (ok === results.length) {
                recordBtn.textContent = "Update running…";
                const outcome = await trackUpdate(token, dispatchedAt);
                if (outcome === "done") {
                    recordBtn.textContent = "Updated — reloading…";
                    setTimeout(() => location.reload(), 1500);
                    return;
                }
                recordBtn.textContent = outcome === "failed"
                    ? "A stage failed — tap a row for the log"
                    : "Still running after 12 min — tap a row for the log";
            } else if (results.some((r) => r.status === 401 || r.status === 403)) {
                localStorage.removeItem("ghDispatchToken");
                recordBtn.textContent = "Token rejected — tap to enter a new one";
            } else {
                recordBtn.textContent = `${ok}/2 queued (GitHub said ${results.map((r) => r.status).join("/")}) — tap to retry`;
            }
        } catch (err) {
            // The dispatch itself reports auth failure by status code; the
            // tracker, which runs long enough to outlive a token, throws.
            if (err?.auth) {
                localStorage.removeItem("ghDispatchToken");
                recordBtn.textContent = "Token expired mid-run — the runs carry on regardless";
            } else {
                recordBtn.textContent = "Network error — tap to retry";
            }
        }
        setTimeout(() => {
            recordBtn.disabled = false;
            recordBtn.textContent = "Full update (~3 min)";
        }, 8000);
    });
    checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true;
        const top = entries.filter((e) => e.cur);
        const changes = [];
        let done = 0;
        let failed = 0;
        checkBtn.textContent = `Checking 0/${top.length}…`;

        // Review feeds allow CORS, so sweep them too: any review the tracker
        // hasn't stored yet shows up in the week row immediately.
        const knownIds = new Set(reviews.map((r) => r.id));
        const newReviews = [];
        const reviewSweep = Promise.all(
            entries
                .filter((e) => (e.cur?.count ?? 0) > 0)
                .map(async ({ cc }) => {
                    try {
                        const res = await fetch(
                            `https://itunes.apple.com/${cc}/rss/customerreviews/id=6751759381/sortby=mostrecent/json`
                        );
                        let feedEntries = (await res.json()).feed?.entry ?? [];
                        if (!Array.isArray(feedEntries)) feedEntries = [feedEntries];
                        for (const e of feedEntries) {
                            if (e?.id?.label && e?.["im:rating"]?.label && !knownIds.has(e.id.label)) {
                                knownIds.add(e.id.label);
                                newReviews.push({
                                    id: e.id.label,
                                    cc,
                                    rating: Number(e["im:rating"].label),
                                    title: e.title?.label ?? "",
                                    body: e.content?.label ?? "",
                                    author: e.author?.name?.label ?? "",
                                    version: e["im:version"]?.label ?? "",
                                    date: e.updated?.label ?? null,
                                });
                            }
                        }
                    } catch {
                        /* feed flake; the workflow records reviews officially */
                    }
                })
        );

        // All at once: a one-tap burst is fine for the API, and any
        // storefront it throttles simply doesn't answer this round.
        await Promise.all(
            top.map(async ({ cc, cur }) => {
                try {
                    const app = (await jsonpLookup(cc))?.results?.[0];
                    if (app) {
                        const liveCount = app.userRatingCount ?? 0;
                        if (liveCount !== cur.count) {
                            const d = liveCount - cur.count;
                            changes.push({ cc, d });
                            const tr = rowByCc.get(cc);
                            if (tr) {
                                tr.children[1].textContent = fmt(liveCount);
                                if (app.averageUserRating != null) tr.children[3].textContent = app.averageUserRating.toFixed(1);
                                tr.classList.add("changed");
                                tr.hidden = false; // reveal a first rating hiding in the unrated fold
                            }
                        }
                    }
                } catch {
                    failed++;
                }
                done++;
                checkBtn.textContent = `Checking ${done}/${top.length}…`;
            })
        );
        await reviewSweep;
        if (newReviews.length) {
            document.getElementById("week-reviews").hidden = false;
            const row = document.getElementById("week-row");
            for (const r of newReviews) row.prepend(reviewCard(r, true));
        }
        // Rises and drops are different news and used to read identically: a
        // row of flags where "+1" and "-1" differ by one glyph, next to a
        // promise to record it that only holds for a rise. A drop waits 48
        // hours for confirmation (collect.mjs), and most of them are Apple's
        // CDN serving a stale count rather than a rating anyone lost, so it is
        // spelled out in words and coloured instead of being left to a sign.
        const rises = changes.filter((c) => c.d > 0);
        const drops = changes.filter((c) => c.d < 0);
        const named = (c) => `${flag(c.cc)} ${regionNames.of(c.cc.toUpperCase()) ?? c.cc.toUpperCase()}`;
        checkBtn.textContent = "";
        const say = (text, cls) => {
            const span = document.createElement("span");
            if (cls) span.className = cls;
            span.textContent = text;
            checkBtn.appendChild(span);
        };
        if (rises.length) {
            say(`Live: ${rises.map((c) => `${flag(c.cc)} +${c.d}`).join(" · ")} — recorded officially next hourly run`);
        }
        if (drops.length) {
            const list = drops.map((c) => `${named(c)} −${Math.abs(c.d)}`).join(" · ");
            say(rises.length ? " · " : "");
            say(`Lost a rating: ${list}`, "drop");
            say(" — held 48 h before it counts, Apple often reports these in error");
        }
        if (!changes.length) say(`No changes right now (${top.length} storefronts checked)`);
        if (newReviews.length) say(` · ${newReviews.length} new review${newReviews.length === 1 ? "" : "s"} below`);
        if (failed) say(` · ${failed} didn't answer, tap again in a minute`);
        setTimeout(() => {
            checkBtn.disabled = false;
            if (!changes.length && !failed && !newReviews.length) checkBtn.textContent = "Quick check (live view)";
        }, 5000);
    });

    // "Checked" used to come from the public Actions API here, because a run
    // that finds no changes commits nothing. status.json answers the same
    // question from our own origin, so it needs no cross-origin request and
    // cannot be hidden by GitHub's 60-per-hour unauthenticated rate limit.
}

main();

// Returning to a tab that has sat in the background (Safari restores it
// without reloading): if the page is stale, reload so the visible data,
// "Data updated", and "Page loaded" times are all current.
const loadedAt = Date.now();
const STALE_MS = 10 * 60e3;
function refreshIfStale() {
    if (document.visibilityState === "visible" && Date.now() - loadedAt > STALE_MS) {
        location.reload();
    }
}
document.addEventListener("visibilitychange", refreshIfStale);
window.addEventListener("pageshow", (e) => {
    if (e.persisted) refreshIfStale();
});
