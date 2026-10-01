import { buildBoard, ticketTitle, type Board, type BoardSource, DONE_WEEK_MS } from "../board.js";
import type { RunSummary } from "../engine/state.js";
import { trackingWatcher } from "../next-step.js";
import { runOrigin } from "../your-turn.js";
import { send } from "./http.js";
import { collectNext, jobNext, knownRuns, runSince } from "./next.js";
import type { ApiContext, Route } from "./server.js";
import { evalRunIds } from "./your-turn.js";

/** The story a run is about: a repository and an issue number. `owner/repo` is the placeholder of the forms, not a repository. */
function storyOf(run: RunSummary): { repo: string; issue: number } | undefined {
  const repo = run.vars?.github_repo;
  const issue = run.vars?.issue;
  if (!repo || repo === "owner/repo" || !issue || !/^\d+$/.test(issue)) return undefined;
  return { repo, issue: Number(issue) };
}

/** Every story the server knows, in columns. */
export function boardFor(ctx: ApiContext, now = new Date()): Board {
  const cfg = ctx.config();
  const list = knownRuns(ctx);
  const c = collectNext(ctx, list);
  const q = ctx.scheduler.queue();
  const byRun = new Map(list.map((r) => [r.runId, r]));

  const sources: BoardSource[] = [];
  const covered = new Map<string, number>(); // story → index of its source
  for (const i of c.issues) {
    covered.set(i.key, sources.length);
    const id = i.next.runId;
    sources.push({
      next: i.next, run: id ? byRun.get(id) ?? ctx.scheduler.get(id) : undefined,
      runId: i.runId, since: i.since, rank: i.rank, watcher: i.watcher,
    });
  }

  // A live run newer than what the watcher last saw takes the story over (its snapshot is stale until its next check).
  const takesOver = (key: string, runId: string) => {
    const at = covered.get(key);
    const have = at === undefined ? undefined : sources[at];
    return !!have && have.rank !== 0 && have.next.runId !== runId && have.runId !== runId;
  };

  // Runs that no tracked issue speaks for: the newest per story, a live one first.
  const liveIds = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  const chosen = new Map<string, { run: RunSummary; live: boolean }>();
  let evalIds: Set<string> | undefined;
  for (const b of ctx.scheduler.briefs()) {
    const live = liveIds.has(b.runId) || b.status === "running";
    // Only Done expires. An old succeeded run that is loaded can still wait for the scheduled release, so it is classified first.
    const old = !live && b.status !== "waiting" && !(now.getTime() - Date.parse(b.finishedAt ?? b.startedAt) <= DONE_WEEK_MS);
    if (old && !(b.status === "succeeded" && byRun.has(b.runId))) continue;
    const origin = runOrigin(b.source);
    if (origin === "eval") continue;
    const run = byRun.get(b.runId) ?? ctx.scheduler.get(b.runId);
    const story = run && storyOf(run);
    if (!run || !story) continue;
    const key = `${story.repo}#${story.issue}`;
    if (covered.has(key) && !(live && takesOver(key, run.runId))) continue;
    const have = chosen.get(key);
    if (have && (have.live || !live)) continue;
    if (origin === "unknown" && (evalIds ??= evalRunIds()).has(b.runId)) continue; // an eval run of an older version
    if (origin !== "hand" && !live && trackingWatcher(cfg.watchers, run) && run.status !== "succeeded") continue; // its watcher shows it
    chosen.set(key, { run, live });
  }
  for (const [key, { run }] of chosen) {
    const next = c.next(run);
    const at = covered.get(key);
    if (at !== undefined) {
      const old = sources[at]!;
      sources[at] = { next: { ...next, title: old.next.title || ticketTitle(run) || next.title }, run, runId: run.runId, since: runSince(run), rank: 0, watcher: old.watcher };
      continue;
    }
    covered.set(key, sources.length);
    sources.push({ next: { ...next, title: ticketTitle(run) || next.title }, run, since: runSince(run), rank: 3 });
  }

  // Queued jobs that have no run file yet.
  for (const p of q.pending) {
    const n = p.issue && /^\d+$/.test(p.issue) ? Number(p.issue) : undefined;
    if (p.kind !== "run" || !p.githubRepo || p.githubRepo === "owner/repo" || n === undefined) continue;
    const key = `${p.githubRepo}#${n}`;
    if (ctx.scheduler.get(p.runId)) continue;
    const at = covered.get(key);
    if (at === undefined) { covered.set(key, sources.length); sources.push({ next: jobNext(p), rank: 3 }); continue; }
    if (takesOver(key, p.runId)) {
      const next = jobNext(p);
      sources[at] = { next: { ...next, title: sources[at]!.next.title || next.title }, rank: 0, watcher: sources[at]!.watcher };
    }
  }

  const repos = cfg.watchers.filter((w) => w.enabled && w.source === "issues").map((w) => w.github_repo);
  return buildBoard(sources, { now, repos });
}

export const boardRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "board" || seg[1] || method !== "GET") return false;
  return send(res, 200, boardFor(ctx)), true;
};
