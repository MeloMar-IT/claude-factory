import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { MonitorConfig, WatcherConfig } from "../config.js";
import { pidAlive, runFile, type RunBrief, type RunSummary } from "../engine/state.js";
import { errorLine, GITHUB_LIMIT_RE } from "../errors.js";
import { buildHistory, type DurationHistory } from "../estimate.js";
import { FACTORY_HOME } from "../flow/load.js";
import type { RateReading } from "../github.js";
import { parseInterval, type TrackedIssue, type WatcherStatus } from "../queue/watcher.js";
import type { Scheduler } from "../queue/scheduler.js";
import { runDetectors, type ActiveRun, type AreaLock, type Detector, type DetectorInput, type LogLine } from "./detectors.js";
import { loadUpdateState, type UpdateState } from "../self-update-state.js";
import { decideBreaker, failedFixes, forgetSkip, isStoryRun, keepEarlier, storyKeys, withoutStoryRuns, type FixFailure } from "./breaker.js";
import { findingsFile, loadFindings, mergeFindings, saveFindings } from "./findings.js";
import { describeEntry, inQuietTime, loadGuard, openBreaker, storiesState, writeLog, type Loaded } from "./guard.js";
import type { Reporter } from "./report.js";
import { ALL_DETECTORS } from "./work-detectors.js";

export interface MonitorDeps {
  scheduler: Pick<Scheduler, "briefs" | "get" | "queue"> & Partial<Pick<Scheduler, "briefsAsync" | "lastStart">>;
  /** The other watchers with their status. */
  watchers: () => { cfg: WatcherConfig; status: WatcherStatus; issues?: TrackedIssue[] }[];
  /** Set while the server waits to restart. */
  restart?: () => DetectorInput["restart"];
  thresholds: () => MonitorConfig;
  serverLog?: () => LogLine[];
  rateLimit?: () => RateReading | undefined;
  /** Runs before the detectors of every check (the manager reads the request limit here). */
  beforeCheck?: () => Promise<void>;
  log: (msg: string) => void;
  /** Writes bug stories for findings that last (only when `report_to` is set). */
  reporter?: Pick<Reporter, "report">;
  /** For tests. */
  file?: string;
  detectors?: Detector[];
  now?: () => Date;
  selfUpdate?: () => { state: UpdateState; broken: boolean };
  /** The guard rails: without it there is no circuit breaker and no counting of failed fixes. `beforeOpen` is for tests. */
  guard?: { startedAt?: Date; onLogError?: (msg: string) => void; beforeOpen?: () => void };
}

/** At most this many runs are loaded in one check. */
export const MAX_RUNS = 1000;
const YIELD_EVERY = 25;
const HOUR = 3_600_000;
/** How many succeeded runs make the usual step times (as many as the estimates read). */
export const USUAL_RUNS = 500;
const MAX_LOCKS = 500;

/** The newest time anything was written to the logs of a run (live.log and the step logs). Undefined when there is none. */
export function lastLogWrite(runDir: string): string | undefined {
  let newest = 0;
  const look = (file: string) => {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs);
    } catch {
      // a missing log is no write
    }
  };
  look(join(runDir, "live.log"));
  try {
    for (const f of readdirSync(join(runDir, "logs"))) look(join(runDir, "logs", f));
  } catch {
    // no logs folder yet
  }
  return newest ? new Date(Math.round(newest)).toISOString() : undefined;
}

/** Where the lock tool keeps its locks (a folder per repository). */
export const areaLockDir = (): string => process.env.SCF_LOCK_DIR || process.env.FACTORY_LOCK_DIR || join(process.env.FACTORY_HOME ?? FACTORY_HOME, "locks");

export interface LockFile { key: string; repo: string; runId: string; runDir: string; areas: string[]; at: string }

/** The lock files of the lock tool. Skips unreadable files and entries without a string runId, an absolute runDir, areas or at. At most 500. Never throws. */
export function readAreaLocks(dir: string = areaLockDir()): LockFile[] {
  const out: LockFile[] = [];
  try {
    for (const repo of readdirSync(dir)) {
      let files: string[];
      try {
        files = readdirSync(join(dir, repo)).filter((f) => f.endsWith(".json"));
      } catch {
        continue; // a file, not a repository folder
      }
      for (const f of files) {
        if (out.length >= MAX_LOCKS) return out;
        try {
          const l = JSON.parse(readFileSync(join(dir, repo, f), "utf8")) as Record<string, unknown>;
          if (typeof l.runId !== "string" || typeof l.runDir !== "string" || !isAbsolute(l.runDir) || typeof l.at !== "string") continue;
          if (!Array.isArray(l.areas) || !l.areas.every((a) => typeof a === "string")) continue;
          out.push({ key: `${repo}/${f}`, repo, runId: l.runId, runDir: l.runDir, areas: l.areas as string[], at: l.at });
        } catch {
          // half-written or broken: left out
        }
      }
    }
  } catch {
    // no lock folder: no locks
  }
  return out;
}

/** The newest log lines. Lines that match `keep` have their own short list, so a busy log cannot push them out. */
export function logRing(max = 2000, keep: RegExp = GITHUB_LIMIT_RE, maxKept = 100): { push(text: string): void; lines(): LogLine[] } {
  type Entry = LogLine & { seq: number };
  const recent: Entry[] = [];
  const kept: Entry[] = [];
  let seq = 0;
  const trim = (list: Entry[], n: number) => list.length > n * 2 && list.splice(0, list.length - n);
  return {
    push(text) {
      const e = { seq: seq++, at: new Date().toISOString(), text };
      recent.push(e);
      trim(recent, max);
      if (keep.test(text)) {
        kept.push(e);
        trim(kept, maxKept);
      }
    },
    lines() {
      const all = new Map<number, Entry>();
      for (const e of recent.slice(-max)) all.set(e.seq, e);
      for (const e of kept.slice(-maxKept)) all.set(e.seq, e);
      return [...all.values()].sort((a, b) => a.seq - b.seq).map(({ at, text }) => ({ at, text }));
    },
  };
}

/**
 * Checks the Foundry itself on a schedule and records what is wrong in its findings file. With `report_to` set, a
 * finding that lasts becomes one bug story in that repository (see report.ts); without it, nothing leaves the machine.
 */
export class Monitor {
  status: WatcherStatus;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private inFlight?: Promise<void>;
  private prevEnd?: number;
  private manual = false;
  /** Area lock key → when the monitor first saw it without a running owner. */
  private orphans = new Map<string, string>();
  /** When the server last woke up from a sleep (as far as the monitor saw). */
  private wokeAt?: string;
  private usualCache?: { at: number; hours: number; history: DurationHistory };
  /** The notes of the last check: one is logged when it first appears. */
  private noted = new Set<string>();

  constructor(public cfg: WatcherConfig, private d: MonitorDeps) {
    this.status = { id: cfg.id, lastActions: [] };
  }

  private now() {
    return this.d.now?.() ?? new Date();
  }

  start() {
    this.stopped = false;
    this.status.startedAt = new Date().toISOString();
    const loop = async () => {
      await this.tick();
      if (this.stopped) return;
      let every: number;
      try {
        every = parseInterval(this.cfg.every);
      } catch {
        return; // tick() reported the invalid interval as the monitor's error
      }
      this.status.nextTick = new Date(Date.now() + every).toISOString();
      this.timer = setTimeout(loop, every);
      this.timer.unref?.();
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.status.nextTick = undefined;
  }

  /** Writes a line to the server log and to the card's recent activity. */
  act(msg: string) {
    this.d.log(`[${this.cfg.id}] ${msg}`);
    this.status.lastActions = [`${new Date().toLocaleTimeString()} ${msg}`, ...this.status.lastActions].slice(0, 20);
  }

  /** One check. Never throws; a check in flight is shared. A manual check never counts as "after a sleep". */
  tick(manual = false): Promise<void> {
    if (manual) this.manual = true;
    return (this.inFlight ??= this.check().finally(() => (this.inFlight = undefined)));
  }

  private async check(): Promise<void> {
    try {
      await this.run();
      this.status.lastError = undefined;
      this.status.errorSince = undefined;
      this.status.errorCount = undefined;
      this.status.lastOk = new Date().toISOString();
    } catch (e) {
      this.status.lastError = errorLine((e as Error).message);
      this.status.errorSince ??= new Date().toISOString();
      this.status.errorCount = (this.status.errorCount ?? 0) + 1;
      this.d.log(`[${this.cfg.id}] ! ${this.status.lastError}`);
    } finally {
      this.status.lastTick = new Date().toISOString();
      this.prevEnd = this.now().getTime();
      this.manual = false;
    }
  }

  private async run() {
    const start = this.now();
    const every = parseInterval(this.cfg.every);
    const asleep = !this.manual && this.prevEnd !== undefined && start.getTime() - this.prevEnd > every + 60_000;
    // Kept for the later checks too: the detectors that skip the check after a sleep must not judge old times right after it.
    if (asleep) this.wokeAt = start.toISOString();
    const config = this.d.thresholds();
    await this.d.beforeCheck?.().catch(() => {}); // e.g. read GitHub's request limit, so the detectors see it
    const briefs = this.d.scheduler.briefsAsync ? await this.d.scheduler.briefsAsync() : this.d.scheduler.briefs();
    const file = this.d.file ?? findingsFile();
    const stored = loadFindings(file);
    if (stored.broken) this.act("the findings file could not be read; it was kept as monitor-findings.json.broken");
    // Runs that build a bug story of the monitor are never looked at: a story about its own repair would run in circles.
    const stories = storyKeys(stored.findings);
    const storyRuns = briefs.filter((b) => isStoryRun(b, stories));
    const allRuns = await this.collect(briefs, start, config);
    const queue = this.d.scheduler.queue();
    const allActive: ActiveRun[] = queue.active.flatMap((a) => {
      try {
        const run = this.d.scheduler.get(a.runId);
        return run ? [{ run, lastWrite: lastLogWrite(run.runDir) }] : [];
      } catch {
        return []; // a run.json that cannot be read is left out
      }
    });
    const history = await this.usual(briefs, start, config);
    const activeIds = queue.active.map((a) => a.runId);
    const seen = withoutStoryRuns(
      { runs: allRuns, active: allActive, watchers: this.d.watchers(), locks: readAreaLocks() },
      stories,
      storyRuns.flatMap((b) => [b.runId, b.dirName]),
    );
    const found = runDetectors(this.d.detectors ?? ALL_DETECTORS, {
      now: start, asleep, config, runs: seen.runs, watchers: seen.watchers, log: this.d.serverLog?.() ?? [], rate: this.d.rateLimit?.(),
      // A queued story job is not looked at either; the active jobs stay, they fill the slots.
      queue: { ...queue, pending: queue.pending.filter((p) => !isStoryRun({ githubRepo: p.githubRepo, issue: p.issue }, stories)) }, monitorId: this.cfg.id,
      ...(this.wokeAt ? { wokeAt: this.wokeAt } : {}),
      active: seen.active, areaLocks: this.areaLocks(start, activeIds, seen.locks), lastStart: this.d.scheduler.lastStart?.(), restart: this.d.restart?.(), history,
      update: (this.d.selfUpdate ?? loadUpdateState)(),
    });
    const merged = mergeFindings(stored.findings, found, start);
    let findings = merged.findings;
    const guard = this.d.guard;
    let failed: FixFailure[] = [];
    let loaded: Loaded | undefined;
    if (guard) {
      if (inQuietTime(start, guard.startedAt, config.cooldown_minutes)) for (const f of merged.fresh) f.quietStart = true;
      ({ findings, failed } = failedFixes(findings, storyRuns));
      loaded = loadGuard();
      // The breaker is closed again: stories that were skipped because of it are written to the log again if it reopens.
      if (loaded.ok && !loaded.data.breaker?.open) findings = forgetSkip(findings, "breaker");
    }
    saveFindings(findings, file);
    for (const x of failed) {
      writeLog({ event: "fix-failed", detector: x.finding.detector, fingerprint: x.finding.fingerprint, repo: x.repo, issue: x.issue, count: x.count }, { now: start, onError: guard?.onLogError });
      this.act(describeEntry({ event: "fix-failed", detector: x.finding.detector, issue: x.issue, count: x.count }));
    }
    for (const f of merged.fresh) this.act(`new finding (${f.severity}) ${f.detector}: ${f.summary}`);
    for (const f of merged.gone) this.act(`finding gone: ${f.detector}: ${f.summary}`);
    if (merged.dropped) this.act(`${merged.dropped} findings were dropped to keep the list at its limit`);
    if (guard && loaded?.ok && config.report_to) {
      const state = storiesState(loaded, { startedAt: guard.startedAt, cooldownMinutes: config.cooldown_minutes, now: start });
      if (state.state === "on" || state.state === "quiet") {
        const from = loaded.data.breaker?.from;
        const why = decideBreaker({ findings, storyRuns, config: config.breaker, now: start, from });
        if (why) {
          guard.beforeOpen?.();
          const open = openBreaker(why, from, { now: start, onLogError: guard.onLogError });
          if (open && open.since === start.toISOString()) this.act(describeEntry({ event: "breaker-open", reason: open.reason, count: open.count, minutes: "minutes" in open ? open.minutes : undefined }));
        }
      }
    }
    if (this.d.reporter) {
      const r = await this.d.reporter.report(findings, start, (f) => saveFindings(keepEarlier(findings, f), file));
      for (const a of r.actions) this.act(a);
      for (const n of r.notes) if (!this.noted.has(n)) this.d.log(`[${this.cfg.id}] ${n}`);
      this.noted = new Set(r.notes);
      this.status.notes = r.notes.length ? r.notes : undefined;
    }
  }

  /**
   * The area locks the lock tool honours, as the tool judges them: its owner's run.json says "running". A lock whose owner
   * is not alive is an orphan; the monitor counts its age from the check that first saw it (a file time would be the
   * last write of a long step, so every server restart would look like a dead owner).
   */
  private areaLocks(now: Date, activeIds: string[], locks: LockFile[]): AreaLock[] {
    const seen = new Map<string, string>();
    const out: AreaLock[] = [];
    for (const lock of locks) {
      let owner: { status?: unknown; pid?: unknown };
      try {
        owner = JSON.parse(readFileSync(runFile(lock.runDir), "utf8")) as typeof owner;
      } catch (e) {
        // Missing: the tool ignores the lock. Cannot be parsed: the tool takes the owner as alive (it may be written right
        // now), so the clock starts; only a file that stays broken for the whole interval is reported.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        const orphanSince = this.orphans.get(lock.key) ?? now.toISOString();
        seen.set(lock.key, orphanSince);
        out.push({ repo: lock.repo, areas: lock.areas, at: lock.at, orphanSince });
        continue;
      }
      if (owner?.status !== "running") continue;
      const pid = owner.pid;
      if (activeIds.includes(lock.runId) || (typeof pid === "number" && pid !== process.pid && pidAlive(pid))) {
        out.push({ repo: lock.repo, areas: lock.areas, at: lock.at });
        continue;
      }
      const orphanSince = this.orphans.get(lock.key) ?? now.toISOString();
      seen.set(lock.key, orphanSince);
      out.push({ repo: lock.repo, areas: lock.areas, at: lock.at, orphanSince });
    }
    this.orphans = seen;
    return out;
  }

  /**
   * The runs the detectors need, each once, newest write first, at most MAX_RUNS: runs written lately (for restart loops),
   * failed runs, and runs written within the longest look-back of the develop and slow-step detectors.
   */
  private async collect(briefs: RunBrief[], now: Date, config: MonitorConfig): Promise<RunSummary[]> {
    const t = now.getTime();
    const written = (b: RunBrief) => Date.parse(b.updatedAt);
    const resumedFrom = t - config.restart_loop.within_minutes * 60_000;
    const failedFrom = t - Math.max(config.unexplained_failure.within_hours, config.same_step_failing.within_hours, 1) * HOUR;
    const recentFrom = t - Math.max(config.develop_red.within_hours, config.slow_step.within_hours) * HOUR;
    const picked = briefs
      .filter((b) => written(b) >= resumedFrom || (b.status === "failed" && Date.parse(b.finishedAt ?? b.startedAt) >= failedFrom) || written(b) >= recentFrom)
      .sort((a, b) => written(b) - written(a))
      .slice(0, MAX_RUNS);
    return this.load(picked);
  }

  private async load(briefs: RunBrief[]): Promise<RunSummary[]> {
    const runs: RunSummary[] = [];
    for (const [i, b] of briefs.entries()) {
      if (i > 0 && i % YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
      try {
        const run = this.d.scheduler.get(b.dirName);
        if (run) runs.push(run);
      } catch {
        // a run.json that cannot be read is left out
      }
    }
    return runs;
  }

  /** The usual step times: the newest succeeded runs that finished before the look-back, so slow runs never raise their own baseline. Built once an hour. */
  private async usual(briefs: RunBrief[], now: Date, config: MonitorConfig): Promise<DurationHistory> {
    const t = now.getTime();
    const hours = config.slow_step.within_hours;
    const c = this.usualCache;
    if (c && c.hours === hours && t - c.at >= 0 && t - c.at < HOUR) return c.history;
    const before = t - hours * HOUR;
    const done = (b: RunBrief) => Date.parse(b.finishedAt ?? b.startedAt);
    const picked = briefs.filter((b) => b.status === "succeeded" && done(b) < before).sort((a, b) => done(b) - done(a)).slice(0, USUAL_RUNS);
    const history = buildHistory(await this.load(picked));
    this.usualCache = { at: t, hours, history };
    return history;
  }
}
