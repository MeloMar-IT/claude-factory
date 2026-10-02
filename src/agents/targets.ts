import type { Config, ProviderConfig } from "../config.js";
import { AGENTS, type ClaudeStep, type Flow } from "../flow/schema.js";

export type Agent = (typeof AGENTS)[number];

export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { kind: "anthropic" },
  openai: { kind: "openai" },
  ollama: { kind: "ollama", base_url: "http://localhost:11434" },
  lmstudio: { kind: "lmstudio", base_url: "http://localhost:1234" },
};

export const LOCAL_KINDS: ProviderConfig["kind"][] = ["ollama", "lmstudio"];

export function providers(config: Config): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = { ...BUILTIN_PROVIDERS };
  for (const [name, p] of Object.entries(config.providers)) {
    merged[name] = { ...BUILTIN_PROVIDERS[name], ...p, base_url: p.base_url ?? BUILTIN_PROVIDERS[name]?.base_url };
  }
  return merged;
}

export interface ModelSpec {
  agent?: Agent;
  provider?: string;
  model?: string;
}

/**
 * "sonnet" · "codex" · "codex:gpt-5" · "ollama:qwen3-coder:30b" · "codex:ollama:gpt-oss:20b".
 * Leading tokens that name an agent, then a provider, are peeled off; the rest is the model
 * (local model names may contain colons).
 */
export function parseSpec(spec: string | undefined, providerNames: string[]): ModelSpec {
  if (!spec?.trim()) return {};
  const parts = spec.trim().split(":");
  const out: ModelSpec = {};
  if ((AGENTS as readonly string[]).includes(parts[0]!)) out.agent = parts.shift() as Agent;
  if (parts.length && providerNames.includes(parts[0]!)) out.provider = parts.shift();
  if (parts.length && parts.join(":")) out.model = parts.join(":");
  return out;
}

export function formatSpec(t: { agent: Agent; provider: string; model?: string }): string {
  return [t.agent, t.provider, t.model].filter(Boolean).join(":");
}

export interface Target {
  agent: Agent;
  providerName: string;
  provider: ProviderConfig;
  model?: string;
  /** Local model or subscription login: no per-token cost is charged. */
  free: boolean;
  /** Human-readable, e.g. "codex:openai:gpt-5". */
  label: string;
}

/** Turn a spec into a runnable target, filling in the agent's default provider. */
export function toTarget(spec: ModelSpec, config: Config, overrides: { agent?: Agent; provider?: string } = {}): Target {
  const all = providers(config);
  const agent = overrides.agent ?? spec.agent ?? "claude";
  const providerName = overrides.provider ?? spec.provider ?? (agent === "codex" ? "openai" : "anthropic");
  const provider = all[providerName];
  if (!provider) throw new Error(`unknown provider "${providerName}" (known: ${Object.keys(all).join(", ")})`);
  if (agent === "claude" && provider.kind === "openai") throw new Error(`Claude Code can't use the openai provider — use agent codex`);
  if (agent === "codex" && (provider.kind === "anthropic" || provider.kind === "anthropic-compatible")) {
    throw new Error(`Codex can't use the ${providerName} provider — use openai, ollama or lmstudio`);
  }
  const model = spec.model ?? provider.default_model;
  const local = LOCAL_KINDS.includes(provider.kind);
  if (local && !model) throw new Error(`provider ${providerName} needs a model, e.g. ${providerName}:qwen3-coder`);
  return {
    agent,
    providerName,
    provider,
    model,
    free: local || (provider.kind === "openai" && !provider.price && !process.env.CODEX_API_KEY),
    label: formatSpec({ agent, provider: providerName, model }),
  };
}

export function specOf(text: string | undefined, config: Config): ModelSpec {
  return parseSpec(text, Object.keys(providers(config)));
}

/** First router rule matching this step, if any. */
export function routeModel(config: Config, flowName: string, stepId: string, visit: number): string | undefined {
  return config.router.rules.find(
    (r) =>
      (!r.step || new RegExp(r.step).test(stepId)) &&
      (!r.flow || new RegExp(r.flow).test(flowName)) &&
      (!r.min_visit || visit >= r.min_visit),
  )?.model;
}

/**
 * Which agent/provider/model runs this step. A matching router rule wins (it is your global
 * policy, and blocks hard-code models); otherwise step.model → flow defaults.model →
 * config.default_model, with explicit agent/provider fields (step, then flow) on top.
 */
export function resolveTarget(step: ClaudeStep, flow: Flow, config: Config, visit: number): Target {
  const routed = routeModel(config, flow.name, step.id, visit);
  if (routed) return toTarget(specOf(routed, config), config);
  const d = flow.defaults;
  if (step.model) {
    const spec = specOf(step.model, config);
    return toTarget(spec, config, { agent: step.agent ?? (spec.agent ? undefined : d.agent), provider: step.provider });
  }
  const spec = specOf(d.model ?? config.default_model, config);
  const inheritedAgent = spec.agent ?? d.agent ?? "claude";
  // A step that switches agent (e.g. codex in a sonnet flow) must not inherit the other agent's model.
  if (step.agent && step.agent !== inheritedAgent) return toTarget({}, config, { agent: step.agent, provider: step.provider });
  return toTarget(spec, config, {
    agent: step.agent ?? (spec.agent ? undefined : d.agent),
    provider: step.provider ?? (spec.provider ? undefined : d.provider),
  });
}

/** Fallback targets, in order, that are usable (unknown providers are skipped). */
export function fallbackTargets(config: Config, filter: (t: Target) => boolean = () => true): Target[] {
  const out: Target[] = [];
  for (const f of config.router.fallback) {
    try {
      const t = toTarget(specOf(f, config), config);
      if (filter(t)) out.push(t);
    } catch {
      // misconfigured fallback — ignored here, shown by the provider check in the UI
    }
  }
  return out;
}

const LIMIT_RE = /hit your (?:usage )?limit|rate.?limit|usage limit|limit reached|overloaded|too many requests|quota|\b429\b|\b529\b/i;

/** The service is briefly unavailable (overloaded, at capacity, network): worth a short wait and a retry. */
const TRANSIENT_RE = /at capacity|overloaded|temporarily unavailable|service unavailable|try again (?:later|in a)|internal server error|bad gateway|gateway time-?out|\b50[0234]\b|\b529\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|can't reach the api server|network error|connection (?:reset|refused|error)/i;

export function isTransientError(error: string | undefined, output: string): boolean {
  return TRANSIENT_RE.test(`${error ?? ""}\n${output.length < 400 ? output : ""}`);
}

/** A limit message is short; a long answer that merely mentions "quota" is not one. */
export function isLimitError(error: string | undefined, output: string): boolean {
  return LIMIT_RE.test(`${error ?? ""}\n${output.length < 400 ? output : ""}`);
}

const AUTH_RE = /OAuth session expired|Failed to authenticate|not (?:logged|signed) in|run \/login|codex login|invalid api key|authentication_error|\b401\b/i;

/** The agent CLI is signed out (expired login, missing key): nothing a retry or another prompt fixes. */
export function isAuthError(error: string | undefined, output: string): boolean {
  return AUTH_RE.test(`${error ?? ""}\n${output.length < 400 ? output : ""}`);
}

/** Environment for Claude Code talking to a non-Anthropic endpoint. */
export function claudeProviderEnv(t: Target): NodeJS.ProcessEnv {
  const p = t.provider;
  if (p.kind === "anthropic") return {};
  const token = p.kind === "anthropic-compatible" ? (p.api_key_env ? process.env[p.api_key_env] : undefined) : p.kind;
  if (p.kind === "anthropic-compatible" && !p.base_url) throw new Error(`provider ${t.providerName} needs base_url`);
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_BASE_URL: p.base_url,
    ANTHROPIC_AUTH_TOKEN: token ?? "none",
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (t.model) {
    // Background and sub-agent calls must hit the same model, not a Claude alias the server doesn't have.
    for (const k of ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) env[k] = t.model;
  }
  return env;
}
