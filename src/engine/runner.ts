import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Flow, Step } from "../flow/schema.js";
import { runClaude } from "../steps/claude.js";
import { runShell } from "../steps/shell.js";
import { outputEnvName, render, type TemplateContext } from "./template.js";
import { prepareWorkspace } from "./workspace.js";

const DEFAULT_MAX_VISITS = 5;
const DEFAULT_PERMISSION_MODE = "acceptEdits";
/** Shell commands may only template trusted values; task and outputs go via env. */
const SHELL_TEMPLATE_ROOTS = ["vars", "workdir", "run"] as const;

export interface StepRecord {
  id: string;
  type: Step["type"];
  visit: number;
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number | null;
  sessionId?: string;
  costUsd?: number;
  startedAt: string;
  durationMs: number;
  logFile: string;
}

export interface RunSummary {
  runId: string;
  flow: string;
  task: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  reason?: string;
  runDir: string;
  workdir?: string;
  branch?: string;
  startedAt: string;
  finishedAt?: string;
  totalCostUsd: number;
  history: StepRecord[];
}

export interface RunOptions {
  task: string;
  repo: string;
  runsDir: string;
  vars?: Record<string, string>;
  claudeBin?: string;
  /** Pre-allocated run id (e.g. so a UI can subscribe before the run starts). */
  runId?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Called whenever run.json is written. */
  onUpdate?: (summary: RunSummary) => void;
}

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${ts}-${randomBytes(2).toString("hex")}`;
}

function checkOutput(step: Step, ok: boolean, output: string): { ok: boolean; error?: string } {
  if (!ok) return { ok };
  if (step.fail_if && new RegExp(step.fail_if, "m").test(output)) {
    return { ok: false, error: `output matched fail_if /${step.fail_if}/` };
  }
  if (step.pass_if && !new RegExp(step.pass_if, "m").test(output)) {
    return { ok: false, error: `output did not match pass_if /${step.pass_if}/` };
  }
  return { ok };
}

export async function runFlow(flow: Flow, opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  const runId = opts.runId ?? newRunId();
  const runDir = join(opts.runsDir, runId);
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  const summary: RunSummary = {
    runId,
    flow: flow.name,
    task: opts.task,
    status: "running",
    runDir,
    startedAt: new Date().toISOString(),
    totalCostUsd: 0,
    history: [],
  };
  const save = () => {
    writeFileSync(join(runDir, "run.json"), JSON.stringify(summary, null, 2));
    opts.onUpdate?.(summary);
  };
  const finish = (status: "succeeded" | "failed" | "cancelled", reason?: string) => {
    summary.status = status;
    summary.reason = reason;
    summary.finishedAt = new Date().toISOString();
    save();
    return summary;
  };
  save();

  try {
    const ws = prepareWorkspace(flow.workspace, opts.repo, runDir, runId);
    summary.workdir = ws.workdir;
    summary.branch = ws.branch;
    save();
  } catch (e) {
    return finish("failed", (e as Error).message);
  }
  const workdir = summary.workdir!;
  log(`run ${runId} · flow ${flow.name} · ${workdir}${summary.branch ? ` (branch ${summary.branch})` : ""}`);

  const ctx: TemplateContext & { steps: Record<string, Record<string, unknown>> } = {
    task: opts.task,
    vars: { ...flow.vars, ...opts.vars },
    workdir,
    run: { id: runId, dir: runDir, branch: summary.branch ?? "" },
    steps: {},
  };
  const outputEnv: Record<string, string> = {};
  const visits = new Map<string, number>();
  const indexOf = new Map(flow.steps.map((s, i) => [s.id, i]));
  const d = flow.defaults;

  let idx = 0;
  while (idx < flow.steps.length) {
    if (opts.signal?.aborted) return finish("cancelled", "cancelled by user");
    const step = flow.steps[idx]!;
    const visit = (visits.get(step.id) ?? 0) + 1;
    visits.set(step.id, visit);
    const maxVisits = step.max_visits ?? d.max_visits ?? DEFAULT_MAX_VISITS;
    if (visit > maxVisits) return finish("failed", `step "${step.id}" exceeded max_visits (${maxVisits})`);

    const logFile = join(logsDir, `${String(summary.history.length + 1).padStart(3, "0")}-${step.id}.log`);
    const timeoutSec = step.timeout_sec ?? d.timeout_sec;
    const timeoutMs = timeoutSec ? timeoutSec * 1000 : undefined;
    const startedAt = new Date();
    log(`▶ ${step.id} (${step.type}${visit > 1 ? `, visit ${visit}` : ""})`);

    let rec: Omit<StepRecord, "id" | "type" | "visit" | "startedAt" | "durationMs" | "logFile">;
    try {
      if (step.type === "claude") {
        const resumeFrom = step.resume ? ctx.steps[step.resume]?.session_id : undefined;
        const r = await runClaude({
          prompt: render(step.prompt, ctx),
          systemPrompt: step.system_prompt ? render(step.system_prompt, ctx) : undefined,
          cwd: workdir,
          logFile,
          claudeBin: opts.claudeBin,
          model: step.model ?? d.model,
          permissionMode: step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE,
          allowedTools: step.allowed_tools ?? d.allowed_tools,
          resumeSessionId: typeof resumeFrom === "string" ? resumeFrom : undefined,
          maxBudgetUsd: step.max_budget_usd ?? d.max_budget_usd,
          timeoutMs,
          signal: opts.signal,
          onProgress: (m) => log(`    · ${m}`),
        });
        rec = { ok: r.ok, output: r.output, error: r.error, sessionId: r.sessionId, costUsd: r.costUsd };
      } else {
        const r = await runShell({
          command: render(step.run, ctx, SHELL_TEMPLATE_ROOTS),
          cwd: workdir,
          env: { FACTORY_TASK: opts.task, FACTORY_RUN_ID: runId, FACTORY_WORKDIR: workdir, ...outputEnv },
          logFile,
          timeoutMs,
          signal: opts.signal,
        });
        rec = { ok: r.ok, output: r.output, error: r.error, exitCode: r.exitCode };
      }
    } catch (e) {
      rec = { ok: false, output: "", error: (e as Error).message };
    }

    const checked = checkOutput(step, rec.ok, rec.output);
    rec.ok = checked.ok;
    rec.error = rec.error ?? checked.error;

    const record: StepRecord = {
      id: step.id,
      type: step.type,
      visit,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      logFile,
      ...rec,
    };
    summary.history.push(record);
    summary.totalCostUsd += rec.costUsd ?? 0;
    ctx.steps[step.id] = {
      ok: rec.ok,
      output: rec.output,
      error: rec.error ?? "",
      exit_code: rec.exitCode ?? "",
      session_id: rec.sessionId ?? "",
      visit,
    };
    outputEnv[outputEnvName(step.id)] = rec.output;
    save();

    const secs = (record.durationMs / 1000).toFixed(1);
    log(`${rec.ok ? "✔" : "✘"} ${step.id} (${secs}s${rec.costUsd ? `, $${rec.costUsd.toFixed(4)}` : ""})${rec.error ? ` — ${rec.error}` : ""}`);

    if (opts.signal?.aborted) return finish("cancelled", `cancelled during step "${step.id}"`);
    const target = rec.ok ? (step.on_success ?? "next") : (step.on_failure ?? "fail");
    if (target === "end") return finish("succeeded");
    if (target === "fail") return finish("failed", `step "${step.id}" failed${rec.error ? `: ${rec.error}` : ""}`);
    idx = target === "next" ? idx + 1 : indexOf.get(target)!;
  }
  return finish("succeeded");
}
