import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newRunId, runFlow, type RunSummary } from "../engine/runner.js";
import type { Flow } from "../flow/schema.js";

const MAX_LOG_LINES = 5000;

export type RunEvent = { type: "log"; line: string } | { type: "update"; summary: RunSummary };

interface ActiveRun {
  controller: AbortController;
  lines: string[];
  summary?: RunSummary;
  listeners: Set<(e: RunEvent) => void>;
}

/** Starts runs in the background and fans their progress out to subscribers. */
export class RunManager {
  private active = new Map<string, ActiveRun>();

  constructor(
    private runsDir: string,
    private claudeBin?: string,
  ) {}

  start(flow: Flow, task: string, repo: string, vars: Record<string, string>): string {
    const runId = newRunId();
    const run: ActiveRun = { controller: new AbortController(), lines: [], listeners: new Set() };
    this.active.set(runId, run);
    const emit = (e: RunEvent) => run.listeners.forEach((l) => l(e));

    runFlow(flow, {
      task,
      repo,
      vars,
      runId,
      runsDir: this.runsDir,
      claudeBin: this.claudeBin,
      signal: run.controller.signal,
      log: (line) => {
        run.lines.push(line);
        if (run.lines.length > MAX_LOG_LINES) run.lines.shift();
        emit({ type: "log", line });
      },
      onUpdate: (summary) => {
        run.summary = structuredClone(summary);
        emit({ type: "update", summary: run.summary });
      },
    })
      .catch((e: Error) => emit({ type: "log", line: `✘ internal error: ${e.message}` }))
      .finally(() => {
        // Keep the log buffer around briefly so late subscribers still get it.
        setTimeout(() => this.active.delete(runId), 10 * 60_000).unref();
      });
    return runId;
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run || run.summary?.status !== "running") return false;
    run.controller.abort();
    return true;
  }

  get(runId: string): RunSummary | undefined {
    const live = this.active.get(runId)?.summary;
    if (live) return live;
    const p = join(this.runsDir, runId, "run.json");
    if (!/^[\w-]+$/.test(runId) || !existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as RunSummary;
  }

  list(limit = 50): RunSummary[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .sort()
      .reverse()
      .slice(0, limit)
      .map((id) => this.get(id))
      .filter((s): s is RunSummary => !!s)
      .map((s) => this.markStale(s));
  }

  /** A "running" run.json with no live process belongs to a server that died. */
  private markStale(s: RunSummary): RunSummary {
    if (s.status === "running" && !this.active.has(s.runId)) return { ...s, status: "failed", reason: "interrupted" };
    return s;
  }

  /** Subscribe to a run: replays buffered log lines, then streams. Returns unsubscribe. */
  subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
    const run = this.active.get(runId);
    run?.lines.forEach((line) => fn({ type: "log", line }));
    // Summary after the log replay: clients close the stream once a run is finished.
    const summary = this.get(runId);
    if (summary) fn({ type: "update", summary: this.markStale(summary) });
    if (!run) return () => {};
    run.listeners.add(fn);
    return () => run.listeners.delete(fn);
  }
}
