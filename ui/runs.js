import { api } from "./api.js";
import { h, mount, timeAgo, toast } from "./dom.js";
import { needsYou, nextBlock, nextStatus, whenParts, whereLink } from "./next.js";
import { STEP_TYPES } from "./step-types.js";

const money = (n) => (n ? `$${n.toFixed(4)}` : "—");
const secs = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const what = (r) => (r.vars?.issue ? `${r.vars.github_repo}#${r.vars.issue}` : r.vars?.pr ? `${r.vars.github_repo} PR #${r.vars.pr}` : "");

const REFRESH_MS = 30_000;

/** A row of the Runs list: the status name of the record with its "?", then flow, task, steps, cost, start. */
export const runRow = (r, { owner = false, cost = true } = {}) => h("tr", { class: "link", onClick: () => (location.hash = `#/runs/${r.runId}`) },
  h("td", {}, r.next ? nextStatus(r.next) : null),
  h("td", {}, h("b", {}, r.flow), what(r) ? h("div", { class: "muted mono", style: { fontSize: "11.5px" } }, what(r)) : null),
  h("td", { class: "task", title: r.task }, r.task || h("span", { class: "muted" }, "—"),
    r.next ? h("div", { class: "muted", title: r.next.text }, r.next.text) : null,
    r.next && whenParts(r.next).length ? h("div", { class: "next-parts timing" }, whenParts(r.next)) : null),
  owner ? h("td", {}, r.ownerName ?? "—") : null,
  h("td", { class: "mono" }, r.history?.length ?? 0),
  cost ? h("td", { class: "mono" }, money(r.totalCostUsd)) : null,
  h("td", { class: "muted" }, timeAgo(r.startedAt)));

/** "2 runs ahead of you": other accounts' queued runs in front of a user's own. */
export const aheadText = (n) => `${n} ${n === 1 ? "run" : "runs"} ahead of you`;

/** A queued job: its status with "?", id, details, link and a Remove button. */
export const queueRow = (p, onRemove) => h("div", { class: "row" },
  p.next ? nextStatus(p.next) : null, h("span", { class: "mono" }, p.runId), h("span", { class: "muted" }, [p.kind, p.source, p.next?.text].filter(Boolean).join(" · ")),
  p.ahead ? h("span", { class: "muted" }, aheadText(p.ahead)) : null,
  ...(p.next ? whenParts(p.next) : []),
  p.next ? whereLink(p.next.where) : null,
  h("span", { class: "spacer" }),
  h("button", { class: "small", onClick: onRemove }, "Remove"));

/** The step row of the run page: the step the run is at (or resumes at) and what that step is. Never the id alone. */
export function stepRow(s) {
  const id = s.state?.next;
  if (!id || s.status === "succeeded") return null;
  const step = s.flowDef?.steps?.find((st) => st.id === id);
  const about = step?.description || (step?.type === "agent" ? "Agent" : STEP_TYPES[step?.type]?.label) || "what this step does is not saved with this run";
  return [h("dt", {}, s.status === "running" ? "Current step" : "Resumes at step"), h("dd", {}, id, h("span", { class: "muted" }, ` — ${about}`))];
}

/** Runs list; refreshes itself every 30 seconds. Returns a cleanup function that stops that. */
export async function renderRunsList(main, { admin = true } = {}) {
  mount(main, h("div", { class: "row" }, h("span", { class: "spinner" }), " Loading runs…"));
  let timer;
  let owner = "";
  const draw = async () => {
    // A user gets their own runs and queue; the owner filter and its options are for admins.
    const [runs, queue, owners] = await Promise.all([api.runs(admin ? owner : ""), api.queue(), admin ? api.runOwners() : []]);
    if (!main.isConnected) return;
    const yours = needsYou(runs);
    const cols = ["Status", "Flow", "Task / what happens next", ...(admin ? ["Owner"] : []), "Steps", ...(admin ? ["Cost"] : []), "Started"];
    const table = (list) => h("table", { class: "table" },
      h("thead", {}, h("tr", {}, cols.map((t) => h("th", {}, t)))),
      h("tbody", {}, list.map((r) => runRow(r, { owner: admin, cost: admin }))));
    const filter = admin ? h("select", { class: "small-select", title: "Show the runs of one account", onChange: (e) => { owner = e.target.value; draw(); } },
      h("option", { value: "" }, "All owners"),
      owners.map((o) => h("option", { value: o.id, selected: o.id === owner }, `${o.name} (${o.runs})`))) : null;

    mount(main,
      h("div", { class: "toolbar" }, h("h1", {}, "Runs"),
        admin ? h("span", { class: "muted" }, `${queue.active.length}/${queue.concurrency} running · ${queue.pending.length} queued`) : null,
        filter,
        h("span", { class: "spacer" }),
        h("span", { class: "muted", style: { fontSize: "12px" } }, `updated ${new Date().toLocaleTimeString()} · refreshes every 30 s`),
        h("button", { onClick: () => draw() }, "↻ Refresh")),
      queue.pending.length ? h("div", { class: "card", style: { marginBottom: "16px" } },
        h("h3", {}, "Queue"),
        queue.pending.map((p) => queueRow(p, async () => { await api.cancelRun(p.runId); draw(); }))) : null,
      yours.length ? h("div", { style: { marginBottom: "16px" } }, h("h3", { style: { marginBottom: "8px" } }, `Needs you (${yours.length})`), table(yours)) : null,
      runs.length ? table(runs) : h("div", { class: "empty" }, owner ? "No runs of this account." : admin ? "No runs yet. Open a flow and press ▶ Run." : "No runs yet."));
  };
  await draw();
  timer = setInterval(() => draw().catch(() => {}), REFRESH_MS);
  return () => clearInterval(timer);
}

function logLine(line) {
  const cls = line.startsWith("▶") ? "step" : line.startsWith("✔") ? "ok" : line.startsWith("✘") ? "fail" : line.startsWith("    ·") || line.startsWith("  ") ? "dim" : line.startsWith("⏸") || line.startsWith("↻") ? "step" : null;
  return h("span", { class: cls }, line + "\n");
}

// ── transcript ──

function toolSummary(name, input) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.description ?? "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function transcriptView(events) {
  if (!events.length) return h("p", { class: "muted" }, "No transcript recorded.");
  return h("div", { class: "transcript" }, events.map((e) => {
    if (e.kind === "raw") return h("pre", { class: "mono" }, e.text || "(no output)");
    if (e.kind === "text") return h("div", { class: "tx-text" }, e.text);
    if (e.kind === "result") return h("div", { class: `tx-result${e.isError ? " bad" : ""}` },
      h("b", {}, e.isError ? "✘ Result" : "✔ Result"),
      e.costUsd ? h("span", { class: "muted mono" }, ` · $${e.costUsd.toFixed(4)} · ${e.turns} turns`) : e.tokens ? h("span", { class: "muted mono" }, ` · ${Math.round(e.tokens / 1000)}k tokens`) : null,
      h("div", {}, e.text));
    const edit = e.name === "Edit" && e.input.old_string != null;
    return h("details", { class: `tx-tool${e.isError ? " bad" : ""}` },
      h("summary", {}, h("span", { class: "pill" }, e.name), h("span", { class: "mono tx-arg" }, toolSummary(e.name, e.input))),
      edit
        ? h("pre", { class: "diff" }, ...String(e.input.old_string).split("\n").map((l) => h("span", { class: "del" }, `- ${l}\n`)), ...String(e.input.new_string ?? "").split("\n").map((l) => h("span", { class: "add" }, `+ ${l}\n`)))
        : e.name === "Write" ? h("pre", { class: "mono" }, String(e.input.content ?? "").slice(0, 6000)) : null,
      e.result != null ? h("pre", { class: "mono tx-out" }, e.result || "(empty)") : null);
  }));
}

function stepsView(runId, summary) {
  if (!summary.history.length) return h("p", { class: "muted" }, "No steps finished yet.");
  return h("div", { class: "timeline" }, summary.history.map((s, i) => stepEntry(runId, s, i)));
}

/** One finished step: summary line, the raw error under "Details", and the output or transcript when opened. */
export function stepEntry(runId, s, i) {
  // A user's view has no output: a plain row that cannot be opened and never asks for a transcript.
  if (!("output" in s)) {
    return h("div", { class: "tl" },
      h("div", { class: "row" },
        h("span", { class: `pill ${s.ok ? "ok" : "fail"}` }, s.ok ? "✔" : "✘"),
        h("b", { class: "mono" }, s.id),
        s.visit > 1 ? h("span", { class: "pill" }, `visit ${s.visit}`) : null,
        h("span", { class: "muted" }, s.type === "agent" ? "Agent" : s.type),
        h("span", { class: "spacer" }),
        h("span", { class: "muted mono" }, secs(s.durationMs))),
      s.error ? h("p", { class: "muted", style: { margin: "4px 12px" } }, s.error) : null);
  }
  const body = h("div");
  return h("details", {
    class: "tl",
    onToggle: async (e) => {
      if (!e.target.open || body.dataset.loaded) return;
      body.dataset.loaded = "1";
      if (s.type !== "claude") return mount(body, h("pre", {}, s.output || "(no output)"));
      mount(body, h("p", { class: "muted", style: { padding: "0 12px" } }, "Loading transcript…"));
      const t = await api.transcript(runId, i).catch((err) => ({ events: [{ kind: "raw", text: err.message }] }));
      mount(body, transcriptView(t.events));
    },
  },
    h("summary", {},
      h("span", { class: `pill ${s.ok ? "ok" : "fail"}` }, s.ok ? "✔" : "✘"),
      h("b", { class: "mono" }, s.id),
      s.visit > 1 ? h("span", { class: "pill" }, `visit ${s.visit}`) : null,
      h("span", { class: "muted" }, s.agent ? s.agent : s.type),
      h("span", { class: "spacer" }),
      h("span", { class: "muted mono" }, secs(s.durationMs)),
      s.costUsd ? h("span", { class: "muted mono" }, money(s.costUsd)) : s.tokens ? h("span", { class: "muted mono", title: "no per-token cost (local model or subscription)" }, `${Math.round((s.tokens.input + s.tokens.output) / 1000)}k tok`) : null),
    s.error ? h("pre", { class: "mono" }, h("b", {}, "Details"), "\n", s.error) : null,
    body);
}

/** The raw reason of a run, shown as a detail under the plain text. */
/** The published version of the flow a run started with; null for a flow that is not published. */
export const versionRow = (s) => (s.flowDef?.publish?.enabled ? [h("dt", {}, "Flow version"), h("dd", {}, String(s.flowDef.publish.version))] : null);

export const detailsRow =(s) => (s.reason ? [h("dt", {}, "Details"), h("dd", { style: { whiteSpace: "pre-wrap" } }, s.reason)] : null);

function diffView(d) {
  if (!d.patch) return h("p", { class: "muted" }, "No changes (or the workspace is not a git checkout).");
  return h("div", {},
    h("pre", { class: "mono diffstat" }, d.stat),
    d.truncated ? h("p", { class: "status bad" }, "Diff truncated (very large).") : null,
    h("pre", { class: "diff" }, d.patch.split("\n").map((l) =>
      h("span", { class: l.startsWith("+++") || l.startsWith("---") ? "file" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : l.startsWith("diff ") ? "file" : null }, l + "\n"))));
}

// ── actions ──

async function act(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e.message, "error");
  }
}

function actions(s) {
  const b = [];
  if (s.status === "waiting") {
    b.push(h("button", { class: "primary", onClick: () => { const note = prompt("Approve — note (optional)"); if (note !== null) act(() => api.approveRun(s.runId, note), "Approved — continuing"); } }, "✔ Approve"));
    b.push(h("button", { class: "danger", onClick: () => { const note = prompt("Why reject? (optional)"); if (note !== null) act(() => api.rejectRun(s.runId, note), "Rejected"); } }, "✘ Reject"));
  }
  if (["stopped", "failed", "cancelled"].includes(s.status) && s.state?.next) {
    b.push(h("button", { class: "primary", onClick: () => act(() => api.resumeRun(s.runId), "Resuming") }, `↻ Resume at ${s.state.next}`));
  }
  if (s.status !== "running" && s.status !== "waiting" && s.flowDef?.steps?.length) {
    b.push(h("select", { class: "small-select", title: "Re-run from a step", onChange: (e) => {
      const from = e.target.value;
      e.target.value = "";
      if (from && confirm(`Re-run this run from "${from}"? Earlier step outputs are kept.`)) act(() => api.resumeRun(s.runId, from), `Re-running from ${from}`);
    } }, h("option", { value: "" }, "Retry from step…"), s.flowDef.steps.map((st) => h("option", { value: st.id }, st.id))));
  }
  if (["running", "waiting"].includes(s.status)) {
    b.push(h("button", { class: "danger", onClick: () => confirm("Cancel this run? You can resume it later.") && act(() => api.cancelRun(s.runId)) }, "■ Cancel"));
  }
  return b;
}

/** Live run page. Returns a cleanup function that closes the event stream. */
export function renderRunDetail(main, runId, { admin = true } = {}) {
  const logEl = h("pre", { class: "log" });
  const head = h("div");
  const tabBody = h("div");
  let summary;
  let tab = "log";
  let follow = true;
  logEl.addEventListener("scroll", () => {
    follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  });

  const showTab = async (t) => {
    tab = t;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    if (t === "log") return mount(tabBody, logEl);
    if (t === "steps") return mount(tabBody, summary ? stepsView(runId, summary) : null);
    mount(tabBody, h("p", { class: "muted" }, "Computing diff…"));
    mount(tabBody, diffView(await api.diff(runId).catch((e) => ({ patch: "", stat: e.message }))));
  };

  const tabs = h("div", { class: "seg tabs", style: { marginBottom: "12px" } },
    [["log", "Live log"], ["steps", admin ? "Steps & transcripts" : "Steps"], ["diff", "Changes"]].map(([k, l]) =>
      h("button", { "data-tab": k, class: k === tab ? "on" : null, onClick: () => showTab(k) }, l)));

  mount(main, head, tabs, tabBody);
  mount(tabBody, logEl);

  const draw = (s) => {
    const prev = summary;
    summary = s;
    mount(head,
      h("div", { class: "toolbar" },
        h("a", { href: "#/runs", class: "btn ghost" }, "←"),
        h("h1", {}, s.flow),
        s.next ? nextStatus(s.next) : null,
        admin ? h("span", { class: "muted mono" }, money(s.totalCostUsd)) : null,
        s.resumes ? h("span", { class: "muted" }, `resumed ${s.resumes}×`) : null,
        h("span", { class: "spacer" }),
        ...actions(s),
        admin ? h("a", { class: "btn", href: `#/flows/${encodeURIComponent(s.flow)}` }, "Open flow") : null),
      s.next ? nextBlock(s.next) : null,
      h("div", { class: "card", style: { marginBottom: "16px" } },
        s.task ? h("p", { style: { margin: 0, whiteSpace: "pre-wrap" } }, s.task) : null,
        s.questions ? h("pre", { class: "mono", style: { whiteSpace: "pre-wrap" } }, h("b", {}, "Questions"), "\n", s.questions) : null,
        h("dl", { class: "meta" },
          what(s) ? [h("dt", {}, "Ticket"), h("dd", {}, what(s))] : null,
          h("dt", {}, "Run"), h("dd", {}, s.runId),
          s.branch ? [h("dt", {}, "Branch"), h("dd", {}, s.branch)] : null,
          s.workdir ? [h("dt", {}, "Workspace"), h("dd", {}, s.workdir)] : null,
          versionRow(s),
          stepRow(s),
          detailsRow(s))));
    if (tab === "steps" && (!prev || prev.history.length !== s.history.length)) showTab("steps");
  };

  const es = api.events(runId);
  es.addEventListener("update", (e) => {
    const { summary: s } = JSON.parse(e.data);
    draw(s);
  });
  es.addEventListener("log", (e) => {
    logEl.append(logLine(JSON.parse(e.data).line));
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) toast("Lost connection to the run stream", "error");
  };
  return () => es.close();
}
