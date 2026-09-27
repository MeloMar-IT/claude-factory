import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, loadRepoVars, type Config } from "../config.js";
import { FACTORY_HOME } from "../flow/load.js";
import type { Flow, Step } from "../flow/schema.js";
import { notifyRun } from "../notify.js";
import {
  applyChecks,
  executeStep,
  newLogFile,
  recordStep,
  type ApprovalDecision,
  type Engine,
  type LoopResult,
  type Scope,
  type StepResult,
} from "./execute.js";
import { identityEnv, protectedBranchEnv } from "./guards.js";
import { appendLiveLog, loadRun, saveRun, spentToday, type RunStatus, type RunSummary } from "./state.js";
import { render } from "./template.js";
import { prepareWorkspace } from "./workspace.js";

export type { RunSummary, StepRecord } from "./state.js";

const DEFAULT_MAX_VISITS = 5;

interface CommonOptions {
  runsDir: string;
  claudeBin?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Called whenever run.json is written. */
  onUpdate?: (summary: RunSummary) => void;
  /** Defaults to ~/.claude-factory/config.yaml. */
  config?: Config;
}

export interface RunOptions extends CommonOptions {
  task: string;
  repo: string;
  vars?: Record<string, string>;
  /** Pre-allocated run id (e.g. so a UI can subscribe before the run starts). */
  runId?: string;
}

export interface ResumeOptions extends CommonOptions {
  runId: string;
  /** Step to restart at; defaults to where the run stopped. */
  from?: string;
  /** Decision for a run waiting at an approval step. */
  decision?: ApprovalDecision;
}

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${ts}-${randomBytes(2).toString("hex")}`;
}

export function learningsFile(vars: Record<string, string>, repo: string): string {
  const key = vars.github_repo && vars.github_repo !== "owner/repo" ? vars.github_repo : basename(repo);
  return join(process.env.FACTORY_HOME ?? FACTORY_HOME, "learnings", `${key.replace(/[^\w.-]+/g, "__")}.md`);
}

/** Start a new run of a flow. */
export async function runFlow(flow: Flow, opts: RunOptions): Promise<RunSummary> {
  const config = opts.config ?? loadConfig();
  const runId = opts.runId ?? newRunId();
  const runDir = join(opts.runsDir, runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  let repoVars: Record<string, string> = {};
  try {
    if (flow.workspace !== "empty") repoVars = loadRepoVars(opts.repo);
  } catch (e) {
    opts.log?.(`! ignoring repo config: ${(e as Error).message}`);
  }
  const summary: RunSummary = {
    runId,
    flow: flow.name,
    flowDef: flow,
    task: opts.task,
    vars: { ...flow.vars, ...repoVars, ...opts.vars },
    repo: opts.repo,
    status: "running",
    runDir,
    startedAt: new Date().toISOString(),
    totalCostUsd: 0,
    history: [],
    state: { next: null, steps: {}, visits: {} },
  };
  saveRun(summary);
  opts.onUpdate?.(summary);

  try {
    const ws = prepareWorkspace(flow.workspace, opts.repo, runDir, runId);
    summary.workdir = ws.workdir;
    summary.branch = ws.branch;
    try {
      summary.baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.workdir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // not a git checkout yet (e.g. empty workspace)
    }
  } catch (e) {
    return finish(summary, opts, config, { outcome: "failed", reason: (e as Error).message, next: null, lastOutput: "" });
  }
  return drive(summary, opts, config, null);
}

/** Continue a stopped, failed, cancelled, interrupted or waiting run. */
export async function resumeRun(opts: ResumeOptions): Promise<RunSummary> {
  const config = opts.config ?? loadConfig();
  const summary = loadRun(opts.runsDir, opts.runId);
  if (!summary) throw new Error(`run ${opts.runId} not found`);
  if (opts.decision && summary.status !== "waiting") throw new Error(`run ${opts.runId} is not waiting for approval`);
  if (summary.status === "waiting" && !opts.decision && !opts.from) throw new Error("run is waiting for approval: approve or reject it");
  if (summary.status === "succeeded" && !opts.from) throw new Error("run already succeeded (pass a step to re-run from)");
  if (!summary.workdir || !existsSync(summary.workdir)) throw new Error("the run's workspace no longer exists");
  const from = opts.from ?? summary.state.next;
  if (!from) throw new Error("nothing to resume");
  if (!summary.flowDef.steps.some((s) => s.id === from)) throw new Error(`unknown step "${from}"`);

  const decision = opts.decision && summary.waiting ? { ...opts.decision, stepId: summary.waiting.stepId } : undefined;
  Object.assign(summary, { status: "running" as RunStatus, reason: undefined, finishedAt: undefined, resumes: (summary.resumes ?? 0) + 1 });
  summary.state.visits = {}; // fresh loop budget
  return drive(summary, opts, config, { startAt: from, decision });
}

async function drive(
  summary: RunSummary,
  opts: CommonOptions,
  config: Config,
  resume: { startAt: string; decision?: Engine["decision"] } | null,
): Promise<RunSummary> {
  const log = (line: string) => {
    appendLiveLog(summary.runDir, line);
    opts.log?.(line);
  };
  const save = () => {
    saveRun(summary);
    opts.onUpdate?.(summary);
  };
  const lf = learningsFile(summary.vars, summary.repo);

  let baseEnv: Record<string, string>;
  try {
    baseEnv = {
      FACTORY_TASK: summary.task,
      FACTORY_RUN_ID: summary.runId,
      FACTORY_WORKDIR: summary.workdir!,
      FACTORY_BRANCH: summary.branch ?? "",
      FACTORY_LEARNINGS_FILE: lf,
      ...protectedBranchEnv(config.protected_branches),
      ...(await identityEnv(config)),
    };
  } catch (e) {
    return finish(summary, opts, config, { outcome: "failed", reason: (e as Error).message, next: summary.state.next, lastOutput: "" });
  }

  const runCap = summary.flowDef.limits.max_cost_usd;
  const dailyCap = config.daily_budget_usd;
  const engine: Engine = {
    summary,
    config,
    baseEnv,
    logsDir: join(summary.runDir, "logs"),
    claudeBin: opts.claudeBin,
    signal: opts.signal,
    log,
    save,
    decision: resume?.decision,
    remainingBudget: () => {
      const left = [
        runCap !== undefined ? runCap - summary.totalCostUsd : undefined,
        dailyCap !== undefined ? dailyCap - spentToday(opts.runsDir) : undefined,
      ].filter((n): n is number => n !== undefined);
      return left.length ? Math.min(...left) : undefined;
    },
    runLoop: (scope, startAt) => loop(engine, scope, startAt, opts.runsDir),
  };

  const scope: Scope = {
    flow: summary.flowDef,
    ctx: {
      task: summary.task,
      vars: summary.vars,
      workdir: summary.workdir!,
      run: { id: summary.runId, dir: summary.runDir, branch: summary.branch ?? "", history: "" },
      steps: summary.state.steps,
      learnings: existsSync(lf) ? readFileSync(lf, "utf8") : "",
    },
    visits: summary.state.visits,
    prefix: "",
    depth: 0,
  };

  log(resume
    ? `↻ resuming run ${summary.runId} at "${resume.startAt}"${resume.decision ? ` (${resume.decision.approved ? "approved" : "rejected"})` : ""}`
    : `run ${summary.runId} · flow ${summary.flow} · ${summary.workdir}${summary.branch ? ` (branch ${summary.branch})` : ""}`);
  save();

  let result: LoopResult;
  try {
    result = await loop(engine, scope, resume?.startAt ?? null, opts.runsDir);
  } catch (e) {
    result = { outcome: "failed", reason: `internal error: ${(e as Error).message}`, next: summary.state.next, lastOutput: "" };
  }
  return finish(summary, opts, config, result);
}

async function finish(summary: RunSummary, opts: CommonOptions, config: Config, r: LoopResult): Promise<RunSummary> {
  summary.status = r.outcome;
  summary.reason = r.reason;
  summary.state.next = r.next;
  if (r.outcome !== "waiting") summary.waiting = undefined;
  summary.finishedAt = new Date().toISOString();
  saveRun(summary);
  opts.onUpdate?.(summary);
  await notifyRun(config, summary).catch(() => {});
  return summary;
}

/** Where a resume should restart after the run stopped at `step`. */
function resumePoint(step: Step, scope: Scope, engine: Engine): string {
  if (step.resume_from) return step.resume_from;
  if (!step.jump_only) return step.id;
  // A handler: go back to the step that jumped here.
  const mine = engine.summary.history.filter((h) => (h.parent ?? "") === scope.prefix.slice(0, -1));
  return mine.at(-2)?.id.slice(scope.prefix.length) ?? step.id;
}

async function loop(engine: Engine, scope: Scope, startAt: string | null, runsDir: string): Promise<LoopResult> {
  const { flow, ctx, visits } = scope;
  const { summary, config } = engine;
  const steps = flow.steps;
  const indexOf = new Map(steps.map((s, i) => [s.id, i]));
  const sequential = (i: number) => {
    while (i < steps.length && steps[i]!.jump_only) i++;
    return i;
  };
  const top = scope.depth === 0;
  const setNext = (id: string | null) => {
    if (top) summary.state.next = id;
  };

  let idx = startAt ? (indexOf.get(startAt) ?? -1) : sequential(0);
  if (idx < 0) return { outcome: "failed", reason: `unknown step "${startAt}"`, next: null, lastOutput: "" };
  let lastOutput = "";

  while (idx < steps.length) {
    const step = steps[idx]!;
    setNext(step.id);
    const here = () => ({ next: summary.state.next, lastOutput });
    if (engine.signal?.aborted) return { outcome: "cancelled", reason: "cancelled by user", ...here() };

    const runCap = summary.flowDef.limits.max_cost_usd;
    if (runCap !== undefined && summary.totalCostUsd >= runCap) {
      return { outcome: "failed", reason: `run budget of $${runCap} reached`, ...here() };
    }
    if (config.daily_budget_usd !== undefined && spentToday(runsDir) >= config.daily_budget_usd) {
      return { outcome: "stopped", reason: `daily budget of $${config.daily_budget_usd} reached — resume tomorrow`, ...here() };
    }

    const visit = (visits[step.id] = (visits[step.id] ?? 0) + 1);
    const maxVisits = step.max_visits ?? flow.defaults.max_visits ?? DEFAULT_MAX_VISITS;
    if (visit > maxVisits) return { outcome: "failed", reason: `step "${scope.prefix}${step.id}" exceeded max_visits (${maxVisits})`, ...here() };

    engine.log(`▶ ${scope.prefix}${step.id} (${step.type}${visit > 1 ? `, visit ${visit}` : ""})`);
    const startedAt = new Date();
    const logFile = newLogFile(engine, scope.prefix + step.id);
    let res: StepResult;

    if (step.type === "approval") {
      const d = engine.decision;
      if (top && d && d.stepId === step.id) {
        engine.decision = undefined;
        res = { ok: d.approved, output: `${d.approved ? "approved" : "rejected"} by ${d.by ?? "someone"}${d.note ? `: ${d.note}` : ""}` };
        if (!d.approved) res.error = "rejected";
      } else {
        visits[step.id] = visit - 1; // waiting is not a visit
        if (!top) return { outcome: "failed", reason: "approval steps are not supported in sub-flows", ...here() };
        const message = render(step.message, ctx);
        summary.waiting = { stepId: step.id, message, since: new Date().toISOString() };
        engine.log(`⏸ waiting for approval: ${message}`);
        return { outcome: "waiting", reason: message, next: step.id, lastOutput };
      }
    } else {
      try {
        res = await executeStep(step, scope, engine, logFile);
      } catch (e) {
        res = { ok: false, output: "", error: (e as Error).message };
      }
      res = applyChecks(step, res);
    }
    recordStep(step, scope, engine, res, startedAt, logFile, visit);
    lastOutput = res.output;
    if (engine.signal?.aborted) return { outcome: "cancelled", reason: `cancelled during step "${step.id}"`, ...here() };

    const routed = res.ok ? step.routes?.find((r) => new RegExp(r.if, "m").test(res.output))?.goto : undefined;
    const target = res.ok ? (routed ?? step.on_success ?? "next") : (step.on_failure ?? "fail");
    if (target === "end") return { outcome: "succeeded", next: null, lastOutput };
    if (target === "fail") {
      return { outcome: "failed", reason: `step "${scope.prefix}${step.id}" failed${res.error ? `: ${res.error}` : ""}`, ...here() };
    }
    if (target === "stop") {
      if (top) summary.state.next = resumePoint(step, scope, engine);
      return { outcome: "stopped", reason: `stopped at step "${scope.prefix}${step.id}" — needs attention`, ...here() };
    }
    idx = target === "next" ? sequential(idx + 1) : indexOf.get(target)!;
    setNext(steps[idx]?.id ?? null);
    engine.save();
  }
  return { outcome: "succeeded", next: null, lastOutput };
}
