import { h } from "./dom.js";
import { area, field, insertAtCursor, list, select, setKey, text } from "./fields.js";

const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];

/** Per step type: icon, label and the fields of a new step. */
export const STEP_TYPES = {
  claude: { icon: "◆", label: "Claude", blank: { type: "claude", prompt: "" } },
  shell: { icon: "$", label: "Shell", blank: { type: "shell", run: "" } },
  approval: { icon: "✋", label: "Approval (wait for a human)", blank: { type: "approval", message: "Continue?" } },
  parallel: { icon: "⇉", label: "Parallel (run steps at once)", blank: { type: "parallel", steps: [] } },
  flow: { icon: "⧉", label: "Sub-flow (run another flow)", blank: { type: "flow", flow: "" } },
};

const chips = (target, values) =>
  h("div", { class: "chips" }, values.map((c) => h("button", { class: "chip", type: "button", onClick: () => insertAtCursor(target, c) }, c)));

/** The type-specific part of a step card. */
export function stepBody(flow, step, i, { onChange, rerender, vars, earlier, priorClaude }) {
  const d = flow.defaults ?? {};
  switch (step.type) {
    case "claude": {
      const prompt = area(step, "prompt", onChange, { rows: 7, placeholder: "What should Claude do? Use {{task}} for the run's task." });
      return [
        field("Prompt", prompt),
        chips(prompt, ["{{task}}", "{{learnings}}", "{{run.history}}", ...vars.map((v) => `{{vars.${v}}}`), ...earlier.map((id) => `{{steps.${id}.output}}`)]),
        h("div", { class: "grid" },
          field("Model", text(step, "model", onChange, { list: "models", placeholder: d.model ?? "(default)" })),
          field("Permissions", select(step, "permission_mode", PERMISSION_MODES.map((m) => [m, m]), onChange, { emptyLabel: `${d.permission_mode ?? "acceptEdits"} (default)` })),
          field("Continue session of", select(step, "resume", priorClaude, onChange, { emptyLabel: "— new session —" }))),
        field("Allowed tools", list(step, "allowed_tools", onChange, d.allowed_tools?.join(", ") || "(flow default)")),
        h("details", {},
          h("summary", {}, "Advanced"),
          h("div", { class: "grid" },
            field("Extra system prompt", area(step, "system_prompt", onChange, { rows: 2 })),
            field("Budget ($)", text(step, "max_budget_usd", onChange, { type: "number" }))),
          checkbox(step, "sandbox", "Sandbox Claude's bash tool for this step", onChange, flow.sandbox?.claude)),
      ];
    }
    case "shell": {
      const run = area(step, "run", onChange, { rows: 3, placeholder: "npm test" });
      return [
        field("Command", run, "Exit code 0 = success. Untrusted text is in env: $FACTORY_TASK, $FACTORY_OUT_<STEP_ID>, $FACTORY_VAR_<NAME>."),
        chips(run, ["{{workdir}}", "{{run.id}}", ...vars.map((v) => `{{vars.${v}}}`)]),
        checkbox(step, "sandbox", "Run in Docker (for commands that execute repo code, like tests)", onChange),
      ];
    }
    case "approval":
      return [
        field("Question for the approver", area(step, "message", onChange, { rows: 2 }), "The run pauses here. Approve → on success, reject → on failure. Approve in the UI, with `factory approve`, or /approve on the ticket."),
      ];
    case "parallel": {
      const candidates = flow.steps.filter((s) => s !== step && (s.type === "claude" || s.type === "shell"));
      step.steps ??= [];
      return [
        field("Run these steps at the same time", h("div", { class: "checks" },
          candidates.length
            ? candidates.map((s) => h("label", { class: "row", style: { gap: "6px" } },
                h("input", { type: "checkbox", style: { width: "auto" }, checked: step.steps.includes(s.id), onChange: (e) => {
                  step.steps = e.target.checked ? [...step.steps, s.id] : step.steps.filter((x) => x !== s.id);
                  rerender();
                } }),
                h("span", { class: "mono" }, s.id), s.jump_only ? null : h("span", { class: "muted" }, "(tip: mark it “only reachable via jumps”)")))
            : h("span", { class: "muted" }, "Add claude or shell steps first.")),
          "Succeeds when all of them succeed. Output combines theirs."),
      ];
    }
    case "flow": {
      step.vars ??= {};
      const entries = Object.entries(step.vars);
      const setVars = (e) => { step.vars = Object.fromEntries(e); onChange(); };
      return [
        field("Flow to run", text(step, "flow", onChange, { list: "flow-names", mono: true, placeholder: "flow name" }), "Runs in the same workspace. Its steps appear as <this id>/<step>."),
        h("div", { class: "kv" },
          entries.flatMap(([k, v], j) => [
            h("input", { class: "mono", value: k, placeholder: "var", onChange: (e) => { entries[j][0] = e.target.value.trim(); setVars(entries); rerender(); } }),
            h("input", { class: "mono", value: v, placeholder: "value (may use {{vars.x}})", onInput: (e) => { entries[j][1] = e.target.value; setVars(entries); } }),
            h("button", { class: "icon", onClick: () => { entries.splice(j, 1); setVars(entries); rerender(); } }, "✕"),
          ])),
        h("button", { class: "small", onClick: () => { entries.push([`var${entries.length + 1}`, ""]); setVars(entries); rerender(); } }, "+ Variable for sub-flow"),
      ];
    }
    default:
      return [h("p", { class: "status bad" }, `Unknown step type "${step.type}" — edit it in the YAML tab.`)];
  }
}

function checkbox(obj, key, label, onChange, inherited) {
  return h("label", { class: "row", style: { gap: "6px", fontSize: "12.5px" } },
    h("input", { type: "checkbox", style: { width: "auto" }, checked: obj[key] ?? !!inherited, onChange: (e) => { setKey(obj, key, e.target.checked || (inherited ? false : "")); onChange(); } }),
    h("span", {}, label));
}

/** Routes (multi-way branching) and resume point. */
export function stepAdvanced(flow, step, { onChange, rerender, targets }) {
  const routes = step.routes ?? [];
  const setRoutes = (r) => { setKey(step, "routes", r.filter((x) => x.if || x.goto)); onChange(); };
  const opts = [["", "choose…"], ...targets];
  return h("details", { open: routes.length > 0 || !!step.resume_from },
    h("summary", {}, `Branching & resume${routes.length ? ` (${routes.length} route${routes.length > 1 ? "s" : ""})` : ""}`),
    h("div", { class: "route-list" },
      routes.map((r, j) => h("div", { class: "route" },
        h("span", { class: "muted" }, "if output matches"),
        h("input", { class: "mono", value: r.if ?? "", placeholder: "^ROUTE: small", onInput: (e) => { routes[j].if = e.target.value; setRoutes(routes); } }),
        h("span", { class: "muted" }, "go to"),
        h("select", { onChange: (e) => { routes[j].goto = e.target.value; setRoutes(routes); rerender(); } },
          opts.map(([v, l]) => h("option", { value: v, selected: r.goto === v }, l))),
        h("button", { class: "icon", onClick: () => { routes.splice(j, 1); setRoutes(routes); rerender(); } }, "✕")))),
    h("button", { class: "small", onClick: () => { step.routes = [...routes, { if: "", goto: "" }]; rerender(); } }, "+ Route"),
    h("small", { class: "muted", style: { display: "block", margin: "6px 0 10px" } }, "Checked on success, before “On success”. First match wins."),
    field("When resumed after stopping here, restart at",
      select(step, "resume_from", flow.steps.filter((s) => s !== step).map((s) => [s.id, s.id]), () => { onChange(); rerender(); }, { emptyLabel: step.jump_only ? "the step that jumped here" : "this step" })));
}
