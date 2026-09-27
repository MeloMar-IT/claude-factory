import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";

const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
const section = (title, ...children) => h("div", { class: "card", style: { marginBottom: "14px" } }, h("h3", {}, title), ...children);
const okPill = (ok, text) => h("span", { class: `pill ${ok ? "ok" : "fail"}` }, text ?? (ok ? "ready" : "not ready"));

/** Model specs to suggest in every model field. */
function specSuggestions(providers) {
  const out = ["sonnet", "opus", "haiku", "codex"];
  for (const p of providers) {
    if (!p.ok || !p.models.length) continue;
    for (const m of p.models) {
      out.push(`${p.name}:${m}`);
      if (p.agents.includes("codex")) out.push(`codex:${p.name}:${m}`);
    }
  }
  return out;
}

/** Body-level datalists (#models, #provider-names) used by every model/provider field. */
export async function refreshModelLists(st) {
  try {
    st ??= await api.providers();
  } catch {
    st = { providers: [] };
  }
  const put = (id, values) => {
    let dl = document.getElementById(id);
    if (!dl) document.body.append((dl = h("datalist", { id })));
    mount(dl, values.map((v) => h("option", { value: v })));
  };
  put("models", specSuggestions(st.providers));
  put("provider-names", st.providers.map((p) => p.name));
  return st;
}

function testBox(defaultSpec) {
  const spec = input(defaultSpec, { class: "mono", list: "models", placeholder: "e.g. ollama:qwen3-coder" });
  const out = h("span", { class: "muted" });
  const btn = h("button", { onClick: async () => {
    btn.disabled = true;
    mount(out, h("span", { class: "spinner" }), " asking the model… (local models can take a few minutes)");
    try {
      const r = await api.testModel(spec.value.trim());
      mount(out, okPill(r.ok, r.ok ? "works" : "failed"), h("span", { class: "mono" }, ` ${r.target} · ${r.seconds}s`),
        !r.ok ? h("span", { class: "status bad" }, ` ${r.error ?? r.output}`) : null);
    } catch (e) {
      mount(out, h("span", { class: "status bad" }, e.message));
    } finally {
      btn.disabled = false;
    }
  } }, "Test");
  return h("div", { class: "row" }, spec, btn, out);
}

function agentsCard(agents) {
  return section("Coding agents",
    h("p", { class: "muted", style: { margin: 0 } }, "Agent steps run on Claude Code or on OpenAI's Codex CLI (with your ChatGPT account). Pick one per step, per flow, or with routing rules below."),
    h("table", { class: "table compact" },
      h("tbody", {}, agents.map((a) => h("tr", {},
        h("td", {}, h("b", {}, a.agent === "claude" ? "Claude Code" : "Codex (ChatGPT)")),
        h("td", {}, okPill(a.installed && a.loggedIn !== false, !a.installed ? "not installed" : a.loggedIn === false ? "not logged in" : "ready")),
        h("td", { class: "mono muted" }, a.version ?? ""),
        h("td", { class: "muted" }, a.detail))))),
    agents.find((a) => a.agent === "codex" && (!a.installed || a.loggedIn === false))
      ? h("p", { class: "muted", style: { margin: 0 } }, "To use ChatGPT: run ", h("code", {}, "npm i -g @openai/codex"), " then ", h("code", {}, "codex login"), " in a terminal, and reload this page.")
      : null);
}

function providersCard(cfg, providers, reload) {
  const custom = new Set(Object.keys(cfg.providers));
  const name = input("", { class: "mono", placeholder: "my-proxy" });
  const kind = h("select", {}, ["ollama", "lmstudio", "anthropic-compatible"].map((k) => h("option", { value: k }, k)));
  const url = input("", { class: "mono", placeholder: "http://localhost:11434" });
  const keyEnv = input("", { class: "mono", placeholder: "MY_API_KEY (optional)" });
  const defModel = input("", { class: "mono", placeholder: "qwen3-coder" });
  const add = async () => {
    const n = name.value.trim();
    if (!/^[a-z][\w-]*$/.test(n)) return toast("Name: lowercase letters, digits, - or _", "error");
    const c = await api.config();
    c.providers[n] = { kind: kind.value, base_url: url.value.trim() || undefined, api_key_env: keyEnv.value.trim() || undefined, default_model: defModel.value.trim() || undefined };
    await api.saveConfig(c).then(() => { toast(`Provider ${n} saved`); reload(); }, (e) => toast(e.message, "error"));
  };
  const remove = async (n) => {
    const c = await api.config();
    delete c.providers[n];
    await api.saveConfig(c);
    reload();
  };
  return section("Providers",
    h("p", { class: "muted", style: { margin: 0 } }, "Where models run. Local providers cost nothing and keep code on your Mac; runs record them at $0."),
    h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Provider", "Status", "Used by", "Models", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, providers.map((p) => h("tr", {},
        h("td", {}, h("b", { class: "mono" }, p.name), h("div", { class: "muted mono", style: { fontSize: "11px" } }, p.base_url ?? p.kind)),
        h("td", {}, okPill(p.ok, p.ok ? "ok" : "unreachable"), h("div", { class: "muted", style: { fontSize: "11.5px" } }, p.detail)),
        h("td", { class: "muted" }, p.agents.join(", ")),
        h("td", {}, p.models.length ? h("div", { class: "row", style: { gap: "4px" } }, p.models.map((m) => h("span", { class: "pill mono" }, m))) : h("span", { class: "muted" }, "—")),
        h("td", {}, custom.has(p.name) ? h("button", { class: "small danger", onClick: () => remove(p.name) }, "Remove") : null))))),
    providers.some((p) => p.kind === "ollama" && p.ok && !p.models.some((m) => /coder|gpt-oss|devstral/.test(m)))
      ? h("p", { class: "muted", style: { margin: 0 } }, "Tip: general chat models are weak at tool use. Pull a coding model, e.g. ", h("code", {}, "ollama pull qwen3-coder:30b"), " or ", h("code", {}, "ollama pull gpt-oss:20b"), ".")
      : null,
    f("Try a model", testBox(providers.find((p) => p.kind === "ollama" && p.models.length) ? `ollama:${providers.find((p) => p.kind === "ollama").models[0]}` : "haiku"),
      "Sends one tiny read-only prompt through the agent and provider."),
    h("details", {}, h("summary", {}, "Add a provider (another Ollama/LM Studio host, or an Anthropic-compatible API)"),
      h("div", { class: "grid", style: { marginTop: "10px" } }, f("Name", name), f("Kind", kind), f("Base URL", url), f("API key env var", keyEnv), f("Default model", defModel)),
      h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "primary", onClick: add }, "Add provider"))));
}

const PRESETS = (local) => [
  { label: "Retries on Opus", rules: [{ step: "^(fix|fix_tests|fix_ci|address_review)$", min_visit: 2, model: "opus" }] },
  { label: "Codex reviews Claude's code", rules: [{ step: "^review$", model: "codex" }] },
  ...(local ? [{ label: `Small jobs on ${local}`, rules: [{ step: "^(triage|learn)$", model: local }] }] : []),
];

function routingCard(cfg, specs, localSpec) {
  const rules = cfg.router.rules.map((r) => ({ ...r }));
  const body = h("tbody");
  const defModel = input(cfg.default_model ?? "", { class: "mono", list: "models", placeholder: "Claude Code's default" });
  const fallback = input(cfg.router.fallback.join(", "), { class: "mono", placeholder: `e.g. codex, ${localSpec ?? "ollama:qwen3-coder"}` });
  const onRate = h("input", { type: "checkbox", style: { width: "auto" }, checked: cfg.router.fallback_on.includes("rate_limit") });
  const onBudget = h("input", { type: "checkbox", style: { width: "auto" }, checked: cfg.router.fallback_on.includes("budget") });

  const cell = (r, key, attrs) => h("td", {}, input(r[key] ?? "", { class: "mono", ...attrs, onInput: (e) => {
    const v = e.target.value.trim();
    if (key === "min_visit") r[key] = v ? Number(v) : undefined;
    else r[key] = v || undefined;
  } }));
  const draw = () => mount(body, rules.length ? rules.map((r, i) => h("tr", {},
    cell(r, "step", { placeholder: "any step (regex)" }),
    cell(r, "flow", { placeholder: "any flow (regex)" }),
    cell(r, "min_visit", { type: "number", min: 1, style: { width: "70px" }, placeholder: "1" }),
    cell(r, "model", { list: "models", placeholder: "model spec" }),
    h("td", {}, h("button", { class: "small", title: "Move up", disabled: i === 0, onClick: () => { rules.splice(i - 1, 0, rules.splice(i, 1)[0]); draw(); } }, "↑"),
      h("button", { class: "small danger", onClick: () => { rules.splice(i, 1); draw(); } }, "✕")))) :
    h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No rules: steps use their own model, then the flow's, then the default.")));
  draw();

  const save = async () => {
    const bad = rules.find((r) => !r.model);
    if (bad) return toast("Every rule needs a model", "error");
    const c = await api.config();
    c.default_model = defModel.value.trim() || undefined;
    c.router = {
      rules: rules.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== ""))),
      fallback: fallback.value.split(",").map((s) => s.trim()).filter(Boolean),
      fallback_on: [onRate.checked && "rate_limit", onBudget.checked && "budget"].filter(Boolean),
    };
    await api.saveConfig(c).then(() => toast("Routing saved"), (e) => toast(e.message, "error"));
  };

  return section("Routing",
    h("p", { class: "muted", style: { margin: 0 } },
      "A model spec picks agent, provider and model: ", h("code", {}, "sonnet"), " · ", h("code", {}, "codex"), " · ", h("code", {}, "codex:gpt-5"), " · ",
      h("code", {}, "ollama:qwen3-coder"), " · ", h("code", {}, "codex:ollama:gpt-oss:20b"),
      ". The first matching rule wins — even over models set in flows and blocks. Otherwise: the step's model, the flow's default, then the default below."),
    f("Default model", defModel),
    h("div", {}, h("div", { class: "row", style: { marginBottom: "6px" } }, h("b", {}, "Rules"), h("span", { class: "spacer" }),
      ...PRESETS(localSpec).map((p) => h("button", { class: "small", onClick: () => { rules.push(...p.rules.map((r) => ({ ...r }))); draw(); } }, `+ ${p.label}`)),
      h("button", { class: "small", onClick: () => { rules.push({ model: "" }); draw(); } }, "+ Rule")),
      h("table", { class: "table compact" }, h("thead", {}, h("tr", {}, ["Step", "Flow", "From visit", "Model", ""].map((x) => h("th", {}, x)))), body)),
    f("Fallback models", fallback, "Comma-separated, tried in order."),
    h("div", { class: "row" },
      h("label", { class: "row", style: { gap: "6px" } }, onRate, h("span", {}, "Use them when a model hits a rate or usage limit")),
      h("label", { class: "row", style: { gap: "6px" } }, onBudget, h("span", {}, "Continue on the first free one (local / ChatGPT) when a budget runs out, instead of pausing"))),
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { class: "primary", onClick: save }, "Save routing")));
}

export async function renderModels(main) {
  mount(main, h("div", { class: "row" }, h("span", { class: "spinner" }), " Checking agents and providers…"));
  const [cfg, st] = await Promise.all([api.config(), api.providers()]);
  void refreshModelLists(st);
  const reload = () => renderModels(main);
  const specs = specSuggestions(st.providers);
  const localSpec = specs.find((s) => /^(ollama|lmstudio):/.test(s) && /coder|gpt-oss|devstral/.test(s)) ?? specs.find((s) => /^(ollama|lmstudio):/.test(s) && !/:(0\.5b|135m|1b)$/.test(s));
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Models"), h("span", { class: "muted" }, "Agents, providers and which model runs which step"),
      h("span", { class: "spacer" }), h("button", { onClick: reload }, "↻")),
    agentsCard(st.agents),
    providersCard(cfg, st.providers, reload),
    routingCard(cfg, specs, localSpec));
}
