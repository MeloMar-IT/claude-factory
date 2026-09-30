import { api } from "./api.js";
import { h, mount, svg } from "./dom.js";

const usd = (n, d = 2) => `$${(n ?? 0).toFixed(d)}`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");

function tile(label, value, sub) {
  return h("div", { class: "tile" }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value), sub ? h("div", { class: "tile-sub" }, sub) : null);
}

/** Single-series bar chart of daily cost: one accent hue, bars anchored to the baseline, hover tooltip per bar. */
function costChart(days) {
  const W = 720, H = 180, L = 44, B = 22, T = 10;
  const max = Math.max(0.01, ...days.map((d) => d.costUsd));
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; })();
  const bw = (W - L) / days.length;
  const yv = (v) => T + (H - T - B) * (1 - v / nice);
  const tip = h("div", { class: "chart-tip", role: "status" });
  const grid = [0, 0.5, 1].map((f) => [
    svg("line", { x1: L, x2: W, y1: yv(nice * f), y2: yv(nice * f), class: "grid-line" }),
    svg("text", { x: L - 6, y: yv(nice * f) + 4, "text-anchor": "end", class: "axis" }, usd(nice * f, nice < 1 ? 2 : 0)),
  ]);
  const bars = days.map((d, i) => {
    const x = L + i * bw + 1.5;
    const w = Math.max(2, bw - 3);
    const y = yv(d.costUsd);
    const hgt = H - B - y;
    const r = Math.min(4, w / 2, hgt);
    const path = hgt > 0.5 ? `M${x},${H - B} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${H - B} Z` : "";
    const show = () => {
      tip.textContent = `${d.day}: ${usd(d.costUsd, 3)} · ${d.runs} run${d.runs === 1 ? "" : "s"}`;
      tip.style.left = `${((x + w / 2) / W) * 100}%`;
      tip.style.top = `${(Math.min(y, H - B - 20) / H) * 100}%`;
      tip.classList.add("show");
    };
    return svg("g", { class: "bar-hit", onMouseenter: show, onMouseleave: () => tip.classList.remove("show"), tabindex: 0, onFocus: show, onBlur: () => tip.classList.remove("show") },
      svg("rect", { x: L + i * bw, y: T, width: bw, height: H - T - B, fill: "transparent" }),
      path ? svg("path", { d: path, class: "bar" }) : null);
  });
  const labels = days.map((d, i) => (i % 5 === 0 || i === days.length - 1)
    ? svg("text", { x: L + i * bw + bw / 2, y: H - 6, "text-anchor": i === days.length - 1 ? "end" : "middle", class: "axis" }, d.day.slice(5)) : null);
  return h("div", { class: "chart" },
    svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily cost, last 30 days" }, grid, svg("line", { x1: L, x2: W, y1: H - B, y2: H - B, class: "base-line" }), bars, labels),
    tip);
}

/** Why a watcher's issues are not being started: one line per issue (or for the whole watcher). */
export function holdList(holds, repo) {
  return h("ul", { class: "holds" }, holds.map((x) => h("li", {},
    x.issue ? h("a", { href: `https://github.com/${repo}/issues/${x.issue}`, target: "_blank", rel: "noopener", class: "mono" }, `#${x.issue}`) : null,
    x.title ? h("span", { class: "hold-title" }, ` ${x.title}`) : null,
    h("span", { class: "muted" }, `${x.issue ? " — " : ""}${x.reason}`),
    x.url ? h("a", { href: x.url, target: "_blank", rel: "noopener", class: "hold-link" }, "open ↗") : null)));
}

function rateBar(ok, total) {
  const w = total ? (ok / total) * 100 : 0;
  return h("span", { class: "rate" }, h("span", { class: "rate-track" }, h("span", { class: "rate-fill", style: { width: `${w}%` } })), h("span", { class: "mono" }, pct(ok, total)));
}

export async function renderDashboard(main) {
  mount(main, h("div", { class: "row" }, h("span", { class: "spinner" }), " Loading…"));
  const [s, info, evals, watchers] = await Promise.all([api.stats(), api.info(), api.evals().catch(() => []), api.watchers().catch(() => [])]);
  const holding = watchers.filter((w) => w.enabled && w.status?.holds?.length);
  const t = s.totals;
  const budget = info.dailyBudget;
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Dashboard"), h("span", { class: "muted" }, "last 30 days")),
    h("div", { class: "tiles" },
      tile("Spent today", usd(info.spentToday), budget ? `of ${usd(budget)} daily budget` : "no daily budget set"),
      tile("Spent (30 days)", usd(t.costUsd), `${t.runs} runs`),
      tile("Success rate", pct(t.succeeded, t.runs), `${t.succeeded} succeeded · ${t.failed} failed`),
      tile("Needs a human", String(t.stopped + t.waiting), `${t.waiting} waiting for approval · ${t.stopped} stopped`)),
    holding.length ? h("div", { class: "card" }, h("h3", {}, "Waiting — why issues aren't being worked on"),
      holding.map((w) => h("div", { class: "hold-group" },
        h("div", { class: "muted", style: { fontSize: "12.5px" } }, h("b", { class: "mono" }, w.id), ` · ${w.github_repo} · label ${w.label}`),
        holdList(w.status.holds, w.github_repo)))) : null,
    h("div", { class: "card" }, h("h3", {}, "Cost per day"), costChart(s.byDay),
      h("details", {}, h("summary", {}, "Show as table"),
        h("table", { class: "table compact" }, h("thead", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "Runs"), h("th", {}, "Cost"))),
          h("tbody", {}, s.byDay.filter((d) => d.runs).reverse().map((d) => h("tr", {}, h("td", { class: "mono" }, d.day), h("td", {}, d.runs), h("td", { class: "mono" }, usd(d.costUsd, 3)))))))),
    h("div", { class: "dash-grid" },
      h("div", { class: "card" }, h("h3", {}, "By flow"),
        s.byFlow.length ? h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Flow", "Runs", "Success", "Avg time", "Cost"].map((x) => h("th", {}, x)))),
          h("tbody", {}, s.byFlow.map((f) => h("tr", {},
            h("td", {}, h("a", { href: `#/flows/${encodeURIComponent(f.flow)}` }, f.flow)),
            h("td", {}, f.runs), h("td", {}, rateBar(f.succeeded, f.runs)),
            h("td", { class: "mono" }, `${f.avgMinutes}m`), h("td", { class: "mono" }, usd(f.costUsd)))))) : h("p", { class: "muted" }, "No runs yet.")),
      h("div", { class: "card" }, h("h3", {}, "By repository"),
        s.byRepo.length ? h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Repository", "Runs", "Cost"].map((x) => h("th", {}, x)))),
          h("tbody", {}, s.byRepo.map((r) => h("tr", {}, h("td", { class: "mono" }, r.repo), h("td", {}, r.runs), h("td", { class: "mono" }, usd(r.costUsd)))))) : h("p", { class: "muted" }, "No runs yet.")),
      h("div", { class: "card" }, h("h3", {}, "Where runs fail"),
        s.failingSteps.length ? h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Step", "Failures", "Runs"].map((x) => h("th", {}, x)))),
          h("tbody", {}, s.failingSteps.map((f) => h("tr", {}, h("td", { class: "mono" }, f.step), h("td", {}, f.failures), h("td", {}, f.runs))))) : h("p", { class: "muted" }, "Nothing failed. 🎉")),
      h("div", { class: "card", style: { gridColumn: "1 / -1" } }, h("h3", {}, "Evaluations"),
        evals.length ? h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Suite", "When", "Variant", "Runs", "Pass", "Avg cost", "Avg tokens", "Avg time", "Fix loops"].map((x) => h("th", {}, x)))),
          h("tbody", {}, evals.flatMap((e) => e.summary.map((v, i) => h("tr", {},
            h("td", {}, i === 0 ? h("b", {}, e.suite) : ""), h("td", { class: "muted" }, i === 0 ? new Date(e.startedAt).toLocaleString() : ""),
            h("td", { class: "mono" }, v.variant), h("td", {}, v.runs), h("td", {}, rateBar(Math.round(v.passRate * v.runs), v.runs)),
            h("td", { class: "mono" }, usd(v.avgCostUsd, 3)), h("td", { class: "mono" }, v.avgTokens ? `${Math.round(v.avgTokens / 1000)}k` : "—"), h("td", { class: "mono" }, `${v.avgMinutes}m`), h("td", {}, v.avgFixLoops))))))
          : h("p", { class: "muted" }, "No evaluations yet. Run: ", h("code", {}, "scf eval evals/example.yaml"))),
      h("div", { class: "card" }, h("h3", {}, "Most loops (fix cycles)"),
        s.loops.length ? h("table", { class: "table compact" },
          h("thead", {}, h("tr", {}, ["Step", "Extra visits"].map((x) => h("th", {}, x)))),
          h("tbody", {}, s.loops.map((l) => h("tr", {}, h("td", { class: "mono" }, l.step), h("td", {}, l.extraVisits))))) : h("p", { class: "muted" }, "No retries yet."))));
}
