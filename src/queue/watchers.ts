import type { Config, WatcherConfig } from "../config.js";
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
    const wanted = new Map(this.o.config().watchers.filter((w) => w.enabled).map((w) => [w.id, w]));
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
      });
      this.running.set(id, { watcher, key: JSON.stringify(cfg) });
      watcher.start();
      this.o.log(`[${id}] watching ${cfg.github_repo} (${cfg.source}) every ${cfg.every}`);
    }
  }

  statuses(): (WatcherConfig & { status?: WatcherStatus })[] {
    return this.o.config().watchers.map((cfg) => ({ ...cfg, status: this.running.get(cfg.id)?.watcher.status }));
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
    const r = this.running.get(id);
    if (!r) throw new Error(`watcher "${id}" is not running`);
    await r.watcher.tick();
    return r.watcher.status;
  }

  stopAll() {
    this.drained = [...this.running.values()].map((r) => r.watcher);
    for (const r of this.running.values()) r.watcher.stop();
    this.running.clear();
  }
}
