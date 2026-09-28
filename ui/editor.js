import { h } from "./dom.js";
import { area, field, insertAtCursor, list, select, setKey, text } from "./fields.js";
import { STEP_TYPES, stepBody, stepAdvanced } from "./step-types.js";

export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];

function uniqueId(flow, base) {
  const ids = new Set(flow.steps.map((s) => s.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function renameStep(flow, from, to) {
  for (const s of flow.steps) {
    for (const k of ["on_success", "on_failure", "resume", "resume_from"]) if (s[k] === from) s[k] = to;
    for (const r of s.routes ?? []) if (r.goto === from) r.goto = to;
    if (s.type === "parallel") s.steps = (s.steps ?? []).map((id) => (id === from ? to : id));
  }
}

// ── flow settings ──

function settingsCard(flow, onChange, rerender) {
  flow.defaults ??= {};
  flow.vars ??= {};
  const d = flow.defaults;
  const vars = Object.entries(flow.vars);
  const setVars = (entries) => { flow.vars = Object.fromEntries(entries); onChange(); };

  return h("div", { class: "card" },
    h("div", { class: "grid" },
      field("Name", text(flow, "name", onChange, { mono: true, placeholder: "my-flow" }), "Also the file name"),
      field("Workspace", select(flow, "workspace", [["worktree", "git worktree of local repo (isolated branch)"], ["empty", "empty folder (clone from GitHub in a step)"], ["inplace", "in place (edit repo directly)"]], onChange))),
    field("Description", text(flow, "description", onChange, { placeholder: "What this flow does" })),
    h("details", {},
      h("summary", {}, "Defaults for all agent steps"),
      h("div", { class: "grid" },
        field("Model", text(d, "model", onChange, { list: "models", mono: true, placeholder: "(router / default)" }), "e.g. sonnet, codex, ollama:qwen3-coder"),
        field("Agent", select(d, "agent", [["claude", "Claude Code"], ["codex", "Codex (ChatGPT)"]], onChange, { emptyLabel: "from model spec" })),
        field("Provider", text(d, "provider", onChange, { list: "provider-names", mono: true, placeholder: "from model spec" })),
        field("Permission mode", select(d, "permission_mode", PERMISSION_MODES.map((m) => [m, m]), onChange, { emptyLabel: "acceptEdits (default)" })),
        field("Timeout (sec)", text(d, "timeout_sec", onChange, { type: "number" })),
        field("Max visits / step", text(d, "max_visits", onChange, { type: "number", placeholder: "5" })),
        field("Budget / step ($)", text(d, "max_budget_usd", onChange, { type: "number" }))),
      h("div", { style: { marginTop: "10px" } },
        field("Allowed tools", list(d, "allowed_tools", onChange, 'Read, Edit, Write, Bash(npm *)'), "Comma-separated. Shell commands Claude may run without asking."))),
    h("details", { open: !!(flow.limits?.max_cost_usd || flow.sandbox?.claude || flow.sandbox?.docker_image || flow.one_per_repo) },
      h("summary", {}, "Safety: budget, sandbox & concurrency"),
      h("div", { class: "grid" },
        field("Max cost per run ($)", text((flow.limits ??= {}), "max_cost_usd", onChange, { type: "number", placeholder: "no limit" }), "The run fails once it has spent this much."),
        field("Docker image for sandboxed shell steps", text((flow.sandbox ??= {}), "docker_image", onChange, { mono: true, placeholder: "e.g. node:22 (global default in Settings)" }))),
      h("label", { class: "row", style: { gap: "6px", fontSize: "12.5px", marginTop: "8px" } },
        h("input", { type: "checkbox", style: { width: "auto" }, checked: !!flow.sandbox.claude, onChange: (e) => { setKey(flow.sandbox, "claude", e.target.checked || ""); onChange(); } }),
        h("span", {}, "Sandbox agents' shell commands (writes limited to the workspace)")),
      h("label", { class: "row", style: { gap: "6px", fontSize: "12.5px", marginTop: "4px" } },
        h("input", { type: "checkbox", style: { width: "auto" }, checked: !!flow.one_per_repo, onChange: (e) => { setKey(flow, "one_per_repo", e.target.checked || ""); onChange(); } }),
        h("span", {}, "One run at a time per repository (for flows that change code; other runs of such flows wait in the queue)"))),
    h("details", { open: vars.length > 0 },
      h("summary", {}, `Variables (${vars.length})`),
      h("div", { class: "kv" },
        vars.flatMap(([k, v], i) => [
          h("input", { class: "mono", value: k, placeholder: "name", onChange: (e) => { vars[i][0] = e.target.value.trim(); setVars(vars); rerender(); } }),
          h("input", { class: "mono", value: String(v), placeholder: "value", onInput: (e) => { vars[i][1] = e.target.value; setVars(vars); } }),
          h("button", { class: "icon", title: "Remove", onClick: () => { vars.splice(i, 1); setVars(vars); rerender(); } }, "✕"),
        ])),
      h("button", { class: "small", style: { marginTop: "8px" }, onClick: () => { vars.push([`var${vars.length + 1}`, ""]); setVars(vars); rerender(); } }, "+ Variable"),
      h("small", { class: "muted", style: { display: "block", marginTop: "6px" } }, "Use as {{vars.name}} in prompts and shell commands; override per run.")));
}

// ── step card ──

function targetOptions(flow, self, fallback) {
  const base = [["next", "next step"], ["end", "end (success)"], ["fail", "fail run"], ["stop", "stop (needs a human)"]];
  const steps = flow.steps.filter((s) => s !== self).map((s) => [s.id, `→ ${s.id}`]);
  return [["", `${fallback} (default)`], ...base.filter(([v]) => v !== fallback), ...steps];
}

function stepCard(flow, step, i, ctx) {
  const { onChange, rerender, selected, onSelect } = ctx;
  const move = (delta) => {
    const j = i + delta;
    if (j < 0 || j >= flow.steps.length) return;
    [flow.steps[i], flow.steps[j]] = [flow.steps[j], flow.steps[i]];
    onSelect(j);
    rerender();
  };
  const priorClaude = flow.steps.slice(0, i).filter((s) => s.type === "claude").map((s) => [s.id, s.id]);
  const vars = Object.keys(flow.vars ?? {});
  const earlier = flow.steps.filter((s) => s !== step).map((s) => s.id);
  const prevId = step.id;

  const body = stepBody(flow, step, i, { onChange, rerender, vars, earlier, priorClaude });
  return h("div", { class: `card${selected === i ? " selected" : ""}${step.jump_only ? " jump-only" : ""}`, id: `step-${i}`, onFocusin: () => selected !== i && onSelect(i, false) },
    h("div", { class: "card-head" },
      h("span", { class: "num" }, `${i + 1}`),
      text(step, "id", onChange, {
        onCommit: (e) => {
          // References still point at the id this card was rendered with.
          const next = e.target.value.trim();
          step.id = next;
          if (next && prevId && next !== prevId) renameStep(flow, prevId, next);
          rerender();
        },
      }),
      h("span", { class: `pill ${step.type}` }, `${STEP_TYPES[step.type]?.icon ?? "?"} ${step.type}`),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Move up", disabled: i === 0, onClick: () => move(-1) }, "↑"),
      h("button", { class: "icon", title: "Move down", disabled: i === flow.steps.length - 1, onClick: () => move(1) }, "↓"),
      h("button", { class: "icon", title: "Save as reusable block", onClick: () => ctx.onSaveBlock?.(step) }, "☆"),
      h("button", { class: "icon", title: "Duplicate", onClick: () => { flow.steps.splice(i + 1, 0, { ...structuredClone(step), id: uniqueId(flow, step.id) }); rerender(); } }, "⧉"),
      h("button", { class: "icon", title: "Delete step", onClick: () => { flow.steps.splice(i, 1); rerender(); } }, "🗑")),
    field("Description", text(step, "description", onChange, { placeholder: "optional" })),
    ...body,
    h("div", { class: "card-sub" },
      h("div", { class: "grid" },
        field("On success →", select(step, "on_success", targetOptions(flow, step, "next").slice(1), () => { onChange(); }, { emptyLabel: "next (default)" })),
        field("On failure →", select(step, "on_failure", targetOptions(flow, step, "fail").slice(1), () => { onChange(); }, { emptyLabel: "fail run (default)" })),
        field("Max visits", text(step, "max_visits", onChange, { type: "number", placeholder: String(flow.defaults?.max_visits ?? 5) })),
        field("Timeout (sec)", text(step, "timeout_sec", onChange, { type: "number", placeholder: flow.defaults?.timeout_sec ? String(flow.defaults.timeout_sec) : "none" }))),
      h("label", { class: "row", style: { gap: "6px", fontSize: "12.5px" } },
        h("input", { type: "checkbox", style: { width: "auto" }, checked: !!step.jump_only,
          onChange: (e) => { setKey(step, "jump_only", e.target.checked || ""); rerender(); } }),
        h("span", {}, "Only reachable via jumps"),
        h("span", { class: "muted" }, "— skipped in normal order, e.g. an “ask for info” or “fix” handler")),
      h("div", { class: "grid" },
        field("Pass only if output matches", text(step, "pass_if", onChange, { mono: true, placeholder: "regex, e.g. ^VERDICT: APPROVE" })),
        field("Fail if output matches", text(step, "fail_if", onChange, { mono: true, placeholder: "regex" }))),
      stepAdvanced(flow, step, { onChange, rerender, targets: targetOptions(flow, step, "next").slice(1) })));
}

function insertBar(flow, at, { rerender, onSelect, onLibrary }) {
  const add = (type) => {
    const step = { id: uniqueId(flow, type), ...structuredClone(STEP_TYPES[type].blank) };
    flow.steps.splice(at, 0, step);
    onSelect(at);
    rerender();
  };
  return h("div", { class: "insert" },
    h("button", { class: "small", onClick: () => add("claude") }, "+ Agent step"),
    h("button", { class: "small", onClick: () => add("shell") }, "+ Shell step"),
    h("select", { class: "small-select", title: "More step types", onChange: (e) => { if (e.target.value) add(e.target.value); } },
      h("option", { value: "" }, "+ more…"),
      ["approval", "parallel", "flow"].map((t) => h("option", { value: t }, `${STEP_TYPES[t].icon} ${STEP_TYPES[t].label}`))),
    h("button", { class: "small", onClick: () => onLibrary?.(at) }, "+ From library"));
}

/** Visual editor for a flow object. Field edits call onChange; structural edits call rerender. */
export function renderEditor(flow, ctx) {
  flow.steps ??= [];
  return h("div", { class: "steps" },
    settingsCard(flow, ctx.onChange, ctx.rerender),
    h("h3", { style: { margin: "22px 0 4px" } }, `Steps (${flow.steps.length})`),
    insertBar(flow, 0, ctx),
    flow.steps.map((s, i) => [stepCard(flow, s, i, ctx), insertBar(flow, i + 1, ctx)]));
}

/** Strip empty values so the YAML stays tidy. */
export function cleanFlow(flow) {
  const out = structuredClone(flow);
  const prune = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete o[k];
      else if (typeof v === "object" && !Array.isArray(v)) {
        prune(v);
        if (!Object.keys(v).length) delete o[k];
      }
    }
  };
  prune(out);
  for (const s of out.steps ?? []) prune(s);
  return out;
}
