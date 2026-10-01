import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config } from "../config.js";
import type { ApprovalDecision } from "../engine/execute.js";
import { cancelWaitingRun, newRunId, resumeRun, runFlow } from "../engine/runner.js";
import { listRunBriefs, listRunIds, loadRun, readLiveLog, runUpdatedAt, type RunBrief, type RunSummary } from "../engine/state.js";
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
  /** Set for one_per_repo flows: only one active job per repo key. */
  repoLock?: string;
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
  /** Viewers of runs that are not running right now; attached when the run starts. */
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
    const repoLock = this.repoLockFor(job);
    this.pending.push({ runId, job, ...meta, ...(repoLock ? { repoLock } : {}), enqueuedAt: new Date().toISOString() });
    this.persist();
    this.pump();
    return runId;
  }

  /** "code:<owner/repo or local path>" for flows with one_per_repo, else undefined. */
  private repoLockFor(job: Job): string | undefined {
    let flow: Flow | undefined, vars: Record<string, string>, repo: string;
    if (job.kind === "run") ({ flow, vars, repo } = job);
    else {
      const s = loadRun(this.o.runsDir, job.runId);
      if (!s) return undefined;
      ({ flowDef: flow, vars, repo } = s);
    }
    if (!flow?.one_per_repo) return undefined;
    const gh = vars?.github_repo;
    return `code:${gh && gh !== "owner/repo" ? gh : resolve(repo)}`;
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
      const [job] = this.pending.splice(i, 1);
      this.persist();
      if (job?.job.kind === "resume") this.cancelWaiting(runId); // a queued approval: the run no longer waits
      return true;
    }
    const a = this.active.get(runId);
    if (!a) return this.cancelWaiting(runId);
    a.controller.abort();
    return true;
  }

  /** Cancel a run that waits for approval (no process runs for it). */
  private cancelWaiting(runId: string): boolean {
    const summary = cancelWaitingRun(this.o.runsDir, runId, this.o.config());
    if (!summary) return false;
    // Viewers that watched the run while it was active are kept in `recent`; later ones are pending listeners.
    for (const fn of [...(this.recent.get(runId)?.listeners ?? []), ...(this.pendingListeners.get(runId) ?? [])]) fn({ type: "update", summary });
    return true;
  }

  queue() {
    return {
      pending: this.pending.map(({ runId, lockKey, repoLock, source, enqueuedAt, job }, i) => {
        const same = (q: QueuedJob) => (repoLock && q.repoLock === repoLock) || (lockKey && q.lockKey === lockKey);
        // The lock owner: an active job, else an earlier job in the queue that holds the same lock.
        const blocker = [...this.active.values()].find((a) => same(a.queued))?.queued ?? this.pending.slice(0, i).find(same);
        const vars = job.kind === "run" ? job.vars : undefined;
        return {
          runId, lockKey, repoLock, source, enqueuedAt, kind: job.kind, waitingFor: blocker?.runId,
          githubRepo: vars?.github_repo, issue: vars?.issue,
          repo: job.kind === "run" ? job.repo : undefined, task: job.kind === "run" ? job.task : undefined,
        };
      }),
      active: [...this.active.values()].map((a) => ({ runId: a.queued.runId, lockKey: a.queued.lockKey, repoLock: a.queued.repoLock, source: a.queued.source })),
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

  /** A brief of every run, newest first (cheap: files are read again only when they changed). */
  briefs(): RunBrief[] {
    return listRunBriefs(this.o.runsDir).map((b) => {
      const live = this.active.get(b.runId)?.summary;
      if (live) return { ...b, status: live.status };
      // An interrupted run ended when its run.json was last written: a time that stays the same.
      return b.status === "running" && !this.active.has(b.runId) ? { ...b, status: "failed" as const, finishedAt: b.finishedAt ?? b.updatedAt } : b;
    });
  }

  /** A "running" run.json with no live process was interrupted (e.g. the server died). */
  private markStale(s: RunSummary | undefined): RunSummary | undefined {
    if (s && s.status === "running" && !this.active.has(s.runId)) return { ...s, status: "failed", reason: "interrupted — resume it to continue", finishedAt: s.finishedAt ?? runUpdatedAt(s.runDir) ?? s.startedAt };
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
    // Not running now: stay subscribed, so a later resume (UI, CLI or watcher) streams to this viewer.
    const set = this.pendingListeners.get(runId) ?? new Set();
    set.add(fn);
    this.pendingListeners.set(runId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.pendingListeners.delete(runId);
    };
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
      const active = [...this.active.values()].map((a) => a.queued);
      const locked = (q.lockKey && active.some((a) => a.lockKey === q.lockKey)) || (q.repoLock && active.some((a) => a.repoLock === q.repoLock));
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
        ? runFlow(j.flow, { ...common, runId: q.runId, task: j.task, repo: j.repo, vars: j.vars, source: q.source })
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
