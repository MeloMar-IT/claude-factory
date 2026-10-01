import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stepLogFile } from "../engine/execute.js";
import { buildHistory, runProgress, runTiming, withWaitLeft, type DurationHistory } from "../estimate.js";
import type { RunSummary } from "../engine/state.js";
import { nextStep, releaseAtFor, runNextStep, trackingWatcher, type NextStep } from "../next-step.js";
import { labelNames, type WatcherStatus } from "../queue/watcher.js";
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

const HISTORY_RUNS = 500;
const HISTORY_TTL_MS = 5 * 60_000;
const histories = new WeakMap<ApiContext, { at: number; history: DurationHistory }>();

/** Durations of the newest runs; built at most every 5 minutes because it reads many run files. */
export function historyFor(ctx: ApiContext): DurationHistory {
  const have = histories.get(ctx);
  if (have && Date.now() - have.at < HISTORY_TTL_MS) return have.history;
  const history = buildHistory(ctx.scheduler.list(HISTORY_RUNS));
  histories.set(ctx, { at: Date.now(), history });
  return history;
}

export function forgetHistory(ctx: ApiContext): void {
  histories.delete(ctx);
}

/** Adds "(about N min left)" to `until` when every run the record waits for is running and has an estimate. */
function waitLeftFor(ctx: ApiContext): (rec: NextStep) => NextStep {
  return (rec) => {
    const ids = rec.kind === "dependency"
      ? (rec.blockers ?? []).flatMap((b) => (b.next?.kind === "running" && b.next.runId ? [b.next.runId] : []))
      : rec.afterRun ? [rec.afterRun] : [];
    if (!ids.length) return rec;
    if (ids.length < (rec.kind === "dependency" ? (rec.blockers ?? []).length : 1)) return rec;
    if (ids.some((id) => !ctx.scheduler.isActive(id))) return rec;
    // Jobs behind the same run wait for each other too: only the first one can say how long.
    if (rec.kind === "one_at_a_time" && rec.runId) {
      const pending = ctx.scheduler.queue().pending;
      const mine = pending.findIndex((p) => p.runId === rec.runId);
      if (pending.slice(0, Math.max(mine, 0)).some((p) => p.waitingFor === rec.afterRun)) return rec;
    }
    const lefts = ids.map((id) => {
      const run = ctx.scheduler.get(id);
      return run && !areaWait(run) ? runTiming(run, historyFor(ctx))?.leftMs : undefined;
    });
    if (lefts.some((l) => l === undefined)) return rec;
    return withWaitLeft(rec, Math.max(...(lefts as number[])));
  };
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
  const waitLeft = waitLeftFor(ctx);
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
    const out = waitLeft(hold?.next ?? rec);
    if (out.kind === "done" || out.kind === "superseded") return out;
    const timing = out.kind === "running" && run.status === "running" ? runTiming(run, historyFor(ctx)) : runProgress(run);
    return timing ? { ...out, timing } : out;
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
  const waitLeft = waitLeftFor(ctx);
  return { ...q, pending: q.pending.map((p) => {
    const run = ctx.scheduler.get(p.runId);
    return { ...p, next: run ? next(run) : waitLeft(jobNext(p)) };
  }) };
}

/** GET /api/watchers: a watcher with an error carries its record as `status.next`. */
export function watchersWithNext(ctx: ApiContext): (WatcherConfig & { status?: WatcherStatus & { next?: NextStep } })[] {
  const waitLeft = waitLeftFor(ctx);
  return ctx.watchers.statuses().map((w) => {
    if (!w.status) return w;
    const holds = w.status.holds?.map((h) => ({ ...h, next: waitLeft(h.next) }));
    return {
      ...w,
      status: {
        ...w.status,
        ...(holds ? { holds } : {}),
        ...(w.status.lastError ? { next: watcherError(w.github_repo, w.status.lastError) } : {}),
      },
    };
  });
}

/** Records for the server, the watchers, every tracked issue and every run. */
export function allNext(ctx: ApiContext): { server: NextStep[]; watchers: NextStep[]; issues: NextStep[]; runs: NextStep[] } {
  const list = ctx.scheduler.list(Infinity); // every record, not just the newest runs
  const next = nextFor(ctx, list);
  const waitLeft = waitLeftFor(ctx);
  const q = ctx.scheduler.queue();
  const tracked = ctx.watchers.tracked();
  const restartWhy = ctx.restart?.why;

  const server = ctx.restart ? [nextStep("restart", {}, { restartWhy })] : [];

  const watchers: NextStep[] = [];
  for (const t of tracked) {
    if (t.status.lastError) watchers.push(watcherError(t.watcher.github_repo, t.status.lastError));
    for (const h of t.status.holds ?? []) if (!h.issue) watchers.push(waitLeft(h.next));
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
      else if (queuedJob && !run) rec = waitLeft(nextStep(queuedJob.waitingFor ? "one_at_a_time" : "queued", base, { ...data, blockingRun: queuedJob.waitingFor }));
      else if (hold) rec = waitLeft(hold.next);
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
    runs.push(waitLeft(jobNext(p)));
  }

  return { server, watchers, issues: [...picked.values()].map((p) => p.rec), runs };
}

export const nextRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "next" || seg[1] || method !== "GET") return false;
  return send(res, 200, allNext(ctx)), true;
};
