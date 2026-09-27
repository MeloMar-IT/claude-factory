import YAML from "yaml";
import { api } from "./api.js";
import { debounce, h, modal, mount, toast } from "./dom.js";
import { cleanFlow, renderEditor } from "./editor.js";
import { renderGraph } from "./graph.js";
import { insertBlock, pickBlock, renderLibrary, saveStepAsBlock } from "./library.js";
import { renderRunDetail, renderRunsList } from "./runs.js";

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");
const NAME_RE = /^[\w-]+$/;

const BLANK = `name: my-flow
description: Describe what this flow does
workspace: worktree
defaults:
  model: sonnet
  allowed_tools: [Read, Edit, Write, Glob, Grep]
vars:
  test_cmd: npm test
steps:
  - id: implement
    type: claude
    prompt: "{{task}}"
  - id: test
    type: shell
    run: "{{vars.test_cmd}}"
`;

/**
 * cur: the flow being edited.
 * { name: saved name | null, scope, saveScope, yaml, obj, mode: "visual"|"yaml", dirty, selected, validation }
 */
const S = { info: null, flows: [], cur: null, cleanup: null, lastHash: "" };

function tryParse(text) {
  try {
    const v = YAML.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ── sidebar ──

async function refreshFlows() {
  S.flows = await api.flows();
  renderSidebar();
}

function renderSidebar() {
  const inFlows = location.hash.startsWith("#/flows/") || location.hash === "#/new";
  const current = inFlows ? S.cur : null;
  mount(sidebar,
    h("div", { class: "side-actions" },
      h("button", { class: "primary", onClick: () => generateDialog(false) }, "✨ Draft flow with Claude"),
      h("button", { onClick: () => confirmDiscard() && openNew() }, "+ Blank flow")),
    h("h3", {}, "Flows"),
    h("ul", { class: "flow-list" },
      current && !current.name ? h("li", {}, h("a", { href: "#/new", class: "active" }, h("span", { class: "n" }, current.obj?.name ?? "new flow", h("span", { class: "pill claude" }, "unsaved")))) : null,
      S.flows.map((f) => h("li", { class: f.error ? "bad" : null },
        h("a", { href: `#/flows/${f.name}`, class: current?.name === f.name ? "active" : null },
          h("span", { class: "n" }, h("span", {}, f.name, current?.name === f.name && current.dirty ? " •" : ""), h("span", { class: "pill" }, f.scope)),
          h("span", { class: "d" }, f.error ? "invalid flow" : f.description ?? ""))))));
}

function confirmDiscard() {
  return !S.cur?.dirty || confirm(`Discard unsaved changes to "${S.cur.obj?.name ?? "new flow"}"?`);
}

// ── flow view ──

async function openFlow(name) {
  if (S.cur?.name === name) return renderFlowView(); // keep in-memory edits
  const f = await api.flow(name);
  const obj = tryParse(f.yaml);
  S.cur = {
    name: f.name, scope: f.scope, saveScope: f.scope === "builtin" ? "repo" : f.scope,
    yaml: f.yaml, obj, mode: obj ? "visual" : "yaml", dirty: false, selected: null, validation: null,
  };
  renderFlowView();
}

function openNew(yaml = BLANK) {
  S.cur = { name: null, scope: null, saveScope: "repo", yaml, obj: tryParse(yaml), mode: "visual", dirty: true, selected: null, validation: null };
  if (!S.cur.obj) S.cur.mode = "yaml";
  history.pushState(null, "", "#/new");
  S.lastHash = "#/new";
  renderFlowView();
}

let ui = {};

function renderFlowView() {
  const c = S.cur;
  renderSidebar();
  ui = {
    title: h("h1", {}, c.obj?.name ?? c.name ?? "flow"),
    dirty: h("span", { class: "dirty-dot", title: "Unsaved changes", style: { visibility: c.dirty ? "visible" : "hidden" } }),
    status: h("span", { class: "status" }),
    errors: h("div"),
    body: h("div"),
    graph: h("div"),
  };
  const seg = (mode, label) => h("button", { class: c.mode === mode ? "on" : null, onClick: () => setMode(mode) }, label);
  const scopeSel = h("select", { style: { width: "auto" }, title: "Where to save", onChange: (e) => (c.saveScope = e.target.value) },
    h("option", { value: "repo", selected: c.saveScope === "repo" }, "this repo"),
    h("option", { value: "global", selected: c.saveScope === "global" }, "global"));

  mount(main,
    h("div", { class: "toolbar" },
      ui.title, ui.dirty,
      h("span", { class: `pill ${c.name ? "" : "claude"}` }, c.name ? c.scope : "unsaved"),
      h("span", { class: "seg" }, seg("visual", "Visual"), seg("yaml", "YAML")),
      ui.status,
      h("span", { class: "spacer" }),
      h("button", { onClick: () => generateDialog(true), title: "Describe a change and let Claude edit this flow" }, "✨ Ask Claude"),
      h("span", { class: "muted", style: { fontSize: "12px" } }, "save to"), scopeSel,
      h("button", { onClick: save, title: "⌘S" }, "Save"),
      h("button", { class: "primary", onClick: runDialog }, "▶ Run"),
      c.name && c.scope !== "builtin" ? h("button", { class: "icon", title: "Delete flow", onClick: remove }, "🗑") : null),
    c.scope === "builtin" ? h("p", { class: "muted", style: { marginTop: "-6px" } }, "Built-in flow — saving creates your own copy that overrides it.") : null,
    ui.errors,
    h("div", { class: "editor" }, ui.body, h("div", { class: "graph-pane" }, h("h3", { style: { marginBottom: "8px" } }, "Flow"), ui.graph)));
  drawBody();
  drawGraph();
  validate();
}

function drawBody() {
  const c = S.cur;
  if (c.mode === "yaml") {
    mount(ui.body, h("textarea", {
      class: "yaml-editor", spellcheck: "false", value: c.yaml,
      onInput: (e) => {
        c.yaml = e.target.value;
        const obj = tryParse(c.yaml);
        if (obj) c.obj = obj;
        changed();
      },
      onKeydown: (e) => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        document.execCommand("insertText", false, "  ");
      },
    }));
    return;
  }
  const lostComments = /^\s*#/m.test(c.yaml);
  mount(ui.body,
    lostComments ? h("p", { class: "muted", style: { marginTop: 0 } }, "Note: visual edits rewrite the YAML and drop its comments.") : null,
    renderEditor(c.obj, {
      selected: c.selected,
      onChange: () => {
        c.yaml = YAML.stringify(cleanFlow(c.obj), { lineWidth: 0 });
        changed();
      },
      rerender: () => {
        c.yaml = YAML.stringify(cleanFlow(c.obj), { lineWidth: 0 });
        drawBody();
        changed();
      },
      onSelect: (i, scroll = true) => select(i, scroll),
      onLibrary: async (at) => {
        const picked = await pickBlock().catch((e) => toast(e.message, "error"));
        if (!picked?.block) return;
        const { count, renamed } = insertBlock(c.obj, picked.block, at);
        c.selected = at;
        c.yaml = YAML.stringify(cleanFlow(c.obj), { lineWidth: 0 });
        drawBody();
        changed();
        toast(`Inserted “${picked.block.name}” (${count} step${count > 1 ? "s" : ""})` +
          (renamed.length ? ` — renamed ${renamed.map(([a, b]) => `${a}→${b}`).join(", ")}` : ""));
      },
      onSaveBlock: (step) => saveStepAsBlock(c.obj, step).catch((e) => toast(e.message, "error")),
    }));
}

function drawGraph() {
  mount(ui.graph, renderGraph(S.cur.obj, { selected: S.cur.selected, onSelect: (i) => select(i, true) }));
}

function select(i, scroll) {
  S.cur.selected = i;
  document.querySelectorAll(".card[id^='step-']").forEach((el) => el.classList.toggle("selected", el.id === `step-${i}`));
  drawGraph();
  if (scroll && S.cur.mode === "visual") document.getElementById(`step-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setMode(mode) {
  const c = S.cur;
  if (mode === c.mode) return;
  if (mode === "visual") {
    const obj = tryParse(c.yaml);
    if (!obj) return toast("Fix the YAML syntax before switching to the visual editor", "error");
    c.obj = obj;
  }
  c.mode = mode;
  renderFlowView();
}

function changed() {
  S.cur.dirty = true;
  ui.dirty.style.visibility = "visible";
  ui.title.textContent = S.cur.obj?.name ?? "flow";
  drawGraph();
  validateSoon();
}

async function validate() {
  const c = S.cur;
  const yaml = c.yaml;
  const r = await api.validate(yaml).catch((e) => ({ ok: false, error: e.message }));
  if (c !== S.cur || yaml !== c.yaml) return; // stale
  c.validation = r;
  ui.status.className = `status ${r.ok ? "ok" : "bad"}`;
  ui.status.textContent = r.ok ? "✓ valid" : "✕ invalid";
  mount(ui.errors, r.ok ? null : h("div", { class: "errors" }, r.error.replace(/^<flow>: /, "")));
}
const validateSoon = debounce(validate, 300);

async function save() {
  const c = S.cur;
  if (!c) return;
  await validate();
  if (!c.validation?.ok) return toast("Fix the errors before saving", "error");
  const name = c.obj?.name;
  if (!NAME_RE.test(name ?? "")) return toast("Flow name may only contain letters, digits, _ and -", "error");
  const exists = S.flows.find((f) => f.name === name);
  if (name !== c.name && exists && exists.scope !== "builtin" && !confirm(`A flow named "${name}" already exists. Overwrite it?`)) return;
  try {
    await api.saveFlow(name, c.yaml, c.saveScope);
    if (c.name && c.name !== name && c.scope !== "builtin") await api.deleteFlow(c.name); // rename
    Object.assign(c, { name, scope: c.saveScope, dirty: false });
    history.replaceState(null, "", `#/flows/${name}`);
    S.lastHash = location.hash;
    await refreshFlows();
    renderFlowView();
    toast(`Saved ${name}`);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function remove() {
  const c = S.cur;
  if (!confirm(`Delete flow "${c.name}"? This removes the file.`)) return;
  await api.deleteFlow(c.name).catch((e) => toast(e.message, "error"));
  S.cur = null;
  await refreshFlows();
  location.hash = "#/flows";
}

// ── dialogs ──

async function runDialog() {
  const c = S.cur;
  await validate();
  if (!c.validation?.ok) return toast("Fix the errors before running", "error");
  const flow = c.validation.flow;
  const runId = await modal(`Run ${flow.name}`, (close) => {
    const usesTask = /\{\{\s*task\s*\}\}|FACTORY_TASK/.test(c.yaml);
    const task = h("textarea", { rows: 5, placeholder: "Describe the task, e.g. “Add a --json flag to the export command”" });
    const repo = h("input", { class: "mono", value: S.info.repo });
    const vars = Object.entries(flow.vars).map(([k, v]) => [k, h("input", { class: "mono", value: v })]);
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const start = h("button", { class: "primary", onClick: async () => {
      if (!task.value.trim() && flow.workspace !== "empty" && !confirm("Run without a task description?")) return;
      start.disabled = true;
      try {
        const body = {
          task: task.value, repo: repo.value,
          vars: Object.fromEntries(vars.map(([k, el]) => [k, el.value])),
          ...(c.dirty || !c.name ? { yaml: c.yaml } : { flow: c.name }),
        };
        close((await api.startRun(body)).runId);
      } catch (e) {
        err.textContent = e.message;
        start.disabled = false;
      }
    } }, "▶ Start run");
    task.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start.click());
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("label", { class: "field" }, h("span", {}, flow.workspace === "empty" ? "Extra instructions (optional)" : "Task"), task,
        !usesTask ? h("small", {}, "This flow doesn't use the task text.") : null),
      flow.workspace === "empty"
        ? h("small", { class: "muted" }, "Runs in a fresh empty folder — the flow fetches its own code (e.g. clones from GitHub).")
        : h("label", { class: "field" }, h("span", {}, "Repository"), repo,
            h("small", {}, flow.workspace === "worktree" ? "Runs in a fresh git worktree + branch — your checkout is not touched." : "⚠ in-place: Claude edits this directory directly.")),
      vars.length ? h("div", { class: "grid" }, vars.map(([k, el]) => h("label", { class: "field" }, h("span", { class: "mono" }, k), el))) : null,
      c.dirty ? h("small", { class: "muted" }, "Runs your unsaved edits.") : null,
      err,
      h("div", { class: "row" }, h("span", { class: "spacer" }), h("small", { class: "muted" }, "⌘↵"), start));
  });
  if (runId) location.hash = `#/runs/${runId}`;
}

async function generateDialog(modify) {
  if (!modify && !confirmDiscard()) return;
  const result = await modal(modify ? "Ask Claude to change this flow" : "Draft a flow with Claude", (close) => {
    const ta = h("textarea", {
      rows: 6,
      placeholder: modify
        ? "e.g. Add a lint step before the tests and use haiku for the fix step"
        : "e.g. Write failing tests first, implement until they pass, run eslint, then an opus security review that must approve before committing.",
    });
    const status = h("div", { class: "row" });
    const go = h("button", { class: "primary", onClick: async () => {
      if (!ta.value.trim()) return;
      go.disabled = ta.disabled = true;
      mount(status, h("span", { class: "spinner" }), h("span", { class: "muted" }, "Claude is drafting… usually 20–60 seconds"));
      try {
        close(await api.generate(ta.value, modify ? S.cur.yaml : undefined));
      } catch (e) {
        mount(status, h("span", { class: "status bad" }, e.message));
        go.disabled = ta.disabled = false;
      }
    } }, modify ? "✨ Apply" : "✨ Draft");
    ta.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && go.click());
    return h("div", { style: { display: "grid", gap: "12px" } },
      ta,
      h("small", { class: "muted" }, "Uses your local claude CLI (sonnet). You review the result before saving."),
      h("div", { class: "row" }, status, h("span", { class: "spacer" }), go));
  });
  if (!result) return;
  if (modify) {
    Object.assign(S.cur, { yaml: result.yaml, obj: tryParse(result.yaml) ?? S.cur.obj, dirty: true });
    renderFlowView();
  } else {
    openNew(result.yaml);
  }
  toast(result.error ? "Claude's draft has issues — see the errors" : `Done · $${result.costUsd.toFixed(3)} — review, then Save`, result.error ? "error" : "info");
}

// ── routing ──

function welcome() {
  mount(main, h("div", { class: "empty" },
    h("h1", { style: { marginBottom: "8px" } }, "Build your own coding flows"),
    h("p", {}, "Pick a flow on the left, start from a blank one, or describe what you want and let Claude draft it."),
    h("div", { class: "row", style: { justifyContent: "center", marginTop: "16px" } },
      h("button", { class: "primary", onClick: () => generateDialog(false) }, "✨ Draft flow with Claude"),
      h("button", { onClick: () => openNew() }, "+ Blank flow"))));
}

async function route() {
  const hash = location.hash || "#/flows";
  const [, section, arg] = hash.split("/").map(decodeURIComponent);
  const leavingDraft = S.cur?.dirty && (section !== "flows" || arg !== S.cur.name) && hash !== "#/new";
  // Only warn when opening a *different* flow; other pages keep the draft in memory.
  if (leavingDraft && section === "flows" && arg && !confirmDiscard()) {
    history.replaceState(null, "", S.lastHash);
    return;
  }
  S.lastHash = hash;
  S.cleanup?.();
  S.cleanup = null;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (section === "new" ? "flows" : section)));
  try {
    if (section === "library") await renderLibrary(main);
    else if (section === "runs" && arg) S.cleanup = renderRunDetail(main, arg);
    else if (section === "runs") await renderRunsList(main);
    else if (section === "new") S.cur && !S.cur.name ? renderFlowView() : openNew();
    else if (section === "flows" && arg) await openFlow(arg);
    else welcome();
  } catch (e) {
    mount(main, h("div", { class: "errors" }, e.message));
  }
  renderSidebar();
}

window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => S.cur?.dirty && e.preventDefault());
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && S.cur && (location.hash.startsWith("#/flows/") || location.hash === "#/new")) {
    e.preventDefault();
    save();
  }
});

S.info = await api.info();
document.getElementById("repo").textContent = S.info.repo;
await refreshFlows();
route();
