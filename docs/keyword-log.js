// Full keyword movement log. The main page shows the last 30 entries; this
// shows every one, with filters, because the log now runs to hundreds of rows
// across ten markets and a single scroll of the newest 30 hid most of it.
//
// Row markup deliberately matches the main page's #kw-events list so the shared
// CSS applies unchanged — only the filter bar and day headings are new here.

const flag = (cc) =>
    String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));

const rankText = (r) => (r == null ? "—" : `#${r}`);

const state = { market: "all", type: "all", q: "" };
let events = [];
// Releases are merged into the same list rather than shown in their own strip:
// the log is read to work out why a rank moved, and the release is usually the
// answer. It only reads as the answer when it sits in the same column, at the
// hour it happened, with the moves it caused underneath it.
let releases = [];

const releaseRows = (month) =>
    releases
        .filter((r) => r.at?.slice(0, 7) === month)
        .map((r) => {
            const ccs = Object.keys(r.after ?? {});
            const fields = ccs.filter((cc) => r.before?.[cc]?.field !== r.after[cc]?.field);
            const shots = ccs.filter(
                (cc) =>
                    r.before?.[cc]?.shots && r.after[cc]?.shots && r.before[cc].shots !== r.after[cc].shots
            );
            const parts = [];
            if (fields.length) parts.push(`keyword field in ${fields.join(", ").toUpperCase()}`);
            if (shots.length) parts.push(`screenshots in ${shots.join(", ").toUpperCase()}`);
            return { at: r.at, type: "release", version: r.version, what: parts.join("; ") };
        });

function chip(label, active, onClick) {
    const b = document.createElement("button");
    b.className = "kw-tab" + (active ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
}

function matches(ev) {
    // A release is not a per-market event: it shipped everywhere at once, and
    // it is the thing most of the rank moves below it are being read against,
    // so a market filter must not hide the cause of what it leaves on screen.
    if (state.market !== "all" && ev.type !== "release" && ev.cc !== state.market) return false;
    const type = ev.type ?? "rank";
    if (state.type !== "all" && type !== state.type) return false;
    if (state.q) {
        const hay = `${ev.kw ?? ""} ${ev.term ?? ""} ${ev.prefix ?? ""} ${ev.version ?? ""}`.toLowerCase();
        if (!hay.includes(state.q)) return false;
    }
    return true;
}

// Same three shapes the main page renders. Keyword text goes in via textContent
// because it originates from Apple's API, not from us.
function row(ev) {
    const li = document.createElement("li");
    const when = new Date(ev.at);
    const time = `<span class="event-time">${when.toLocaleTimeString(undefined, { timeStyle: "short" })}</span>`;
    if (ev.type === "release") {
        li.className = "log-release";
        li.innerHTML = `${time}🚀 <strong></strong> went live${ev.what ? ` — ${ev.what}` : ""}`;
        li.querySelector("strong").textContent = ev.version;
    } else if (ev.type === "hint") {
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
    return li;
}

function render() {
    const list = document.getElementById("kw-events");
    list.replaceChildren();
    const shown = events.filter(matches);

    // Day headings: with hundreds of rows, a bare timestamp column makes it hard
    // to tell where one collection run ends and the next begins.
    let lastDay = null;
    for (const ev of shown) {
        const day = new Date(ev.at).toLocaleDateString(undefined,
            { weekday: "short", month: "short", day: "numeric" });
        if (day !== lastDay) {
            lastDay = day;
            const h = document.createElement("li");
            h.className = "log-day";
            h.textContent = day;
            list.appendChild(h);
        }
        list.appendChild(row(ev));
    }

    document.getElementById("log-count").textContent =
        `${shown.length.toLocaleString()} of ${events.length.toLocaleString()} entries`;
    document.getElementById("log-empty").hidden = shown.length > 0;
}

function buildFilters() {
    const markets = [...new Set(events.filter((e) => e.cc).map((e) => e.cc))].sort();
    const mrow = document.getElementById("log-markets");
    const paint = () => {
        mrow.replaceChildren();
        mrow.appendChild(chip("All markets", state.market === "all", () => {
            state.market = "all"; paint(); render();
        }));
        for (const cc of markets) {
            const n = events.filter((e) => e.cc === cc).length;
            mrow.appendChild(chip(`${flag(cc)} ${cc.toUpperCase()} ${n}`, state.market === cc, () => {
                state.market = cc; paint(); render();
            }));
        }
    };
    paint();

    const trow = document.getElementById("log-types");
    const types = [
        ["all", "All changes"],
        ["rank", "Rank moves"],
        ["hint", "New suggestions"],
        ["autotrack", "Newly tracked"],
        ["release", "Releases"],
    ];
    const paintTypes = () => {
        trow.replaceChildren();
        for (const [key, label] of types) {
            const n = key === "all" ? events.length
                : events.filter((e) => (e.type ?? "rank") === key).length;
            if (!n && key !== "all") continue;
            trow.appendChild(chip(`${label} ${n}`, state.type === key, () => {
                state.type = key; paintTypes(); render();
            }));
        }
    };
    paintTypes();

    let t;
    document.getElementById("log-search").addEventListener("input", (e) => {
        clearTimeout(t);
        const v = e.target.value.trim().toLowerCase();
        t = setTimeout(() => { state.q = v; render(); }, 120);
    });
}

// Events are stored one shard per month. A month is the unit the reader thinks
// in anyway, and loading only the one on screen keeps this page a fixed cost
// however many years accumulate.
const grab = (p) => fetch(`data/kw-events/${p}`, { cache: "no-cache" }).then((r) => r.json());

const monthLabel = (m) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, {
        month: "long", year: "numeric", timeZone: "UTC",
    });

async function loadMonth(m, index) {
    const meta = document.getElementById("meta");
    const shard = (await grab(`${m}.json`).catch(() => [])).slice();
    events = [...shard, ...releaseRows(m)].sort((a, b) => b.at.localeCompare(a.at)); // newest first
    // A market filter set on one month may name a market absent from another,
    // which would leave the list empty with no chip showing why. Filters carry
    // over where they still apply and reset where they do not.
    if (state.market !== "all" && !events.some((e) => e.cc === state.market)) state.market = "all";
    if (state.type !== "all" && !events.some((e) => (e.type ?? "rank") === state.type)) state.type = "all";
    const n = events.length;
    meta.textContent = n
        ? `${monthLabel(m)} · ${n.toLocaleString()} of ${index.total.toLocaleString()} entries · `
          + `${new Set(events.map((e) => e.cc)).size} markets`
        : `No keyword events recorded in ${monthLabel(m)}.`;
    // Market and type counts are per-month, so they rebuild with the shard.
    buildFilters();
    render();
}

function buildMonths(index, current, onPick) {
    const row = document.getElementById("log-months");
    const paint = () => {
        row.replaceChildren();
        for (const m of [...index.months].reverse()) {
            row.appendChild(chip(`${monthLabel(m)} ${index.counts[m] ?? 0}`, m === current, () => {
                current = m;
                paint();
                onPick(m);
            }));
        }
    };
    paint();
}

async function main() {
    const meta = document.getElementById("meta");
    try {
        // Absent until a release has been recorded, and absent is not an error:
        // the log is complete without it, just without the causes marked.
        releases = await fetch("data/releases.json", { cache: "no-cache" })
            .then((r) => r.json())
            .catch(() => []);
        const index = await grab("index.json");
        if (!index?.months?.length) { meta.textContent = "No keyword events recorded yet."; return; }
        const newest = index.months[index.months.length - 1];
        buildMonths(index, newest, (m) => loadMonth(m, index));
        await loadMonth(newest, index);
    } catch (err) {
        meta.textContent = `Could not load the keyword log: ${err.message}`;
    }
}

main();
