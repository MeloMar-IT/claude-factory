import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stepLogFile } from "../engine/execute.js";
import type { RunSummary } from "../engine/state.js";
import { nextStep, releaseAtFor, runNextStep, trackingWatcher, type NextStep } from "../next-step.js";
import { labelNames, parseInterval, type WatcherStatus } from "../queue/watcher.js";
import type { WatcherConfig } from "../config.js";
import { supersededRuns } from "../stats.js";
import { send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

/** Why the server waits to restart, and since when. */
export interface RestartState { why: "new_version" | "data_folder"; since: string }

/** The run waits for a code area: the last line of the claim_areas log says which run holds it. */
export function areaWait(run: RunSummary): { runId: string; areas: string } | undefined {
  if (run.status !== "running" || run.state?.next !== "claim_areas") return undefined;
  try {
    const log = readFileSync(stepLogFile(join(run.runDir, "logs"), run.history.length, "claim_areas"), "utf8");
    const last = log.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
    const m = /^waiting for run (\S+) \((.*)\)$/.exec(last);
    return m ? { runId: m[1]!, areas: m[2]! } : undefined;
  } catch {
    return undefined;
  }
}

/** The watcher's "closed on GitHub, run still busy" record for a run. */
function closedHold(tracked: { status: WatcherStatus }[], runId: string): NextStep | undefined {
  return tracked.flatMap((t) => t.status.holds ?? []).find((h) => h.next.kind === "closed_elsewhere" && h.next.runId === runId)?.next;
}

/**
 * Builds the record of any run. Reads the context when called, so do not keep the returned
 * function across requests or events.
 */
export function nextFor(ctx: ApiContext, runs?: RunSummary[]): (run: RunSummary) => NextStep {
  const cfg = ctx.config();
  const pending = ctx.scheduler.queue().pending;
  const tracked = ctx.watchers.tracked();
  let list = runs;
  const load = () => (list ??= ctx.scheduler.list(200));
  let replaced: Set<string> | undefined;
  return (run) => {
    const v = run.vars ?? {};
    const queued = pending.find((p) => p.runId === run.runId);
    const w = trackingWatcher(cfg.watchers, run);
    const hasWork = !!v.github_repo && !!(v.issue || v.pr || v.ci_run);
    let superseded = false;
    if (run.status !== "running" && !queued && hasWork) {
      const known = load();
      if (known.some((r) => r.runId === run.runId)) superseded = (replaced ??= supersededRuns(known)).has(run.runId);
      else superseded = supersededRuns([...known, run]).has(run.runId); // an older run beyond the loaded list
    }
    const title = tracked.flatMap((t) => t.issues.filter(() => t.watcher.github_repo === v.github_repo)).find((i) => String(i.issue) === v.issue)?.title;
    const rec = runNextStep(run, {
      queued: queued ? { waitingFor: queued.waitingFor } : undefined,
      superseded,
      watched: !!w,
      failedLabel: w && labelNames(w).failed,
      releaseAt: run.status === "succeeded" ? releaseAtFor(cfg.watchers, run, load()) : undefined,
      title,
      areaWait: areaWait(run),
    });
    // A closed issue whose run is still busy: the watcher's record says so.
    if (queued || run.status === "running" || run.status === "waiting") {
      const closed = closedHold(tracked, run.runId);
      if (closed) return closed;
    }
    // The watcher's hold for the same run and reason knows more (pull request, question count).
    const hold = tracked.flatMap((t) => t.status.holds ?? []).find((h) => h.next.runId === run.runId && h.next.kind === rec.kind);
    return hold?.next ?? rec;
  };
}

type Queue = ReturnType<ApiContext["scheduler"]["queue"]>;
type PendingJob = Queue["pending"][number];

/** The record of a queued job that has no run yet. */
function jobNext(p: PendingJob): NextStep {
  const issue = p.issue && /^\d+$/.test(p.issue) ? Number(p.issue) : undefined;
  return nextStep(p.waitingFor ? "one_at_a_time" : "queued", { repo: p.githubRepo ?? p.repo, issue, title: (p.task ?? "").split("\n")[0], runId: p.runId }, { blockingRun: p.waitingFor });
}

const watcherError = (repo: string, reason: string): NextStep => nextStep("watcher_error", { repo }, { reason });

/** A watcher's own record: its error, or (enabled, no error) no finished check for more than 3× its interval. */
export function watcherProblem(w: WatcherConfig, status: WatcherStatus | undefined, now = Date.now()): NextStep | undefined {
  if (status?.lastError) return watcherError(w.github_repo, status.lastError);
  if (!w.enabled || !status) return undefined;
  let every: number;
  try {
    every = parseInterval(w.every);
  } catch (e) {
    return watcherError(w.github_repo, (e as Error).message);
  }
  const last = status.lastTick ?? status.startedAt;
  if (last && now - Date.parse(last) > 3 * every) return nextStep("watcher_stale", { repo: w.github_repo }, { lastCheck: last });
  return undefined;
}

/** GET /api/queue: the queue, each pending job with its record as `next`. */
export function queueWithNext(ctx: ApiContext): Omit<Queue, "pending"> & { pending: (PendingJob & { next: NextStep })[] } {
  const q = ctx.scheduler.queue();
  const next = nextFor(ctx);
  const tracked = ctx.watchers.tracked();
  return { ...q, pending: q.pending.map((p) => {
    const run = ctx.scheduler.get(p.runId);
    return { ...p, next: run ? next(run) : closedHold(tracked, p.runId) ?? jobNext(p) };
  }) };
}

/** GET /api/watchers: a watcher with an error carries its record as `status.next`. */
export function watchersWithNext(ctx: ApiContext): (WatcherConfig & { status?: WatcherStatus & { next?: NextStep } })[] {
  return ctx.watchers.statuses().map((w) => {
    const next = w.status ? watcherProblem(w, w.status) : undefined;
    return next && w.status ? { ...w, status: { ...w.status, next } } : w;
  });
}

/** Records for the server, the watchers, every tracked issue and every run. */
export function allNext(ctx: ApiContext): { server: NextStep[]; watchers: NextStep[]; issues: NextStep[]; runs: NextStep[] } {
  const list = ctx.scheduler.list(Infinity); // every record, not just the newest runs
  const next = nextFor(ctx, list);
  const q = ctx.scheduler.queue();
  const tracked = ctx.watchers.tracked();
  const restartWhy = ctx.restart?.why;

  const server = ctx.restart ? [nextStep("restart", {}, { restartWhy })] : [];

  const watchers: NextStep[] = [];
  for (const t of tracked) {
    const problem = watcherProblem(t.watcher, t.status);
    // Drained watchers are stopped on purpose while the server waits to restart.
    if (problem && !(problem.kind === "watcher_stale" && ctx.restart)) watchers.push(problem);
    for (const h of t.status.holds ?? []) if (!h.issue) watchers.push(h.next);
  }

  const byRun = new Map(list.map((r) => [r.runId, r]));
  const live = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  const picked = new Map<string, { rank: number; rec: NextStep }>();
  for (const t of tracked) {
    for (const i of t.issues) {
      const base = { repo: t.watcher.github_repo, issue: i.issue, title: i.title, runId: i.runId };
      const run = i.runId ? byRun.get(i.runId) : undefined;
      const isLive = !!i.runId && live.has(i.runId);
      const hold = (t.status.holds ?? []).find((h) => h.issue === i.issue);
      const data = { watched: true, issueUrl: `https://github.com/${t.watcher.github_repo}/issues/${i.issue}` };
      let rec: NextStep;
      const queuedJob = i.runId ? q.pending.find((p) => p.runId === i.runId) : undefined;
      if (run && isLive) rec = next(run);
      else if (queuedJob && !run) rec = nextStep(queuedJob.waitingFor ? "one_at_a_time" : "queued", base, { ...data, blockingRun: queuedJob.waitingFor });
      else if (hold) rec = hold.next;
      else if (run) rec = next(run);
      else if (i.done) rec = nextStep("done", base, data);
      else rec = nextStep(ctx.restart ? "restart" : "starting", base, { ...data, restartWhy });
      const key = `${base.repo}#${i.issue}`;
      const rank = isLive ? 0 : i.done ? 2 : 1;
      const have = picked.get(key);
      if (!have || rank < have.rank) picked.set(key, { rank, rec });
    }
  }

  const runs = list.map(next);
  for (const p of q.pending) {
    if (byRun.has(p.runId) || p.kind !== "run") continue;
    runs.push(closedHold(tracked, p.runId) ?? jobNext(p));
  }

  return { server, watchers, issues: [...picked.values()].map((p) => p.rec), runs };
}

export const nextRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "next" || seg[1] || method !== "GET") return false;
  return send(res, 200, allNext(ctx)), true;
};
