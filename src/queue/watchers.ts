import type { Config, WatcherConfig } from "../config.js";
import { readRateLimit, type RateReading } from "../github.js";
import type { DetectorInput, LogLine } from "../monitor/detectors.js";
import { Monitor } from "../monitor/monitor.js";
import type { RunSummary } from "../engine/state.js";
import type { Scheduler } from "./scheduler.js";
import { StatusComments, statusFile } from "./status-comment.js";
import { Watcher, type WatcherStatus } from "./watcher.js";

export interface WatcherManagerOptions {
  scheduler: Scheduler;
  runsDir: string;
  repo: string;
  config: () => Config;
  areaWait?: (run: RunSummary) => { runId: string; areas: string } | undefined;
  log: (msg: string) => void;
  /** The newest server log lines, for the monitor. */
  serverLog?: () => LogLine[];
  /** Set while the server waits to restart, for the monitor. */
  restart?: () => DetectorInput["restart"];
}

/** What a watcher tracks right now, for the next-step records. */
export interface TrackedWatcher {
  watcher: WatcherConfig;
  status: WatcherStatus;
  issues: Watcher["tracked"];
}

/** Keeps running watchers in line with config.watchers (start, stop, restart on change). */
export class WatcherManager {
  private running = new Map<string, { watcher: Watcher; key: string }>();
  /** Watchers stopped by stopAll() (a drain); read live so a tick still in flight shows up. */
  private drained: Watcher[] = [];

  /** One writer of status comments per repository, shared by its watchers. */
  private boards = new Map<string, StatusComments>();

  /** The monitor (source "monitor"), when one is enabled; it has no repository and no Watcher. */
  private monitor?: { monitor: Monitor; key: string };
  /** The last reading of GitHub's request limit, and when one was last tried (a try counts, so a failing call is not repeated). */
  private rate?: RateReading;
  private rateTried = 0;

  constructor(private o: WatcherManagerOptions) {}

  private board(repo: string): StatusComments {
    let b = this.boards.get(repo);
    if (!b) {
      b = new StatusComments(repo, (m) => this.o.log(`[${repo}] ${m}`), { file: statusFile() });
      this.boards.set(repo, b);
    }
    return b;
  }

  sync() {
    this.drained = [];
    const wanted = new Map(this.o.config().watchers.filter((w) => w.enabled && w.source !== "monitor").map((w) => [w.id, w]));
    for (const [id, r] of this.running) {
      const cfg = wanted.get(id);
      if (!cfg || JSON.stringify(cfg) !== r.key) {
        r.watcher.stop();
        this.board(r.watcher.cfg.github_repo).forget(id);
        this.running.delete(id);
        this.o.log(`[${id}] watcher stopped`);
      }
    }
    for (const [id, cfg] of wanted) {
      if (this.running.has(id)) continue;
      const watcher = new Watcher(cfg, {
        scheduler: this.o.scheduler,
        runsDir: this.o.runsDir,
        repo: this.o.repo,
        dailyBudget: () => (this.o.config().cost_limits ? this.o.config().daily_budget_usd : undefined),
        areaWait: this.o.areaWait,
        log: this.o.log,
        statusComments: this.board(cfg.github_repo),
        watchers: () => this.o.config().watchers,
        peers: () => this.tracked(),
        afterCheck: () => this.noteRateLimit(),
      });
      this.running.set(id, { watcher, key: JSON.stringify(cfg) });
      watcher.start();
      this.o.log(`[${id}] watching ${cfg.github_repo} (${cfg.source}) every ${cfg.every}`);
    }
    this.syncMonitor(this.o.config().watchers.find((w) => w.source === "monitor" && w.enabled));
  }

  /** Starts, stops or restarts the one monitor (same comparison as the watchers). */
  private syncMonitor(cfg?: WatcherConfig) {
    const key = cfg ? JSON.stringify(cfg) : undefined;
    if (this.monitor && this.monitor.key !== key) {
      this.monitor.monitor.stop();
      this.o.log(`[${this.monitor.monitor.cfg.id}] monitor stopped`);
      this.monitor = undefined;
    }
    if (!cfg || this.monitor) return;
    const monitor = new Monitor(cfg, {
      scheduler: this.o.scheduler,
      watchers: () => this.tracked().map(({ watcher, status, issues }) => ({ cfg: watcher, status, issues })),
      restart: this.o.restart,
      thresholds: () => this.o.config().monitor,
      serverLog: this.o.serverLog,
      rateLimit: () => this.rate,
      beforeCheck: () => this.noteRateLimit(),
      log: this.o.log,
    });
    this.monitor = { monitor, key: key! };
    monitor.start();
    this.o.log(`[${cfg.id}] monitoring the Foundry every ${cfg.every}`);
  }

  /** After a watcher's check, with a monitor on: read GitHub's request limit, at most once a minute. Never throws. */
  private async noteRateLimit() {
    if (!this.monitor || Date.now() - this.rateTried < 60_000) return;
    this.rateTried = Date.now();
    const own = await readRateLimit();
    // Runs may act as the bot (a token in an env var): its limit is its own, listed as "bot:core" and so on.
    const name = this.o.config().bot.gh_token_env;
    const token = name ? process.env[name] : undefined;
    const bot = token ? await readRateLimit(4_000, { GH_TOKEN: token }, "bot:") : undefined;
    if (!own && !bot) return;
    this.rate = { at: (own ?? bot)!.at, resources: { ...(own?.resources ?? {}), ...(bot?.resources ?? {}) } };
  }

  statuses(): (WatcherConfig & { status?: WatcherStatus })[] {
    return this.o.config().watchers.map((cfg) => ({
      ...cfg,
      status: cfg.source === "monitor" ? this.monitor?.monitor.status : this.running.get(cfg.id)?.watcher.status,
    }));
  }

  /** Every watcher that runs, or (after stopAll) the ones that were stopped; status and issues are read live. */
  tracked(): TrackedWatcher[] {
    const list = this.running.size ? [...this.running.values()].map((r) => r.watcher) : this.drained;
    return list.map((w) => ({ watcher: w.cfg, status: w.status, issues: w.tracked }));
  }

  private kickTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A run on this repository finished: its watchers check right away (after a moment, so the
   * finished run's labels are updated first) — the next story, a resume or a retry needs no wait.
   */
  kickRepo(githubRepo: string, delayMs = 3000) {
    clearTimeout(this.kickTimers.get(githubRepo));
    const t = setTimeout(() => {
      this.kickTimers.delete(githubRepo);
      for (const r of this.running.values()) if (r.watcher.cfg.github_repo === githubRepo) r.watcher.kick();
    }, delayMs);
    t.unref?.();
    this.kickTimers.set(githubRepo, t);
  }

  async runNow(id: string) {
    if (this.monitor?.monitor.cfg.id === id) {
      await this.monitor.monitor.tick(true);
      return this.monitor.monitor.status;
    }
    const r = this.running.get(id);
    if (!r) throw new Error(`watcher "${id}" is not running`);
    await r.watcher.tick();
    return r.watcher.status;
  }

  /** Stops the watchers; the monitor too, unless `keepMonitor` (it watches the drain of a new version). */
  stopAll(keepMonitor = false) {
    this.drained = [...this.running.values()].map((r) => r.watcher);
    for (const r of this.running.values()) r.watcher.stop();
    this.running.clear();
    if (keepMonitor) return;
    this.monitor?.monitor.stop();
    this.monitor = undefined;
  }

  /** Stops the watchers and keeps the monitor running, so a restart that takes too long is seen. */
  drain() {
    this.stopAll(true);
  }
}
