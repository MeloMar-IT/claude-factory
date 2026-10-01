import type { ClaudeStep } from "../flow/schema.js";
import { runClaude } from "../steps/claude.js";
import { runCodex, type CodexSandbox } from "../steps/codex.js";
import { DEFAULT_PERMISSION_MODE, stepEnv, type Engine, type Scope, type StepResult } from "../engine/execute.js";
import { render } from "../engine/template.js";
import { BUILTIN_PROVIDERS, claudeProviderEnv, fallbackTargets, isLimitError, LOCAL_KINDS, resolveTarget, type Target } from "./targets.js";

const WRITE_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)\b/;

/** Map Claude permission settings onto Codex's sandbox modes. */
export function codexSandbox(step: ClaudeStep, scope: Scope, sandboxed: boolean): CodexSandbox {
  const d = scope.flow.defaults;
  const mode = step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE;
  const tools = step.allowed_tools ?? d.allowed_tools ?? [];
  if (mode === "plan" || (mode === "dontAsk" && !tools.some((t) => WRITE_TOOL.test(t)))) return "read-only";
  if (mode === "bypassPermissions" && !sandboxed) return "danger-full-access";
  return "workspace-write";
}

async function runOn(t: Target, step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs?: number): Promise<StepResult> {
  const { ctx, flow } = scope;
  const d = flow.defaults;
  const local = LOCAL_KINDS.includes(t.provider.kind);
  const sandboxed = step.sandbox ?? flow.sandbox.claude ?? engine.config.sandbox.claude ?? false;
  const effort = step.effort ?? d.effort;
  const prev = step.resume ? ctx.steps[step.resume] : undefined;
  const prevAgent = String(prev?.agent || "claude").split(":")[0];
  const resumeId = prev && prevAgent === t.agent && typeof prev.session_id === "string" && prev.session_id ? prev.session_id : undefined;
  if (prev && !resumeId) engine.log(`    · not resuming ${step.resume}: it ran on ${prevAgent}, this step on ${t.agent}`);
  const common = {
    prompt: render(step.prompt, ctx),
    systemPrompt: step.system_prompt ? render(step.system_prompt, ctx) : undefined,
    cwd: engine.summary.workdir!,
    logFile,
    timeoutMs,
    signal: engine.signal,
    resumeSessionId: resumeId,
    onProgress: (m: string) => engine.log(`    · ${m}`),
  };
  engine.log(`    · agent ${t.label}`);

  if (t.agent === "codex") {
    const builtinUrl = BUILTIN_PROVIDERS[t.providerName]?.base_url;
    const r = await runCodex({
      ...common,
      env: { ...stepEnv(scope, engine), ...agentEnv(scope.ctx.vars.agent_env) },
      codexBin: engine.codexBin,
      model: t.model,
      localProvider: local ? t.provider.kind : undefined,
      localBaseUrl: local && t.provider.base_url !== builtinUrl ? t.provider.base_url : undefined,
      sandbox: codexSandbox(step, scope, sandboxed),
      effort,
    });
    const p = t.provider.price;
    const costUsd = p ? (r.inputTokens * p.input_per_mtok + r.outputTokens * p.output_per_mtok) / 1e6 : 0;
    return { ok: r.ok, output: r.output, error: r.error, sessionId: r.sessionId, costUsd, agent: t.label, tokens: { input: r.inputTokens, output: r.outputTokens } };
  }

  // No --max-budget-usd at all when cost limits are off (fixed-price subscriptions); costs are still recorded.
  const caps = t.free || !engine.config.cost_limits ? [] : [step.max_budget_usd ?? d.max_budget_usd, engine.remainingBudget()].filter((n): n is number => n !== undefined);
  const r = await runClaude({
    ...common,
    env: { ...stepEnv(scope, engine), ...agentEnv(scope.ctx.vars.agent_env), ...claudeProviderEnv(t) },
    claudeBin: engine.claudeBin,
    model: t.model,
    permissionMode: step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE,
    allowedTools: step.allowed_tools ?? d.allowed_tools,
    maxBudgetUsd: caps.length ? Math.max(0.01, Math.min(...caps)) : undefined,
    sandbox: sandboxed,
    noMcp: local,
    isolated: engine.config.isolate_agents,
    effort,
  });
  for (const d of r.denied ?? []) engine.log(`    ⚠ blocked: ${d}`);
  return {
    ok: r.ok,
    output: r.output,
    error: r.error,
    sessionId: r.sessionId,
    ...(r.denied ? { denied: r.denied } : {}),
    // Claude Code prices unknown local models as if they were Claude — they cost nothing.
    costUsd: local ? 0 : r.costUsd,
    agent: t.label,
    tokens: r.inputTokens !== undefined ? { input: r.inputTokens, output: r.outputTokens ?? 0 } : undefined,
  };
}

/**
 * Run an agent step on the target the step, router and defaults pick. On a rate or usage
 * limit, retry on the router's fallbacks in order. When the budget is used up the loop sets
 * engine.budgetFallback and every agent step runs on that free target instead.
 */
export async function runAgentStep(step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs?: number): Promise<StepResult> {
  const { config } = engine;
  let target: Target;
  try {
    target = engine.budgetFallback ?? resolveTarget(step, scope.flow, config, scope.visits[step.id] ?? 1);
  } catch (e) {
    return { ok: false, output: "", error: (e as Error).message };
  }
  const fallbacks = config.router.fallback_on.includes("rate_limit") ? fallbackTargets(config) : [];
  const tried = new Set<string>();
  for (;;) {
    tried.add(target.label);
    const r = await runOn(target, step, scope, engine, logFile, timeoutMs);
    if (r.ok || engine.signal?.aborted || !isLimitError(r.error, r.output)) return r;
    const next = fallbacks.find((t) => !tried.has(t.label));
    // No model left to try: the loop pauses the run until the limit resets.
    if (!next) return { ...r, limited: true, error: `usage limit reached: ${r.output.trim().split("\n")[0] || r.error}` };
    engine.log(`    ↪ ${target.label} hit a limit — retrying on ${next.label}`);
    engine.summary.totalCostUsd += r.costUsd ?? 0;
    target = next;
  }
}

/**
 * Extra environment for agent steps from the `agent_env` flow variable: `KEY=value` pairs, one per
 * line or separated by `;` (e.g. `JAVA_HOME=/path/to/jdk`), so agents can run the project's build.
 * Names with the FACTORY_ or SCF_ prefix and a few sensitive ones are ignored.
 */
export function agentEnv(spec: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of (spec ?? "").split(/[\n;]/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(part);
    if (m && !/^(PATH|HOME|FACTORY_.*|SCF_.*|ANTHROPIC_.*|OPENAI_.*|GH_TOKEN|GITHUB_TOKEN)$/.test(m[1]!)) env[m[1]!] = m[2]!;
  }
  return env;
}
