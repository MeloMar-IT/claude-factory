import { h } from "./dom.js";

const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
const MODELS = ["sonnet", "opus", "haiku"];

// ── bound inputs: each writes into obj[key] (deleting when empty) and calls onChange ──

function setKey(obj, key, v) {
  if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete obj[key];
  else obj[key] = v;
}

function text(obj, key, onChange, { placeholder, mono, list, type = "text", onCommit } = {}) {
  return h("input", {
    type, placeholder, list, class: mono ? "mono" : null,
    value: obj[key] ?? "",
    onInput: (e) => {
      const raw = e.target.value;
      setKey(obj, key, type === "number" ? (raw === "" ? "" : Number(raw)) : raw);
      onChange();
    },
    onChange: onCommit,
  });
}

function area(obj, key, onChange, { rows = 4, placeholder } = {}) {
  return h("textarea", {
    rows, placeholder, value: obj[key] ?? "",
    onInput: (e) => { setKey(obj, key, e.target.value); onChange(); },
  });
}

function select(obj, key, options, onChange, { emptyLabel } = {}) {
  const opts = emptyLabel != null ? [["", emptyLabel], ...options] : options;
  return h("select", { onChange: (e) => { setKey(obj, key, e.target.value); onChange(); } },
    opts.map(([v, l]) => h("option", { value: v, selected: (obj[key] ?? "") === v }, l)));
}

function list(obj, key, onChange, placeholder) {
  return h("input", {
    placeholder, class: "mono", value: (obj[key] ?? []).join(", "),
    onInput: (e) => {
      setKey(obj, key, e.target.value.split(",").map((s) => s.trim()).filter(Boolean));
      onChange();
    },
  });
}

const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);

function insertAtCursor(textarea, snippet) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + snippet + value.slice(b);
  textarea.selectionStart = textarea.selectionEnd = a + snippet.length;
  textarea.dispatchEvent(new Event("input"));
  textarea.focus();
}

function uniqueId(flow, base) {
  const ids = new Set(flow.steps.map((s) => s.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function renameStep(flow, from, to) {
  for (const s of flow.steps) {
    for (const k of ["on_success", "on_failure", "resume"]) if (s[k] === from) s[k] = to;
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
      field("Workspace", select(flow, "workspace", [["worktree", "git worktree (isolated branch)"], ["inplace", "in place (edit repo directly)"]], onChange))),
    field("Description", text(flow, "description", onChange, { placeholder: "What this flow does" })),
    h("details", {},
      h("summary", {}, "Defaults for all claude steps"),
      h("div", { class: "grid" },
        field("Model", text(d, "model", onChange, { list: "models", placeholder: "(CLI default)" })),
        field("Permission mode", select(d, "permission_mode", PERMISSION_MODES.map((m) => [m, m]), onChange, { emptyLabel: "acceptEdits (default)" })),
        field("Timeout (sec)", text(d, "timeout_sec", onChange, { type: "number" })),
        field("Max visits / step", text(d, "max_visits", onChange, { type: "number", placeholder: "5" })),
        field("Budget / step ($)", text(d, "max_budget_usd", onChange, { type: "number" }))),
      h("div", { style: { marginTop: "10px" } },
        field("Allowed tools", list(d, "allowed_tools", onChange, 'Read, Edit, Write, Bash(npm *)'), "Comma-separated. Shell commands Claude may run without asking."))),
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
  const base = [["next", "next step"], ["end", "end (success)"], ["fail", "fail run"]];
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

  let body;
  if (step.type === "claude") {
    const prompt = area(step, "prompt", onChange, { rows: 7, placeholder: "What should Claude do? Use {{task}} for the run's task." });
    const chips = ["{{task}}", ...vars.map((v) => `{{vars.${v}}}`), ...earlier.map((id) => `{{steps.${id}.output}}`)];
    body = [
      field("Prompt", prompt),
      h("div", { class: "chips" }, chips.map((c) => h("button", { class: "chip", type: "button", onClick: () => insertAtCursor(prompt, c) }, c))),
      h("div", { class: "grid" },
        field("Model", text(step, "model", onChange, { list: "models", placeholder: flow.defaults?.model ?? "(default)" })),
        field("Permissions", select(step, "permission_mode", PERMISSION_MODES.map((m) => [m, m]), onChange, { emptyLabel: `${flow.defaults?.permission_mode ?? "acceptEdits"} (default)` })),
        field("Continue session of", select(step, "resume", priorClaude, onChange, { emptyLabel: "— new session —" }))),
      field("Allowed tools", list(step, "allowed_tools", onChange, flow.defaults?.allowed_tools?.join(", ") || "(flow default)")),
      h("details", {},
        h("summary", {}, "Advanced"),
        h("div", { class: "grid" },
          field("Extra system prompt", area(step, "system_prompt", onChange, { rows: 2 })),
          field("Budget ($)", text(step, "max_budget_usd", onChange, { type: "number" })))),
    ];
  } else {
    const run = area(step, "run", onChange, { rows: 3, placeholder: "npm test" });
    body = [
      field("Command", run, "Exit code 0 = success. Task and step outputs are in $FACTORY_TASK / $FACTORY_OUT_<STEP_ID>."),
      h("div", { class: "chips" }, ["{{workdir}}", ...vars.map((v) => `{{vars.${v}}}`)].map((c) => h("button", { class: "chip", type: "button", onClick: () => insertAtCursor(run, c) }, c))),
    ];
  }

  return h("div", { class: `card${selected === i ? " selected" : ""}`, id: `step-${i}`, onFocusin: () => selected !== i && onSelect(i, false) },
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
      h("span", { class: `pill ${step.type}` }, step.type === "claude" ? "◆ claude" : "$ shell"),
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Move up", disabled: i === 0, onClick: () => move(-1) }, "↑"),
      h("button", { class: "icon", title: "Move down", disabled: i === flow.steps.length - 1, onClick: () => move(1) }, "↓"),
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
      h("div", { class: "grid" },
        field("Pass only if output matches", text(step, "pass_if", onChange, { mono: true, placeholder: "regex, e.g. ^VERDICT: APPROVE" })),
        field("Fail if output matches", text(step, "fail_if", onChange, { mono: true, placeholder: "regex" })))));
}

function insertBar(flow, at, rerender, onSelect) {
  const add = (type) => {
    const step = type === "claude"
      ? { id: uniqueId(flow, "claude"), type, prompt: "" }
      : { id: uniqueId(flow, "shell"), type, run: "" };
    flow.steps.splice(at, 0, step);
    onSelect(at);
    rerender();
  };
  return h("div", { class: "insert" },
    h("button", { class: "small", onClick: () => add("claude") }, "+ Claude step"),
    h("button", { class: "small", onClick: () => add("shell") }, "+ Shell step"));
}

/** Visual editor for a flow object. Field edits call onChange; structural edits call rerender. */
export function renderEditor(flow, ctx) {
  flow.steps ??= [];
  const { rerender, onSelect } = ctx;
  return h("div", { class: "steps" },
    h("datalist", { id: "models" }, MODELS.map((m) => h("option", { value: m }))),
    settingsCard(flow, ctx.onChange, rerender),
    h("h3", { style: { margin: "22px 0 4px" } }, `Steps (${flow.steps.length})`),
    insertBar(flow, 0, rerender, onSelect),
    flow.steps.map((s, i) => [stepCard(flow, s, i, ctx), insertBar(flow, i + 1, rerender, onSelect)]));
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
