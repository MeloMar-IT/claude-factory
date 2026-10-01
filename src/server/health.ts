import { spentToday, type RunSummary } from "../engine/state.js";
import { AGENTS } from "../flow/schema.js";
import { briefFailure, FAILURE_SHOWN_MS, LIMIT_SHOWN_MS, nextStep, type NextStep } from "../next-step.js";
import { supersededRuns } from "../stats.js";
import { send } from "./http.js";
import { nextFor, watcherProblem } from "./next.js";
import type { ApiContext, Route } from "./server.js";

/** What GET /api/health answers: the problems of the Foundry itself, in one sentence each. */
export interface Health {
  ok: boolean;
  /** "All good", "1 problem" or "N problems". */
  summary: string;
  problems: NextStep[];
  /** Per repository of an enabled watcher: the oldest last successful check (none when one watcher never had one). */
  repos: { repo: string; lastOk?: string }[];
}

const RUNS = { label: "Runs page", url: "#/runs" };
const MAX_FAILURES = 5;
/** "11:52", "3:50pm (Europe/Amsterdam)", "the next check": the only shapes of `until` a limit may carry. */
const RESET_TIME = /^(?:the next check|\d{1,2}(?::\d{2})?\s?(?:am|pm)?(?: \([A-Za-z_]+(?:\/[A-Za-z_+-]+)*\))?)$/i;
const ended = (r: RunSummary) => Date.parse(r.finishedAt ?? r.startedAt);

/** Only text the response may carry: a repository name (a local run has a path) and an https or in-page link. */
function safe(n: NextStep): NextStep {
  return {
    ...n,
    title: "", // issue titles come from GitHub; the issue number links to it
    repo: /^[\w.-]+\/[\w.-]+$/.test(n.repo) ? n.repo : "",
    where: /^(https:\/\/|#\/)/.test(n.where?.url ?? "") ? n.where : RUNS,
  };
}

/** The problems of the Foundry itself and the last successful check of every repository. Reads the context when called. */
export function health(ctx: ApiContext, now = new Date()): Health {
  const cfg = ctx.config();
  const q = ctx.scheduler.queue();
  const tracked = ctx.watchers.tracked();
  const runs = ctx.scheduler.list(200);
  const replaced = supersededRuns(runs);
  const t = now.getTime();
  const problems: NextStep[] = [];

  if (ctx.restart) {
    problems.push(nextStep("restart", {}, { restartWhy: ctx.restart.why, runsLeft: q.active.length + q.pending.length }));
  }

  const limits = new Map<string, RunSummary>();
  for (const r of runs) {
    if (r.status !== "stopped" || !/usage limit reached/.test(r.reason ?? "") || replaced.has(r.runId) || t - ended(r) > LIMIT_SHOWN_MS) continue;
    const agent = AGENTS.find((a) => a === r.history.at(-1)?.agent?.split(":")[0]) ?? "AI";
    const have = limits.get(agent);
    if (!have || ended(r) > ended(have)) limits.set(agent, r);
  }
  for (const [limitAgent, r] of limits) {
    const data = { limitAgent, finishedAt: r.finishedAt ?? r.startedAt, now };
    const rec = nextStep("usage_limit", {}, { ...data, reason: r.reason });
    // The reset time is quoted from the agent's message: keep it only when it looks like a time.
    problems.push(RESET_TIME.test(rec.until ?? "") ? rec : nextStep("usage_limit", {}, data));
  }

  if (cfg.cost_limits && cfg.daily_budget_usd !== undefined && spentToday(ctx.opts.runsDir, now) >= cfg.daily_budget_usd) {
    problems.push(nextStep("daily_budget"));
  }

  const seen = new Set<string>();
  for (const w of tracked) {
    const p = watcherProblem(w.watcher, w.status, t);
    if (!p || (p.kind === "watcher_stale" && ctx.restart)) continue;
    const key = `${p.kind}|${p.repo}|${p.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(p);
  }

  const busy = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  const closed = new Set<string>();
  for (const w of tracked) {
    for (const h of w.status.holds ?? []) {
      const id = h.next.runId;
      if (h.next.kind !== "closed_elsewhere" || !id || closed.has(id)) continue;
      const status = ctx.scheduler.get(id)?.status;
      if (!busy.has(id) && status !== "running" && status !== "waiting") continue;
      closed.add(id);
      problems.push(h.next);
    }
  }

  const next = nextFor(ctx, runs);
  problems.push(...runs
    .filter((r) => r.status === "failed" && !replaced.has(r.runId) && t - ended(r) <= FAILURE_SHOWN_MS)
    .map(next)
    .filter((n) => n.kind === "failed" && n.cause === "factory")
    .slice(0, MAX_FAILURES)
    .map(briefFailure));

  const lastOk = new Map<string, string | undefined>();
  for (const w of ctx.watchers.statuses()) {
    if (!w.enabled) continue;
    const ok = tracked.find((x) => x.watcher.id === w.id)?.status.lastOk ?? w.status?.lastOk;
    if (!lastOk.has(w.github_repo)) lastOk.set(w.github_repo, ok);
    else {
      const have = lastOk.get(w.github_repo);
      lastOk.set(w.github_repo, have && ok ? (ok < have ? ok : have) : undefined);
    }
  }
  const repos = [...lastOk].map(([repo, ok]) => (ok ? { repo, lastOk: ok } : { repo }));

  const list = problems.map(safe);
  return { ok: list.length === 0, summary: list.length === 0 ? "All good" : list.length === 1 ? "1 problem" : `${list.length} problems`, problems: list, repos };
}

export const healthRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "health" || seg[1] || method !== "GET") return false;
  return send(res, 200, health(ctx)), true;
};
