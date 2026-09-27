import { api } from "./api.js";
import { h, mount, timeAgo, toast } from "./dom.js";

const money = (n) => (n ? `$${n.toFixed(4)}` : "—");
const secs = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

export async function renderRunsList(main) {
  mount(main, h("div", { class: "row" }, h("span", { class: "spinner" }), " Loading runs…"));
  const runs = await api.runs();
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Runs"), h("span", { class: "muted" }, `${runs.length} most recent`)),
    runs.length
      ? h("table", { class: "table" },
          h("thead", {}, h("tr", {}, ["Status", "Flow", "Task", "Steps", "Cost", "Started"].map((t) => h("th", {}, t)))),
          h("tbody", {}, runs.map((r) =>
            h("tr", { class: "link", onClick: () => (location.hash = `#/runs/${r.runId}`) },
              h("td", {}, h("span", { class: `pill ${r.status}` }, r.status)),
              h("td", {}, h("b", {}, r.flow)),
              h("td", { class: "task", title: r.task }, r.task),
              h("td", { class: "mono" }, r.history.length),
              h("td", { class: "mono" }, money(r.totalCostUsd)),
              h("td", { class: "muted" }, timeAgo(r.startedAt))))))
      : h("div", { class: "empty" }, "No runs yet. Open a flow and press ▶ Run."));
}

function logLine(line) {
  const cls = line.startsWith("▶") ? "step" : line.startsWith("✔") ? "ok" : line.startsWith("✘") ? "fail" : line.startsWith("    ·") ? "dim" : null;
  return h("span", { class: cls }, line + "\n");
}

function timeline(summary) {
  if (!summary.history.length) return h("p", { class: "muted" }, "No steps finished yet.");
  return h("div", { class: "timeline" }, summary.history.map((s, i) =>
    h("details", { class: "tl", open: !s.ok && i === summary.history.length - 1 },
      h("summary", {},
        h("span", { class: `pill ${s.ok ? "ok" : "fail"}` }, s.ok ? "✔" : "✘"),
        h("b", { class: "mono" }, s.id),
        s.visit > 1 ? h("span", { class: "pill" }, `visit ${s.visit}`) : null,
        h("span", { class: "muted" }, s.type),
        h("span", { class: "spacer" }),
        s.error ? h("span", { class: "status bad" }, s.error.slice(0, 60)) : null,
        h("span", { class: "muted mono" }, secs(s.durationMs)),
        s.costUsd ? h("span", { class: "muted mono" }, money(s.costUsd)) : null),
      h("pre", {}, s.output || "(no output)"))));
}

/** Live run page. Returns a cleanup function that closes the event stream. */
export function renderRunDetail(main, runId) {
  const logEl = h("pre", { class: "log" });
  const head = h("div");
  const side = h("div");
  let follow = true;
  logEl.addEventListener("scroll", () => {
    follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  });

  mount(main, head, h("div", { class: "run-grid" },
    h("div", {}, h("h3", { style: { marginBottom: "8px" } }, "Live log"), logEl),
    h("div", {}, h("h3", { style: { marginBottom: "8px" } }, "Steps"), side)));

  const draw = (s) => {
    const running = s.status === "running";
    mount(head,
      h("div", { class: "toolbar" },
        h("a", { href: "#/runs", class: "btn ghost" }, "←"),
        h("h1", {}, s.flow),
        h("span", { class: `pill ${s.status}` }, running ? h("span", { class: "spinner", style: { width: "10px", height: "10px" } }) : null, s.status),
        h("span", { class: "muted mono" }, money(s.totalCostUsd)),
        h("span", { class: "spacer" }),
        running ? h("button", { class: "danger", onClick: async () => {
          if (!confirm("Cancel this run? The current step is stopped.")) return;
          await api.cancelRun(runId).catch((e) => toast(e.message, "error"));
        } }, "■ Cancel") : null,
        h("a", { class: "btn", href: `#/flows/${encodeURIComponent(s.flow)}` }, "Open flow")),
      h("div", { class: "card", style: { marginBottom: "16px" } },
        h("p", { style: { margin: 0, whiteSpace: "pre-wrap" } }, s.task),
        s.reason ? h("p", { class: "status bad", style: { margin: 0 } }, s.reason) : null,
        h("dl", { class: "meta" },
          h("dt", {}, "Run"), h("dd", {}, s.runId),
          s.branch ? [h("dt", {}, "Branch"), h("dd", {}, s.branch)] : null,
          s.workdir ? [h("dt", {}, "Workspace"), h("dd", {}, s.workdir)] : null,
          h("dt", {}, "Logs"), h("dd", {}, s.runDir))));
    mount(side, timeline(s));
  };

  const es = api.events(runId);
  let gotLog = false;
  es.addEventListener("update", (e) => {
    const { summary } = JSON.parse(e.data);
    draw(summary);
    if (summary.status !== "running") {
      es.close();
      if (!gotLog) logEl.append(h("span", { class: "dim" }, "(live log only available while the UI server that started the run is up — see step outputs →)\n"));
    }
  });
  es.addEventListener("log", (e) => {
    gotLog = true;
    logEl.append(logLine(JSON.parse(e.data).line));
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) toast("Lost connection to the run stream", "error");
  };
  return () => es.close();
}
