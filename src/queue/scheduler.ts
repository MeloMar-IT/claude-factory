import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import type { ApprovalDecision } from "../engine/execute.js";
import { newRunId, resumeRun, runFlow } from "../engine/runner.js";
import { listRunIds, loadRun, readLiveLog, type RunSummary } from "../engine/state.js";
import type { Flow } from "../flow/schema.js";

const MAX_LOG_LINES = 5000;

export type Job =
  | { kind: "run"; flow: Flow; task: string; repo: string; vars: Record<string, string> }
  | { kind: "resume"; runId: string; from?: string; decision?: ApprovalDecision };

export interface QueuedJob {
  runId: string;
  job: Job;
  /** Jobs with the same lock key never run at the same time (e.g. one ticket). */
  lockKey?: string;
  /** Who queued it, e.g. "watcher acme/app#7" or "ui". */
  source?: string;
  enqueuedAt: string;
}

export type RunEvent = { type: "log"; line: string } | { type: "update"; summary: RunSummary };

interface Active {
  queued: QueuedJob;
  controller: AbortController;
  lines: string[];
  summary?: RunSummary;
  listeners: Set<(e: RunEvent) => void>;
  done: Promise<RunSummary | undefined>;
}

export interface SchedulerOptions {
  runsDir: string;
  config: () => Config;
  claudeBin?: string;
  /** Where pending jobs are saved so they survive restarts. */
  queueFile?: string;
  onFinished?: (summary: RunSummary, job: QueuedJob) => void;
}

/**
 * Runs jobs with a global concurrency limit and per-key locks. Pending jobs are
 * persisted; run progress is fanned out to subscribers (UI live logs).
 */
export class Scheduler {
  private pending: QueuedJob[] = [];
  private active = new Map<string, Active>();
  private recent = new Map<string, Active>(); // finished, kept briefly for late subscribers
  private pendingListeners = new Map<string, Set<(e: RunEvent) => void>>();

  constructor(private o: SchedulerOptions) {
    if (o.queueFile && existsSync(o.queueFile)) {
      try {
        this.pending = JSON.parse(readFileSync(o.queueFile, "utf8")) as QueuedJob[];
      } catch {
        this.pending = [];
      }
    }
    queueMicrotask(() => this.pump());
  }

  submit(job: Job, meta: { lockKey?: string; source?: string } = {}): string {
    const runId = job.kind === "run" ? newRunId() : job.runId;
    if (job.kind === "resume" && (this.isActive(runId) || this.isQueued(runId))) throw new Error(`run ${runId} is already queued or running`);
    this.pending.push({ runId, job, ...meta, enqueuedAt: new Date().toISOString() });
    this.persist();
    this.pump();
    return runId;
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  isQueued(runId: string) {
    return this.pending.some((p) => p.runId === runId);
  }

  isLocked(lockKey: string) {
    return [...this.active.values()].some((a) => a.queued.lockKey === lockKey) || this.pending.some((p) => p.lockKey === lockKey);
  }

  cancel(runId: string): boolean {
    const i = this.pending.findIndex((p) => p.runId === runId);
    if (i >= 0) {
      this.pending.splice(i, 1);
      this.persist();
      return true;
    }
    const a = this.active.get(runId);
    if (!a) return false;
    a.controller.abort();
    return true;
  }

  queue() {
    return {
      pending: this.pending.map(({ runId, lockKey, source, enqueuedAt, job }) => ({ runId, lockKey, source, enqueuedAt, kind: job.kind })),
      active: [...this.active.values()].map((a) => ({ runId: a.queued.runId, lockKey: a.queued.lockKey, source: a.queued.source })),
      concurrency: this.o.config().concurrency,
    };
  }

  /** Wait for a run to finish (resolves immediately if it is not queued or running). */
  async wait(runId: string): Promise<RunSummary | undefined> {
    while (this.isQueued(runId)) await new Promise((r) => setTimeout(r, 200));
    return this.active.get(runId)?.done ?? loadRun(this.o.runsDir, runId);
  }

  async idle(): Promise<void> {
    while (this.pending.length || this.active.size) await new Promise((r) => setTimeout(r, 200));
  }

  get(runId: string): RunSummary | undefined {
    return this.active.get(runId)?.summary ?? this.markStale(loadRun(this.o.runsDir, runId));
  }

  list(limit = 100): RunSummary[] {
    return listRunIds(this.o.runsDir)
      .slice(0, limit)
      .map((id) => this.get(id))
      .filter((s): s is RunSummary => !!s);
  }

  /** A "running" run.json with no live process was interrupted (e.g. the server died). */
  private markStale(s: RunSummary | undefined): RunSummary | undefined {
    if (s && s.status === "running" && !this.active.has(s.runId)) return { ...s, status: "failed", reason: "interrupted — resume it to continue" };
    return s;
  }

  /** Replays the log so far, then streams. Returns an unsubscribe function. */
  subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
    const live = this.active.get(runId) ?? this.recent.get(runId);
    if (live) live.lines.forEach((line) => fn({ type: "log", line }));
    else {
      const s = loadRun(this.o.runsDir, runId);
      if (s) readLiveLog(s.runDir).forEach((line) => fn({ type: "log", line }));
    }
    const summary = this.get(runId);
    if (summary) fn({ type: "update", summary });
    if (live && this.active.has(runId)) {
      live.listeners.add(fn);
      return () => live.listeners.delete(fn);
    }
    if (this.isQueued(runId)) {
      const set = this.pendingListeners.get(runId) ?? new Set();
      set.add(fn);
      this.pendingListeners.set(runId, set);
      return () => set.delete(fn);
    }
    return () => {};
  }

  private persist() {
    if (!this.o.queueFile) return;
    mkdirSync(dirname(this.o.queueFile), { recursive: true });
    writeFileSync(this.o.queueFile, JSON.stringify(this.pending, null, 2));
  }

  private pump() {
    const limit = this.o.config().concurrency;
    for (let i = 0; i < this.pending.length && this.active.size < limit; ) {
      const q = this.pending[i]!;
      const locked = q.lockKey && [...this.active.values()].some((a) => a.queued.lockKey === q.lockKey);
      if (locked) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      this.start(q);
    }
    this.persist();
  }

  private start(q: QueuedJob) {
    const a: Active = {
      queued: q,
      controller: new AbortController(),
      lines: [],
      listeners: this.pendingListeners.get(q.runId) ?? new Set(),
      done: Promise.resolve(undefined),
    };
    this.pendingListeners.delete(q.runId);
    this.active.set(q.runId, a);
    const emit = (e: RunEvent) => a.listeners.forEach((l) => l(e));
    const common = {
      runsDir: this.o.runsDir,
      claudeBin: this.o.claudeBin,
      signal: a.controller.signal,
      config: this.o.config(),
      log: (line: string) => {
        a.lines.push(line);
        if (a.lines.length > MAX_LOG_LINES) a.lines.shift();
        emit({ type: "log", line });
      },
      onUpdate: (summary: RunSummary) => {
        a.summary = structuredClone(summary);
        emit({ type: "update", summary: a.summary });
      },
    };
    const j = q.job;
    const promise =
      j.kind === "run"
        ? runFlow(j.flow, { ...common, runId: q.runId, task: j.task, repo: j.repo, vars: j.vars })
        : resumeRun({ ...common, runId: j.runId, from: j.from, decision: j.decision });
    a.done = promise
      .then((summary) => {
        this.o.onFinished?.(summary, q);
        return summary;
      })
      .catch((e: Error) => {
        common.log(`✘ could not start: ${e.message}`);
        return loadRun(this.o.runsDir, q.runId);
      })
      .finally(() => {
        this.active.delete(q.runId);
        this.recent.set(q.runId, a);
        setTimeout(() => this.recent.delete(q.runId), 10 * 60_000).unref();
        this.pump();
      });
  }
}
