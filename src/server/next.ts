import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stepLogFile } from "../engine/execute.js";
import type { RunSummary } from "../engine/state.js";
import { nextStep, releaseAtFor, runNextStep, trackingWatcher, type NextStep } from "../next-step.js";
import { labelNames, type Hold, type WatcherStatus } from "../queue/watcher.js";
import type { WatcherConfig } from "../config.js";
import { supersededRuns } from "../stats.js";
import { watcherState, type WatcherState } from "../words.js";
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

/** GET /api/queue: the queue, each pending job with its record as `next`. */
export function queueWithNext(ctx: ApiContext): Omit<Queue, "pending"> & { pending: (PendingJob & { next: NextStep })[] } {
  const q = ctx.scheduler.queue();
  const next = nextFor(ctx);
  return { ...q, pending: q.pending.map((p) => {
    const run = ctx.scheduler.get(p.runId);
    return { ...p, next: run ? next(run) : jobNext(p) };
  }) };
}

/** GET /api/watchers: each watcher carries its own `state` (words for active, error, disabled); one with an error also has its record as `status.next`. */
export function watchersWithNext(ctx: ApiContext): (WatcherConfig & { state: WatcherState; status?: WatcherStatus & { next?: NextStep } })[] {
  return ctx.watchers.statuses().map((w) => {
    const state = watcherState(!w.enabled ? "disabled" : w.status?.lastError ? "error" : "active");
    return w.status?.lastError
      ? { ...w, state, status: { ...w.status, next: watcherError(w.github_repo, w.status.lastError) } }
      : { ...w, state };
  });
}

/** A record and what the Your turn page needs to know about it. */
export interface Entry {
  next: NextStep;
  /** A real time it waits since (from GitHub or the run). */
  since?: string;
  /** When this server first saw it (no real time known). */
  seen?: string;
  watcher?: string;
  prTitle?: string;
}

/** The time a run's record is about: since when it waits, or when it ended. */
export const runSince = (run: RunSummary): string => run.waiting?.since ?? run.finishedAt ?? run.startedAt;

/**
 * Every record the server knows: itself, the watchers, every issue a watcher tracks (one per
 * watcher) and a function for the runs. `list` is the loaded runs.
 */
export function collectNext(ctx: ApiContext, list: RunSummary[]) {
  const next = nextFor(ctx, list);
  const q = ctx.scheduler.queue();
  const tracked = ctx.watchers.tracked();
  const restartWhy = ctx.restart?.why;

  const server = ctx.restart ? [nextStep("restart", {}, { restartWhy })] : [];

  const holdEntry = (t: (typeof tracked)[number], h: Hold): Entry => {
    const by = t.status.pausedBy;
    // A hold about a run is as old as the run's wait; "seen" starts again after a restart.
    const run = h.next.runId ? list.find((r) => r.runId === h.next.runId) : undefined;
    return { next: h.next, since: h.since ?? (run ? runSince(run) : undefined), seen: h.seen, watcher: t.watcher.id, prTitle: by && by.url === h.next.where.url ? by.title : undefined };
  };
  const watchers: Entry[] = [];
  for (const t of tracked) {
    if (t.status.lastError) watchers.push({ next: watcherError(t.watcher.github_repo, t.status.lastError), since: t.status.errorSince, watcher: t.watcher.id });
    for (const h of t.status.holds ?? []) if (!h.issue) watchers.push(holdEntry(t, h));
  }

  const byRun = new Map(list.map((r) => [r.runId, r]));
  const live = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  const issues: (Entry & { key: string; rank: number })[] = [];
  for (const t of tracked) {
    for (const i of t.issues) {
      const base = { repo: t.watcher.github_repo, issue: i.issue, title: i.title, runId: i.runId };
      const run = i.runId ? byRun.get(i.runId) : undefined;
      const isLive = !!i.runId && live.has(i.runId);
      const hold = (t.status.holds ?? []).find((h) => h.issue === i.issue);
      const data = { watched: true, issueUrl: `https://github.com/${t.watcher.github_repo}/issues/${i.issue}` };
      let e: Entry;
      const queuedJob = i.runId ? q.pending.find((p) => p.runId === i.runId) : undefined;
      if (run && isLive) e = { next: next(run), since: runSince(run) };
      else if (queuedJob && !run) e = { next: nextStep(queuedJob.waitingFor ? "one_at_a_time" : "queued", base, { ...data, blockingRun: queuedJob.waitingFor }) };
      else if (hold) e = holdEntry(t, hold);
      else if (run) e = { next: next(run), since: runSince(run) };
      else if (i.done) e = { next: nextStep("done", base, data) };
      else e = { next: nextStep(ctx.restart ? "restart" : "starting", base, { ...data, restartWhy }) };
      issues.push({ ...e, watcher: t.watcher.id, key: `${base.repo}#${i.issue}`, rank: isLive ? 0 : i.done ? 2 : 1 });
    }
  }

  const runs = () => {
    const out = list.map(next);
    for (const p of q.pending) {
      if (byRun.has(p.runId) || p.kind !== "run") continue;
      out.push(jobNext(p));
    }
    return out;
  };

  return { server, watchers, issues, runs, next };
}

/** Records for the server, the watchers, every tracked issue and every run. */
export function allNext(ctx: ApiContext): { server: NextStep[]; watchers: NextStep[]; issues: NextStep[]; runs: NextStep[] } {
  const c = collectNext(ctx, ctx.scheduler.list(Infinity)); // every record, not just the newest runs
  // One record per issue: a running one first, a finished one last; the first watcher wins a tie.
  const picked = new Map<string, { rank: number; rec: NextStep }>();
  for (const i of c.issues) {
    const have = picked.get(i.key);
    if (!have || i.rank < have.rank) picked.set(i.key, { rank: i.rank, rec: i.next });
  }
  return { server: c.server, watchers: c.watchers.map((w) => w.next), issues: [...picked.values()].map((p) => p.rec), runs: c.runs() };
}

export const nextRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "next" || seg[1] || method !== "GET") return false;
  return send(res, 200, allNext(ctx)), true;
};
