const SPARK_DAYS = 30;
const SPARK_W = 100;
const SPARK_H = 28;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const tooltip = document.getElementById("tooltip");

const flag = (cc) =>
    String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));

const fmt = (n) => n.toLocaleString("en-US");

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

function sparkline(points, label, fmtVal = fmt) {
    // points: [{date, count}] oldest→newest, nulls already dropped
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", SPARK_W);
    svg.setAttribute("height", SPARK_H);
    svg.setAttribute("class", "spark");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    if (points.length < 2) return svg;

    const counts = points.map((p) => p.count);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const pad = 3;
    const x = (i) => pad + (i / (points.length - 1)) * (SPARK_W - pad * 2);
    const y = (v) =>
        max === min
            ? SPARK_H / 2
            : SPARK_H - pad - ((v - min) / (max - min)) * (SPARK_H - pad * 2);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "spark-line");
    path.setAttribute("d", points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(""));
    svg.appendChild(path);

    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "spark-dot");
    dot.setAttribute("r", 3);
    dot.setAttribute("cx", x(points.length - 1));
    dot.setAttribute("cy", y(counts.at(-1)));
    svg.appendChild(dot);

    const hover = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hover.setAttribute("class", "spark-hover");
    hover.setAttribute("r", 4);
    hover.setAttribute("visibility", "hidden");
    svg.appendChild(hover);

    svg.addEventListener("pointermove", (e) => {
        const rect = svg.getBoundingClientRect();
        const rel = (e.clientX - rect.left - pad) / (SPARK_W - pad * 2);
        const i = Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1))));
        hover.setAttribute("cx", x(i));
        hover.setAttribute("cy", y(points[i].count));
        hover.setAttribute("visibility", "visible");
        tooltip.innerHTML = `<span class="tip-value">${fmtVal(points[i].count)}</span> <span class="tip-date">${points[i].date}</span>`;
        tooltip.hidden = false;
        const tw = tooltip.offsetWidth;
        tooltip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - tw - 8)}px`;
        tooltip.style.top = `${e.clientY - 36}px`;
    });
    svg.addEventListener("pointerleave", () => {
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

// Histogram counts [5★..1★] as "133·9·2", trailing zeros trimmed (but 2★/1★
// shown whenever present).
function starMix(counts) {
    if (!counts) return null;
    let last = counts.length - 1;
    while (last > 2 && counts[last] === 0) last--;
    return counts.slice(0, last + 1).join("·");
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
    tdMix.textContent = mix ?? "—";
    if (!mix) tdMix.classList.add("muted");
    else tdMix.title = "Ratings by stars, 5★ first";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    const label = document.createElement("span");
    label.className = "recent-label";
    label.textContent = "Latest";
    box.appendChild(label);

    // Rolling gains from the event log: new ratings only, so storefronts
    // merely added to tracking don't inflate the totals.
    const gainSince = (ms) =>
        events
            .filter((ev) => (ev.type === "delta" || ev.type === "first") && Date.now() - new Date(ev.at) <= ms)
            .reduce((sum, ev) => sum + (ev.to - (ev.from ?? 0)), 0);
    for (const [labelText, ms] of [["last 24 h", 864e5], ["last 7 days", 7 * 864e5]]) {
        const gain = gainSince(ms);
        const chip = document.createElement("span");
        chip.className = "recent-item recent-sum";
        chip.innerHTML = `<strong${gain < 0 ? ' class="down"' : ""}>${gain >= 0 ? "+" : "−"}${fmt(Math.abs(gain))}</strong> <span class="recent-time">${labelText}</span>`;
        box.appendChild(chip);
    }

    const today = new Date().toLocaleDateString();
    for (const ev of events.slice(-3).reverse()) {
        const when = new Date(ev.at);
        const timeText =
            when.toLocaleDateString() === today
                ? when.toLocaleTimeString(undefined, { timeStyle: "short" })
                : when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const item = document.createElement("a");
        item.className = "recent-item";
        item.href = ev.type === "review" ? "#reviews-section" : "#events-section";
        const name = `${flag(ev.cc)} ${regionNames.of(ev.cc.toUpperCase())}`;
        const d = (ev.to ?? 0) - (ev.from ?? 0);
        const change =
            ev.type === "review"
                ? `★${ev.rating} review`
                : ev.type === "tracked"
                  ? "now tracked"
                  : (d > 0 ? `+${fmt(d)}` : `−${fmt(Math.abs(d))}`) + (ev.stars ? ` ★${ev.stars}` : "");
        item.innerHTML = `${name} <strong${d < 0 && ev.type !== "review" ? ' class="down"' : ""}>${change}</strong> <span class="recent-time">${timeText}</span>`;
        box.appendChild(item);
    }
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
}

// Keyword rankings: one table, tab per market. Rank sparklines plot -rank so
// an improving keyword trends upward like every other chart on the page.
function renderKeywords(kw) {
    if (!kw?.latest || !Object.keys(kw.latest).length) return;
    document.getElementById("keywords-section").hidden = false;
    if (kw.fetchedAt) {
        const updated = document.getElementById("kw-updated");
        updated.hidden = false;
        updated.textContent = `Keywords last checked: ${new Date(kw.fetchedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
    }
    const tabs = document.getElementById("kw-tabs");
    const tbody = document.querySelector("#keywords tbody");
    const marketCcs = Object.keys(kw.latest);

    // Best rank ever and the previous day's rank, from the daily history.
    const bestRank = {};
    for (const row of kw.history) {
        for (const [cc, kws] of Object.entries(row.markets ?? {})) {
            for (const [term, [rank]] of Object.entries(kws)) {
                if (rank == null) continue;
                bestRank[cc] ??= {};
                bestRank[cc][term] = Math.min(bestRank[cc][term] ?? Infinity, rank);
            }
        }
    }
    const prevRow = kw.history.length >= 2 ? kw.history.at(-2) : null;

    const rankText = (r) => (r == null ? "—" : `#${r}`);

    // Sortable by demand or by rank; header click toggles direction.
    // Default: rank, best first (unranked keywords sink to the bottom).
    const sort = { key: "rank", dir: 1 };
    let currentCc = marketCcs[0];

    const render = (cc) => {
        currentCc = cc;
        tbody.replaceChildren();
        const val = ([, e]) => (sort.key === "rank" ? (e.rank ?? Infinity) : e.pop);
        const entries = Object.entries(kw.latest[cc]).sort(
            (a, b) => (val(a) - val(b)) * sort.dir || (a[1].rank ?? 999) - (b[1].rank ?? 999)
        );
        for (const [term, cur] of entries) {
            const tr = document.createElement("tr");

            const tdKw = document.createElement("td");
            tdKw.textContent = term;
            if (cur.prefix) tdKw.title = `Suggested at “${cur.prefix}”, position ${cur.pos}`;
            // The money keywords: real demand, ranked, but not yet top 3.
            if (cur.pop >= 60 && cur.rank != null && cur.rank > 3) {
                const badge = document.createElement("span");
                badge.className = "kw-badge";
                badge.textContent = "TARGET";
                badge.title = "High demand and not yet top 3: the most leverage per rank gained";
                tdKw.appendChild(badge);
            }

            const tdPop = document.createElement("td");
            tdPop.className = "col-num";
            tdPop.textContent = cur.pop;
            if (cur.pop <= 5) tdPop.classList.add("muted");

            const tdRank = document.createElement("td");
            tdRank.className = "col-num";
            tdRank.textContent = rankText(cur.rank);
            if (cur.rank == null) tdRank.classList.add("muted");
            else if (cur.rank <= 3) tdRank.classList.add("at-five");

            const tdDelta = document.createElement("td");
            tdDelta.className = "col-num";
            // Day-over-day when a previous day exists; otherwise fall back to
            // the earliest rank event of the last 24h so intra-day movement
            // (and day one) still shows a delta consistent with the log below.
            let prevRank = prevRow?.markets?.[cc]?.[term]?.[0];
            if (prevRank === undefined) {
                const dayAgo = Date.now() - 864e5;
                const ev = (kw.events ?? []).find(
                    (e) => e.type === "rank" && e.cc === cc && e.kw === term && new Date(e.at) >= dayAgo
                );
                if (ev) prevRank = ev.from;
            }
            const span = document.createElement("span");
            span.className = "delta";
            if (prevRank == null || cur.rank == null || prevRank === cur.rank) {
                span.classList.add("flat");
                span.textContent = "—";
            } else if (cur.rank < prevRank) {
                span.classList.add("up");
                span.textContent = `▲${prevRank - cur.rank}`;
            } else {
                span.classList.add("down");
                span.textContent = `▼${cur.rank - prevRank}`;
            }
            tdDelta.appendChild(span);

            const tdBest = document.createElement("td");
            tdBest.className = "col-num muted";
            tdBest.textContent = rankText(bestRank[cc]?.[term]);

            const tdSpark = document.createElement("td");
            tdSpark.className = "col-spark";
            const points = kw.history
                .slice(-SPARK_DAYS)
                .map((row) => ({ date: row.date, count: row.markets?.[cc]?.[term]?.[0] }))
                .filter((p) => p.count != null)
                .map((p) => ({ date: p.date, count: -p.count }));
            tdSpark.appendChild(sparkline(points, `${term} rank, last 30 days`, (v) => `#${-v}`));

            tr.append(tdKw, tdPop, tdRank, tdDelta, tdBest, tdSpark);
            tbody.appendChild(tr);
        }
    };

    for (const cc of marketCcs) {
        const btn = document.createElement("button");
        btn.className = "kw-tab";
        btn.textContent = `${flag(cc)} ${cc.toUpperCase()}`;
        btn.addEventListener("click", () => {
            tabs.querySelectorAll(".kw-tab").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            render(cc);
        });
        tabs.appendChild(btn);
    }
    tabs.firstChild.classList.add("active");

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

    // Movement log: notable rank moves and newly appearing suggestions.
    const kwEvents = (kw.events ?? []).slice(-30).reverse();
    if (kwEvents.length) {
        const list = document.getElementById("kw-events");
        list.hidden = false;
        for (const ev of kwEvents) {
            const li = document.createElement("li");
            const day = new Date(ev.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    let latest, history, events, reviews, kwData, hist;
    try {
        // no-cache: revalidate every load so the data files can't come from
        // differently-aged browser caches and contradict each other.
        [latest, history, events, reviews, kwData, hist] = await Promise.all([
            fetch("data/latest.json", { cache: "no-cache" }).then((r) => r.json()),
            fetch("data/history.json", { cache: "no-cache" }).then((r) => r.json()),
            fetch("data/events.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => []),
            fetch("data/reviews.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => []),
            fetch("data/keywords.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
            fetch("data/histograms.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
        ]);
    } catch {
        meta.textContent = "No data yet. Run the collect workflow once to seed data/.";
        return;
    }

    const prev = history.length >= 2 ? history.at(-2) : null; // first run: nothing to diff
    const tbody = document.querySelector("#ratings tbody");

    const entries = Object.entries(latest.countries).map(([cc, cur]) => {
        const prevCount = prev?.countries[cc]?.count;
        return {
            cc,
            cur,
            delta: cur && prevCount != null ? cur.count - prevCount : null,
        };
    });

    entries.sort(
        (a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || (b.cur?.count ?? -1) - (a.cur?.count ?? -1)
    );

    const total = globalTotal(latest);
    const totalDelta = prev ? total - globalTotal(prev) : null;
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
    tbody.appendChild(
        row({
            name: "🌍 Worldwide",
            sub: "all storefronts",
            total,
            delta: totalDelta,
            avg: worldAvg,
            mix: starMix(worldCounts),
            to5: fiveStarsToFiveExact(worldCounts) ?? fiveStarsToFive(worldCount, worldAvg),
            spark: sparkline(seriesFor(history, null), "Global total, last 30 days"),
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
            mix: starMix(hist?.countries[cc]?.counts),
            to5: fiveStarsToFiveExact(hist?.countries[cc]?.counts) ?? fiveStarsToFive(cur?.count, cur?.avg),
            spark: sparkline(seriesFor(history, cc), `${countryName} ratings, last 30 days`),
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

    renderRecent(events);
    renderKeywords(kwData);
    renderWeekReviews(reviews);
    renderReviews(reviews);
    renderEvents(history, events);

    const stamp = (iso) =>
        new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    meta.textContent = "";
    const addMeta = (text) => {
        const span = document.createElement("span");
        span.className = "meta-item";
        span.textContent = text;
        meta.appendChild(span);
    };
    addMeta(`Ratings in ${rated.length} of ${entries.filter((e) => e.cur).length} storefronts`);
    addMeta(`Data updated: ${stamp(latest.fetchedAt)}`);
    addMeta(`Page loaded: ${new Date().toLocaleTimeString(undefined, { timeStyle: "short" })}`);

    // Live recheck: query Apple directly from the browser for the 20 biggest
    // storefronts, one call per 3s to respect the API throttle. Display-only;
    // the hourly workflow records changes officially.
    const checkRow = document.createElement("div");
    checkRow.id = "check-row";
    const checkBtn = document.createElement("button");
    checkBtn.className = "check-now";
    checkBtn.textContent = "Check all storefronts now";
    checkRow.appendChild(checkBtn);
    meta.insertAdjacentElement("afterend", checkRow);
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
                            changes.push(`${flag(cc)} ${d > 0 ? "+" : ""}${d}`);
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
        let summary = changes.length
            ? `Live: ${changes.join(" · ")} — recorded officially next hourly run`
            : `No changes right now (${top.length} storefronts checked)`;
        if (newReviews.length) summary += ` · ${newReviews.length} new review${newReviews.length === 1 ? "" : "s"} below`;
        if (failed) summary += ` · ${failed} didn't answer, tap again in a minute`;
        checkBtn.textContent = summary;
        setTimeout(() => {
            checkBtn.disabled = false;
            if (!changes.length && !failed && !newReviews.length) checkBtn.textContent = "Check all storefronts now";
        }, 5000);
    });

    // "Last checked" comes from the public Actions API, since a run that finds
    // no changes commits nothing. Best-effort: rate limits just hide the note.
    try {
        const res = await fetch(
            "https://api.github.com/repos/mtuck063/snore-ratings-tracker/actions/workflows/collect.yml/runs?status=success&per_page=1"
        );
        const run = (await res.json()).workflow_runs?.[0];
        if (run) addMeta(`Last checked: ${stamp(run.updated_at)}`);
    } catch {
        /* leave the meta line as is */
    }
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
