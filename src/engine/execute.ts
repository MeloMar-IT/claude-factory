import { join } from "node:path";
import type { Config } from "../config.js";
import { loadFlow } from "../flow/load.js";
import type { Flow, Step } from "../flow/schema.js";
import { runClaude } from "../steps/claude.js";
import { runShell } from "../steps/shell.js";
import type { RunSummary, StepRecord } from "./state.js";
import { outputEnvName, render, varEnvName, type TemplateContext } from "./template.js";

/** Shell commands may only template trusted values; task and outputs go via env. */
export const SHELL_TEMPLATE_ROOTS = ["vars", "workdir", "run"] as const;
export const DEFAULT_PERMISSION_MODE = "acceptEdits";
const MAX_FLOW_DEPTH = 5;

export type StepContext = TemplateContext & {
  vars: Record<string, string>;
  steps: Record<string, Record<string, unknown>>;
  run: Record<string, unknown>;
};

/** One flow being executed: the top-level flow or a sub-flow. */
export interface Scope {
  flow: Flow;
  ctx: StepContext;
  visits: Record<string, number>;
  /** History id prefix for sub-flow steps, e.g. "build/". */
  prefix: string;
  depth: number;
}

export type Outcome = "succeeded" | "failed" | "stopped" | "waiting" | "cancelled";

export interface LoopResult {
  outcome: Outcome;
  reason?: string;
  /** Step to continue from if the run is resumed. */
  next: string | null;
  lastOutput: string;
}

export interface Engine {
  summary: RunSummary;
  config: Config;
  baseEnv: Record<string, string>;
  logsDir: string;
  claudeBin?: string;
  signal?: AbortSignal;
  log: (msg: string) => void;
  save: () => void;
  /** Remaining budget in USD for the next claude call (undefined = unlimited). */
  remainingBudget: () => number | undefined;
  runLoop: (scope: Scope, startAt: string | null) => Promise<LoopResult>;
  /** A human decision for the approval step the run is waiting at (consumed on use). */
  decision?: ApprovalDecision & { stepId: string };
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  note?: string;
}

export type StepResult = Pick<StepRecord, "ok" | "output" | "error" | "exitCode" | "sessionId" | "costUsd">;

export function stepEnv(scope: Scope, engine: Engine): Record<string, string> {
  const env: Record<string, string> = { ...engine.baseEnv };
  for (const [k, v] of Object.entries(scope.ctx.vars)) env[varEnvName(k)] = v;
  for (const [id, s] of Object.entries(scope.ctx.steps)) env[outputEnvName(id)] = String(s.output ?? "");
  return env;
}

export function historySummary(summary: RunSummary): string {
  return summary.history
    .map((h) => `- ${h.id}${h.visit > 1 ? ` (visit ${h.visit})` : ""}: ${h.ok ? "ok" : `FAILED${h.error ? ` — ${h.error}` : ""}`}`)
    .join("\n");
}

/** Store a finished step in history and in the scope's template context. */
export function recordStep(step: Step, scope: Scope, engine: Engine, res: StepResult, startedAt: Date, logFile: string, visit: number): StepRecord {
  const rec: StepRecord = {
    id: scope.prefix + step.id,
    type: step.type,
    visit,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    logFile,
    ...res,
    ...(scope.prefix ? { parent: scope.prefix.slice(0, -1) } : {}),
  };
  engine.summary.history.push(rec);
  engine.summary.totalCostUsd += res.costUsd ?? 0;
  scope.ctx.steps[step.id] = {
    ok: res.ok,
    output: res.output,
    error: res.error ?? "",
    exit_code: res.exitCode ?? "",
    session_id: res.sessionId ?? "",
    visit,
  };
  engine.save();
  const secs = (rec.durationMs / 1000).toFixed(1);
  engine.log(`${res.ok ? "✔" : "✘"} ${rec.id} (${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(4)}` : ""})${res.error ? ` — ${res.error}` : ""}`);
  return rec;
}

export function newLogFile(engine: Engine, id: string): string {
  return join(engine.logsDir, `${String(engine.summary.history.length + 1).padStart(3, "0")}-${id.replace(/\//g, "__")}.log`);
}

/** Execute a claude, shell, parallel or flow step (approvals are handled by the loop). */
export async function executeStep(step: Step, scope: Scope, engine: Engine, logFile: string): Promise<StepResult> {
  const d = scope.flow.defaults;
  const timeoutSec = step.timeout_sec ?? d.timeout_sec;
  const timeoutMs = timeoutSec ? timeoutSec * 1000 : undefined;
  const { ctx } = scope;
  ctx.run.history = historySummary(engine.summary);

  switch (step.type) {
    case "claude": {
      const resumeFrom = step.resume ? ctx.steps[step.resume]?.session_id : undefined;
      const caps = [step.max_budget_usd ?? d.max_budget_usd, engine.remainingBudget()].filter((n): n is number => n !== undefined);
      const r = await runClaude({
        prompt: render(step.prompt, ctx),
        systemPrompt: step.system_prompt ? render(step.system_prompt, ctx) : undefined,
        cwd: engine.summary.workdir!,
        env: stepEnv(scope, engine),
        logFile,
        claudeBin: engine.claudeBin,
        model: step.model ?? d.model,
        permissionMode: step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE,
        allowedTools: step.allowed_tools ?? d.allowed_tools,
        resumeSessionId: typeof resumeFrom === "string" && resumeFrom ? resumeFrom : undefined,
        maxBudgetUsd: caps.length ? Math.max(0.01, Math.min(...caps)) : undefined,
        sandbox: step.sandbox ?? scope.flow.sandbox.claude ?? engine.config.sandbox.claude,
        timeoutMs,
        signal: engine.signal,
        onProgress: (m) => engine.log(`    · ${m}`),
      });
      return { ok: r.ok, output: r.output, error: r.error, sessionId: r.sessionId, costUsd: r.costUsd };
    }

    case "shell": {
      const image = scope.flow.sandbox.docker_image ?? engine.config.sandbox.docker_image;
      if (step.sandbox && !image) engine.log(`    ⚠ ${step.id}: not sandboxed (no sandbox.docker_image configured)`);
      const r = await runShell({
        command: render(step.run, ctx, SHELL_TEMPLATE_ROOTS),
        cwd: engine.summary.workdir!,
        env: stepEnv(scope, engine),
        logFile,
        timeoutMs,
        signal: engine.signal,
        dockerImage: step.sandbox ? image : undefined,
      });
      return { ok: r.ok, output: r.output, error: r.error, exitCode: r.exitCode };
    }

    case "parallel": {
      const byId = new Map(scope.flow.steps.map((s) => [s.id, s]));
      engine.log(`  ⇉ running ${step.steps.join(", ")} in parallel`);
      const results = await Promise.all(
        step.steps.map(async (id) => {
          const sub = byId.get(id)!;
          const visit = (scope.visits[id] = (scope.visits[id] ?? 0) + 1);
          const started = new Date();
          const lf = newLogFile(engine, scope.prefix + id);
          let res: StepResult;
          try {
            res = await executeStep(sub, scope, engine, lf);
          } catch (e) {
            res = { ok: false, output: "", error: (e as Error).message };
          }
          res = applyChecks(sub, res);
          recordStep(sub, scope, engine, res, started, lf, visit);
          return { id, res };
        }),
      );
      const failed = results.filter((r) => !r.res.ok).map((r) => r.id);
      return {
        ok: failed.length === 0,
        output: results.map((r) => `## ${r.id}\n${r.res.output}`).join("\n\n"),
        error: failed.length ? `failed: ${failed.join(", ")}` : undefined,
      };
    }

    case "flow": {
      if (scope.depth >= MAX_FLOW_DEPTH) return { ok: false, output: "", error: `sub-flows nested deeper than ${MAX_FLOW_DEPTH}` };
      const { flow } = loadFlow(step.flow, engine.summary.repo);
      if (flow.steps.some((s) => s.type === "approval")) {
        return { ok: false, output: "", error: `sub-flow "${flow.name}" contains approval steps; put approvals in the parent flow` };
      }
      const vars = { ...flow.vars, ...ctx.vars };
      for (const [k, v] of Object.entries(step.vars ?? {})) vars[k] = render(v, ctx, SHELL_TEMPLATE_ROOTS);
      const subScope: Scope = {
        flow,
        ctx: { ...ctx, vars, steps: {}, run: { ...ctx.run } },
        visits: {},
        prefix: `${scope.prefix}${step.id}/`,
        depth: scope.depth + 1,
      };
      engine.log(`  ↳ sub-flow ${flow.name}`);
      const r = await engine.runLoop(subScope, null);
      const ok = r.outcome === "succeeded";
      return { ok, output: r.lastOutput, error: ok ? undefined : `sub-flow ${flow.name} ${r.outcome}${r.reason ? `: ${r.reason}` : ""}` };
    }

    case "approval":
      throw new Error("approval steps are handled by the loop");
  }
}

export function applyChecks(step: Step, res: StepResult): StepResult {
  if (!res.ok) return res;
  if (step.fail_if && new RegExp(step.fail_if, "m").test(res.output)) {
    return { ...res, ok: false, error: `output matched fail_if /${step.fail_if}/` };
  }
  if (step.pass_if && !new RegExp(step.pass_if, "m").test(res.output)) {
    return { ...res, ok: false, error: `output did not match pass_if /${step.pass_if}/` };
  }
  return res;
}
