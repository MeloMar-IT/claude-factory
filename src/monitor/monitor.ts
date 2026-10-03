import type { MonitorConfig, WatcherConfig } from "../config.js";
import type { RunSummary } from "../engine/state.js";
import { errorLine, GITHUB_LIMIT_RE } from "../errors.js";
import type { RateReading } from "../github.js";
import { parseInterval, type WatcherStatus } from "../queue/watcher.js";
import type { Scheduler } from "../queue/scheduler.js";
import { DETECTORS, runDetectors, type Detector, type LogLine } from "./detectors.js";
import { findingsFile, loadFindings, mergeFindings, saveFindings } from "./findings.js";
import type { Reporter } from "./report.js";

export interface MonitorDeps {
  scheduler: Pick<Scheduler, "briefs" | "get" | "queue"> & Partial<Pick<Scheduler, "briefsAsync">>;
  /** The other watchers with their status. */
  watchers: () => { cfg: WatcherConfig; status: WatcherStatus }[];
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
}

/** At most this many runs are loaded in one check. */
export const MAX_RUNS = 1000;
const YIELD_EVERY = 25;
const HOUR = 3_600_000;

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

  private act(msg: string) {
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
    const config = this.d.thresholds();
    await this.d.beforeCheck?.().catch(() => {}); // e.g. read GitHub's request limit, so the detectors see it
    const runs = await this.collect(start, config);
    const found = runDetectors(this.d.detectors ?? DETECTORS, {
      now: start, asleep, config, runs, watchers: this.d.watchers(), log: this.d.serverLog?.() ?? [], rate: this.d.rateLimit?.(), queue: this.d.scheduler.queue(), monitorId: this.cfg.id,
    });
    const stored = loadFindings(this.d.file ?? findingsFile());
    if (stored.broken) this.act("the findings file could not be read; it was kept as monitor-findings.json.broken");
    const merged = mergeFindings(stored.findings, found, start);
    saveFindings(merged.findings, this.d.file ?? findingsFile());
    for (const f of merged.fresh) this.act(`new finding (${f.severity}) ${f.detector}: ${f.summary}`);
    for (const f of merged.gone) this.act(`finding gone: ${f.detector}: ${f.summary}`);
    if (merged.dropped) this.act(`${merged.dropped} findings were dropped to keep the list at its limit`);
    if (this.d.reporter) {
      const r = await this.d.reporter.report(merged.findings, start, (f) => saveFindings(f, this.d.file ?? findingsFile()));
      for (const a of r.actions) this.act(a);
      for (const n of r.notes) if (!this.noted.has(n)) this.d.log(`[${this.cfg.id}] ${n}`);
      this.noted = new Set(r.notes);
      this.status.notes = r.notes.length ? r.notes : undefined;
    }
  }

  /** The runs the detectors need: recently resumed ones first, then recently failed ones. At most MAX_RUNS. */
  private async collect(now: Date, config: MonitorConfig): Promise<RunSummary[]> {
    const t = now.getTime();
    const briefs = this.d.scheduler.briefsAsync ? await this.d.scheduler.briefsAsync() : this.d.scheduler.briefs();
    const resumedFrom = t - config.restart_loop.within_minutes * 60_000;
    const failedFrom = t - Math.max(config.unexplained_failure.within_hours, 1) * HOUR;
    const resumed = briefs.filter((b) => Date.parse(b.updatedAt) >= resumedFrom).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const failed = briefs.filter((b) => b.status === "failed" && Date.parse(b.finishedAt ?? b.startedAt) >= failedFrom)
      .sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt) - Date.parse(a.finishedAt ?? a.startedAt));
    const names = new Set<string>();
    const picked = [...resumed, ...failed].filter((b) => !names.has(b.dirName) && names.add(b.dirName)).slice(0, MAX_RUNS);
    const runs: RunSummary[] = [];
    for (const [i, b] of picked.entries()) {
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
}
