import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stepLogFile } from "../engine/execute.js";
import { buildHistory, runProgress, runTiming, withWaitLeft, type DurationHistory } from "../estimate.js";
import type { RunSummary } from "../engine/state.js";
import { nextStep, releaseAtFor, runNextStep, trackingWatcher, type NextStep } from "../next-step.js";
import { labelNames, parseInterval, type Hold, type WatcherStatus } from "../queue/watcher.js";
import type { WatcherConfig } from "../config.js";
import { supersededRuns } from "../stats.js";
import { watcherState, type WatcherState } from "../words.js";
import { send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

/** Why the server waits to restart, and since when. */
export interface RestartState { why: "new_version" | "data_folder"; since: string }

/** The run waits for a code area: the last line of the claim_areas log says which run holds it. */
export function areaWait(run: RunSummary): { runId: string; areas: string } | undefined {
  // Stepped aside (stopped at wait_for_area): the claim's output names the run it waits for.
  if (run.status === "stopped" && /stopped at step "wait_for_area"/.test(run.reason ?? "")) {
    const out = [...run.history].reverse().find((h) => h.id === "claim_areas")?.output ?? "";
    const m = /^waiting for run (\S+) \((.*)\)$/m.exec(out);
    return m ? { runId: m[1]!, areas: m[2]! } : undefined;
  }
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
    // A closed issue whose run is still busy: the watcher's record says so.
    if (queued || run.status === "running" || run.status === "waiting") {
      const closed = closedHold(tracked, run.runId);
      if (closed) return closed;
    }
    // The watcher's hold for the same run and reason knows more (pull request, question count).
    const hold = tracked.flatMap((t) => t.status.holds ?? []).find((h) => h.next.runId === run.runId && h.next.kind === rec.kind);
    const out = waitLeft(hold?.next ?? rec);
    if (out.kind === "done" || out.kind === "superseded") return out;
    const timing = out.kind === "running" && run.status === "running" ? runTiming(run, historyFor(ctx)) : runProgress(run);
    return timing ? { ...out, timing } : out;
  };
}

type Queue = ReturnType<ApiContext["scheduler"]["queue"]>;
export type PendingJob = Queue["pending"][number];

/** The record of a queued job that has no run yet. */
export function jobNext(p: PendingJob): NextStep {
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
  const waitLeft = waitLeftFor(ctx);
  return { ...q, pending: q.pending.map((p) => {
    const run = ctx.scheduler.get(p.runId);
    return { ...p, next: run ? next(run) : closedHold(tracked, p.runId) ?? waitLeft(jobNext(p)) };
  }) };
}

/** A record for a user: another account's run is not named, linked or described. */
export function ownRecord(rec: NextStep, mine: (runId: string) => boolean): NextStep {
  let out = rec;
  if (out.afterRun && !mine(out.afterRun)) {
    const { afterRun: _gone, ...rest } = out;
    out = { ...rest, where: { label: "Runs page", url: "#/runs" } };
  }
  if (out.blockers) {
    // Every blocker is cut to its issue number: what it waits for in turn may be another account's run.
    const blockers = out.blockers.map((b) => ({ issue: b.issue }));
    const again = nextStep("dependency", { repo: out.repo, issue: out.issue, title: out.title, runId: out.runId }, { blockers });
    out = { ...out, blockers, why: again.why, text: again.text };
  }
  return out;
}

/**
 * Logs and step output say "waiting for run <id> (areas)" while a run waits for a code area. For a user, the id of a run
 * that is not theirs is taken out, wherever it appears (log lines, step output, reasons, transcripts).
 */
export function hideForeign<T>(value: T, mine: (runId: string) => boolean): T {
  const text = JSON.stringify(value);
  if (text === undefined || !text.includes("waiting for run ")) return value;
  return JSON.parse(text.replace(/waiting for run ([\w-]+)/g, (all, id: string) => (mine(id) ? all : "waiting for another run"))) as T;
}

/** GET /api/queue for a user: their own queued jobs, each with the number of other accounts' jobs in front of it. */
export function ownQueue(ctx: ApiContext, userId: string): { pending: (PendingJob & { next: NextStep; ahead: number })[]; active: Queue["active"]; concurrency: number } {
  const q = queueWithNext(ctx);
  const mine = (id: string) => ctx.scheduler.ownerOf(id) === userId;
  const pending: (PendingJob & { next: NextStep; ahead: number })[] = [];
  let ahead = 0;
  for (const p of q.pending) {
    if (!mine(p.runId)) {
      ahead++;
      continue;
    }
    pending.push({ ...p, waitingFor: p.waitingFor && mine(p.waitingFor) ? p.waitingFor : undefined, next: ownRecord(p.next, mine), ahead });
  }
  return { pending, active: q.active.filter((a) => mine(a.runId)), concurrency: q.concurrency };
}

/** GET /api/watchers: each watcher carries its own `state` (words for active, error, disabled); one with a problem also has its record as `status.next`. Holds are copies that may say how long the run they wait for still needs. */
export function watchersWithNext(ctx: ApiContext): (WatcherConfig & { state: WatcherState; status?: WatcherStatus & { next?: NextStep } })[] {
  const waitLeft = waitLeftFor(ctx);
  return ctx.watchers.statuses().map((w) => {
    const next = w.status ? watcherProblem(w, w.status) : undefined;
    const state = watcherState(!w.enabled ? "disabled" : next?.kind === "watcher_error" ? "error" : "active");
    if (!w.status) return { ...w, state };
    const holds = w.status.holds?.map((h) => ({ ...h, next: waitLeft(h.next) }));
    return { ...w, state, status: { ...w.status, ...(holds ? { holds } : {}), ...(next ? { next } : {}) } };
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
  const waitLeft = waitLeftFor(ctx);
  const q = ctx.scheduler.queue();
  const tracked = ctx.watchers.tracked();
  const restartWhy = ctx.restart?.why;

  const server = ctx.restart ? [nextStep("restart", {}, { restartWhy })] : [];

  const holdEntry = (t: (typeof tracked)[number], h: Hold): Entry => {
    const by = t.status.pausedBy;
    // A hold about a run is as old as the run's wait; "seen" starts again after a restart.
    const run = h.next.runId ? list.find((r) => r.runId === h.next.runId) : undefined;
    return { next: waitLeft(h.next), since: h.since ?? (run ? runSince(run) : undefined), seen: h.seen, watcher: t.watcher.id, prTitle: by && by.url === h.next.where.url ? by.title : undefined };
  };
  const watchers: Entry[] = [];
  for (const t of tracked) {
    const problem = watcherProblem(t.watcher, t.status);
    // Drained watchers are stopped on purpose while the server waits to restart.
    if (problem && !(problem.kind === "watcher_stale" && ctx.restart)) {
      watchers.push({ next: problem, since: problem.kind === "watcher_error" ? t.status.errorSince : t.status.lastOk ?? t.status.startedAt, watcher: t.watcher.id });
    }
    for (const h of t.status.holds ?? []) if (!h.issue) watchers.push(holdEntry(t, h));
  }

  const byRun = new Map(list.map((r) => [r.runId, r]));
  const live = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  const issues: (Entry & { key: string; rank: number; runId?: string })[] = [];
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
      else if (queuedJob && !run) e = { next: waitLeft(nextStep(queuedJob.waitingFor ? "one_at_a_time" : "queued", base, { ...data, blockingRun: queuedJob.waitingFor })) };
      else if (hold) e = holdEntry(t, hold);
      else if (run) e = { next: next(run), since: runSince(run) };
      else if (i.done) e = { next: nextStep("done", base, data) };
      else e = { next: nextStep(ctx.restart ? "restart" : "starting", base, { ...data, restartWhy }) };
      issues.push({ ...e, watcher: t.watcher.id, runId: i.runId, key: `${base.repo}#${i.issue}`, rank: isLive ? 0 : i.done ? 2 : 1 });
    }
  }

  const runs = () => {
    const out = list.map(next);
    for (const p of q.pending) {
      if (byRun.has(p.runId) || p.kind !== "run") continue;
      out.push(closedHold(tracked, p.runId) ?? waitLeft(jobNext(p)));
    }
    return out;
  };

  return { server, watchers, issues, runs, next };
}

/** The newest runs plus the run of every tracked issue. */
export function knownRuns(ctx: ApiContext, limit = 200): RunSummary[] {
  const list = ctx.scheduler.list(limit);
  const loaded = new Set(list.map((r) => r.runId));
  for (const t of ctx.watchers.tracked()) {
    for (const i of t.issues) {
      const run = i.runId && !loaded.has(i.runId) ? ctx.scheduler.get(i.runId) : undefined;
      if (run) list.push(run), loaded.add(run.runId);
    }
  }
  return list;
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
