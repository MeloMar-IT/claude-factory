import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  /** The AI service could not be reached at all (the limit flag is set so the run pauses). */
  unreachable?: boolean;
  /** Extra tries inside this step: after a brief outage, and on another model after a limit. */
  retried?: { blips: number; models: number };
  /** Tool calls Claude Code refused (at most 5), e.g. "Bash: mkdir out". */
  denied?: string[];
  startedAt: string;
  durationMs: number;
  logFile: string;
  /** Set for steps run by a sub-flow step, e.g. "build/test". */
  parent?: string;
}

/** Why a failed run failed, in one sentence written by a model (see failure-explain.ts). */
export interface FailureNote {
  kind: "code" | "environment";
  why: string;
  /** The agent that wrote it, e.g. "claude:anthropic:haiku". */
  by: string;
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
  /** A model's one-sentence reason for a failed run; gone when the run is resumed. */
  failureNote?: FailureNote;
  /** How many times the run was resumed. */
  resumes?: number;
  /** The last 50 resumes (when, and the step each restarted at); the monitor reads it to find restart loops. */
  resumeLog?: { at: string; from: string }[];
  /** Process that last started or resumed the run. */
  pid?: number;
  /** When the top-level step in `state.next` started; only while that step runs. */
  stepStartedAt?: string;
  /** Who started the run, e.g. "ui", "cli" or "watcher <id> issue #7". Absent on runs of older versions. */
  source?: string;
  /** The id of the account that started the run. Absent for runs of watchers, the CLI and older versions. */
  owner?: string;
}

/** The few fields of a run that are cheap to keep for every run. */
export interface RunBrief {
  runId: string;
  flow: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  source?: string;
  owner?: string;
  runDir: string;
  /** The name of the folder the run.json was found in (the stored runId is not a path). */
  dirName: string;
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
  return listRunIds(runsDir).flatMap((id) => briefOf(runsDir, id) ?? []);
}

/** Like listRunBriefs, but gives the event loop a turn after every 50 runs (a cold start reads every file). */
export async function listRunBriefsAsync(runsDir: string): Promise<RunBrief[]> {
  const out: RunBrief[] = [];
  for (const [i, id] of listRunIds(runsDir).entries()) {
    if (i > 0 && i % 50 === 0) await new Promise<void>((r) => setImmediate(r));
    const b = briefOf(runsDir, id);
    if (b) out.push(b);
  }
  return out;
}

function briefOf(runsDir: string, id: string): RunBrief | undefined {
  const file = runFile(join(runsDir, id));
  try {
    const st = statSync(file);
    let hit = briefCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const s = JSON.parse(readFileSync(file, "utf8")) as RunSummary;
      if (!s || typeof s.runId !== "string" || typeof s.status !== "string") return undefined;
      hit = { mtimeMs: st.mtimeMs, size: st.size, brief: { runId: s.runId, flow: s.flow, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, source: s.source, owner: s.owner, runDir: s.runDir, dirName: id, updatedAt: new Date(Math.round(st.mtimeMs)).toISOString() } };
      briefCache.set(file, hit);
    }
    return hit.brief;
  } catch {
    return undefined;
  }
}

export const runFile = (runDir: string) => join(runDir, "run.json");
export const liveLogFile = (runDir: string) => join(runDir, "live.log");

export function saveRun(s: RunSummary) {
  writeFileSync(runFile(s.runDir), JSON.stringify(s, null, 2));
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Adds `owner` to a run.json that has none, and changes nothing else (not the other fields, the file time or the mode).
 * Skips a run that is live (status "running" and its process is alive). The file is written beside it and renamed over
 * it; if run.json changed in between, nothing is replaced. Returns true when the owner was added. Never throws.
 */
export function adoptRun(runDir: string, owner: string, hooks: { beforeSwap?: () => void } = {}): boolean {
  const file = runFile(runDir);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    const s = JSON.parse(text) as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.owner === "string") return false;
    if (s.status === "running" && pidAlive(s.pid)) return false;
    writeFileSync(tmp, JSON.stringify({ ...s, owner }, null, 2), { mode: st.mode & 0o777, flag: "wx" });
    chmodSync(tmp, st.mode & 0o777);
    utimesSync(tmp, st.atime, new Date(Math.round(st.mtimeMs)));
    hooks.beforeSwap?.();
    // A second look: another process may have written run.json while we worked.
    if (readFileSync(file, "utf8") !== text) return false;
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
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
