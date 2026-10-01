import type { Config, WatcherConfig } from "../config.js";
import type { Scheduler } from "./scheduler.js";
import { Watcher, type WatcherStatus } from "./watcher.js";

export interface WatcherManagerOptions {
  scheduler: Scheduler;
  runsDir: string;
  repo: string;
  config: () => Config;
  log: (msg: string) => void;
}

/** Keeps running watchers in line with config.watchers (start, stop, restart on change). */
export class WatcherManager {
  private running = new Map<string, { watcher: Watcher; key: string }>();

  constructor(private o: WatcherManagerOptions) {}

  sync() {
    const wanted = new Map(this.o.config().watchers.filter((w) => w.enabled).map((w) => [w.id, w]));
    for (const [id, r] of this.running) {
      const cfg = wanted.get(id);
      if (!cfg || JSON.stringify(cfg) !== r.key) {
        r.watcher.stop();
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
        log: this.o.log,
      });
      this.running.set(id, { watcher, key: JSON.stringify(cfg) });
      watcher.start();
      this.o.log(`[${id}] watching ${cfg.github_repo} (${cfg.source}) every ${cfg.every}`);
    }
  }

  statuses(): (WatcherConfig & { status?: WatcherStatus })[] {
    return this.o.config().watchers.map((cfg) => ({ ...cfg, status: this.running.get(cfg.id)?.watcher.status }));
  }

  async runNow(id: string) {
    const r = this.running.get(id);
    if (!r) throw new Error(`watcher "${id}" is not running`);
    await r.watcher.tick();
    return r.watcher.status;
  }

  stopAll() {
    for (const r of this.running.values()) r.watcher.stop();
    this.running.clear();
  }
}
