import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Flow, Step } from "../flow/schema.js";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "stopped" | "waiting";

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
  /** Agent step target, e.g. "codex:openai:gpt-5". */
  agent?: string;
  tokens?: { input: number; output: number };
  /** The agent hit a usage/rate limit and no fallback model could take over. */
  limited?: boolean;
  startedAt: string;
  durationMs: number;
  logFile: string;
  /** Set for steps run by a sub-flow step, e.g. "build/test". */
  parent?: string;
}

/** Everything needed to continue a run later. */
export interface RunState {
  /** Step to run when the run is resumed (null: nothing left). */
  next: string | null;
  steps: Record<string, Record<string, unknown>>;
  visits: Record<string, number>;
}

export interface RunSummary {
  runId: string;
  flow: string;
  /** The flow definition the run started with, so resumes behave the same. */
  flowDef: Flow;
  task: string;
  vars: Record<string, string>;
  repo: string;
  status: RunStatus;
  reason?: string;
  runDir: string;
  workdir?: string;
  branch?: string;
  /** Commit the workspace started from (for diffs). */
  baseSha?: string;
  startedAt: string;
  finishedAt?: string;
  totalCostUsd: number;
  history: StepRecord[];
  state: RunState;
  /** Set while status is "waiting". */
  waiting?: { stepId: string; message: string; since: string };
  /** How many times the run was resumed. */
  resumes?: number;
  /** Process that last started or resumed the run. */
  pid?: number;
  /** Who started the run, e.g. "ui", "cli" or "watcher <id> issue #7". Absent on runs of older versions. */
  source?: string;
}

/** The few fields of a run that are cheap to keep for every run. */
export interface RunBrief {
  runId: string;
  flow: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  source?: string;
  runDir: string;
  /** When run.json was last written. */
  updatedAt: string;
}

/** When run.json was last written (undefined when it cannot be read). */
export function runUpdatedAt(runDir: string): string | undefined {
  try {
    return new Date(Math.round(statSync(runFile(runDir)).mtimeMs)).toISOString();
  } catch {
    return undefined;
  }
}

const briefCache = new Map<string, { mtimeMs: number; size: number; brief: RunBrief }>();

/** A brief of every run, newest first. A run.json is read again only when its time or size changed; broken files are skipped. */
export function listRunBriefs(runsDir: string): RunBrief[] {
  const out: RunBrief[] = [];
  for (const id of listRunIds(runsDir)) {
    const file = runFile(join(runsDir, id));
    try {
      const st = statSync(file);
      let hit = briefCache.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        const s = JSON.parse(readFileSync(file, "utf8")) as RunSummary;
        if (!s || typeof s.runId !== "string" || typeof s.status !== "string") continue;
        hit = { mtimeMs: st.mtimeMs, size: st.size, brief: { runId: s.runId, flow: s.flow, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, source: s.source, runDir: s.runDir, updatedAt: new Date(Math.round(st.mtimeMs)).toISOString() } };
        briefCache.set(file, hit);
      }
      out.push(hit.brief);
    } catch {
      continue;
    }
  }
  return out;
}

export const runFile = (runDir: string) => join(runDir, "run.json");
export const liveLogFile = (runDir: string) => join(runDir, "live.log");

export function saveRun(s: RunSummary) {
  writeFileSync(runFile(s.runDir), JSON.stringify(s, null, 2));
}

export function loadRun(runsDir: string, runId: string): RunSummary | undefined {
  if (!/^[\w-]+$/.test(runId)) return undefined;
  const p = runFile(join(runsDir, runId));
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as RunSummary;
}

export function listRunIds(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((d) => existsSync(runFile(join(runsDir, d)))).sort().reverse();
}

export function appendLiveLog(runDir: string, line: string) {
  try {
    appendFileSync(liveLogFile(runDir), line + "\n");
  } catch {
    // run dir removed (e.g. by clean) — logging must never break a run
  }
}

export function readLiveLog(runDir: string): string[] {
  const p = liveLogFile(runDir);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

/** Total spend of runs that started today (local time). Run ids start with a UTC timestamp, so read startedAt. */
export function spentToday(runsDir: string, now = new Date()): number {
  const day = now.toDateString();
  let total = 0;
  for (const id of listRunIds(runsDir).slice(0, 500)) {
    const s = loadRun(runsDir, id);
    if (!s) continue;
    if (new Date(s.startedAt).toDateString() === day) total += s.totalCostUsd;
    else if (new Date(s.startedAt) < new Date(now.getTime() - 2 * 86_400_000)) break; // sorted newest first
  }
  return total;
}
