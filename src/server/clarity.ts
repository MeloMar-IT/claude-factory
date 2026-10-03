import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { missing, newerClarity, parseClarity, sampleState, summarize, emptyClarity, type Candidate, type ClarityState, type ClaritySummary, type SampleItem } from "../clarity.js";
import { FACTORY_HOME } from "../flow/load.js";
import { trackingWatcher } from "../next-step.js";
import { runOrigin } from "../your-turn.js";
import { boardFor } from "./board.js";
import { send } from "./http.js";
import { knownRuns, nextFor, watcherProblem } from "./next.js";
import type { ApiContext, Route } from "./server.js";
import { evalRunIds, turnFor, turnKey } from "./your-turn.js";

const DAY = 86_400_000;
/** A failed run started by hand is a candidate for this long (Your turn shows it longer; the edge is not a miss). */
const CANDIDATE_RECENT_MS = DAY;

const file = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "clarity.json");

/** The saved state, or undefined when the file is from a newer version (then it is left alone). A missing or broken file reads as empty. */
function readState(): ClarityState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return emptyClarity();
  }
  return newerClarity(raw) ? undefined : parseClarity(raw);
}

function writeState(s: ClarityState) {
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, f);
}

/** Everything that needs the user, as the Board, the watchers and the runs know it: Your turn must list each of them. */
export function candidatesFor(ctx: ApiContext, now = new Date()): Candidate[] {
  const cfg = ctx.config();
  const out: Candidate[] = [];

  for (const repo of boardFor(ctx, now).repos) {
    for (const col of repo.columns) for (const card of col.cards) out.push({ next: card.next, watcher: card.watcher });
  }

  const tracked = ctx.watchers.tracked();
  for (const t of tracked) {
    const problem = watcherProblem(t.watcher, t.status, now.getTime());
    if (problem && !(problem.kind === "watcher_stale" && ctx.restart)) {
      out.push({ next: problem, key: problem.kind === "watcher_error" ? `error|${t.watcher.id}` : turnKey(problem), watcher: t.watcher.id });
    }
    for (const h of t.status.holds ?? []) if (!h.issue) out.push({ next: h.next, watcher: t.watcher.id });
  }

  // An issue closed on GitHub while its run is busy (also a queued run): no Board card is actionable for it.
  const q = ctx.scheduler.queue();
  const busy = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  for (const t of tracked) {
    for (const h of t.status.holds ?? []) {
      const id = h.next.runId;
      if (h.next.kind !== "closed_elsewhere" || !id) continue;
      if (busy.has(id) || ctx.scheduler.get(id)?.status === "waiting") out.push({ next: h.next, watcher: t.watcher.id });
    }
  }

  const list = knownRuns(ctx);
  const next = nextFor(ctx, list);
  let evalIds: Set<string> | undefined;
  for (const b of ctx.scheduler.briefs()) {
    const recent = now.getTime() - Date.parse(b.finishedAt ?? b.startedAt) <= CANDIDATE_RECENT_MS;
    if (!(b.status === "waiting" || ((b.status === "failed" || b.status === "stopped") && recent))) continue;
    const origin = runOrigin(b.source);
    if (origin === "eval") continue;
    if (origin === "unknown" && (evalIds ??= evalRunIds()).has(b.runId)) continue;
    const run = list.find((r) => r.runId === b.runId) ?? ctx.scheduler.get(b.runId);
    if (!run) continue;
    // A run its watcher shows: the watcher's list is only known after a good check.
    const w = origin === "hand" ? undefined : trackingWatcher(cfg.watchers, run);
    if (w && !tracked.find((t) => t.watcher.id === w.id)?.status.lastOk) continue;
    out.push({ next: next(run), watcher: w?.id });
  }
  return out;
}

/** Takes one sample and saves it. Returns the new state; undefined when the file is from a newer version (not touched). */
export function sampleClarity(ctx: ApiContext, now = new Date(), turn: Pick<ReturnType<typeof turnFor>, "all" | "data"> = turnFor(ctx, now)): ClarityState | undefined {
  const prev = readState();
  if (!prev) return undefined;
  const acted = new Set((turn.data.continuing ?? []).map((i) => i.key));
  const shown = new Set(turn.data.groups.flatMap((g) => g.items.map((i) => i.key)));
  const items: SampleItem[] = turn.all.map((i) => ({
    key: i.key, repo: i.repo, issue: i.next.issue, kind: i.next.kind, since: i.since, stamp: i.stamp, watcher: i.watcher,
    acted: acted.has(i.key), dismissed: !acted.has(i.key) && !shown.has(i.key),
  }));
  const unsettled = new Set(ctx.watchers.tracked().filter((t) => !t.status.lastOk).map((t) => t.watcher.id));
  const state = sampleState(prev, { items, missing: missing(candidatesFor(ctx, now), turn.all), unsettled }, now);
  writeState(state);
  return state;
}

export interface ClarityAnswer extends ClaritySummary {
  /** Items on Your turn now, and since when the oldest waits. */
  waitingNow: number;
  oldestSince?: string;
  /** False until the first sample. */
  sampled: boolean;
}

/** GET /api/clarity. */
export function clarityFor(ctx: ApiContext, now = new Date()): ClarityAnswer {
  const state = readState() ?? emptyClarity();
  const turn = turnFor(ctx, now).data;
  const since = turn.groups.flatMap((g) => g.items.map((i) => i.since)).filter((s): s is string => !!s && !Number.isNaN(Date.parse(s))).sort();
  return { ...summarize(state, now), waitingNow: turn.count, ...(since[0] ? { oldestSince: since[0] } : {}), sampled: !!state.updatedAt };
}

export const clarityRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "clarity" || seg[1] || method !== "GET") return false;
  return send(res, 200, clarityFor(ctx)), true;
};

/** Takes a sample every minute while the server runs. */
export class ClarityRecorder {
  private timer?: NodeJS.Timeout;
  private warned = false;

  constructor(private ctx: ApiContext, private deps: { log?: (m: string) => void } = {}) {}

  start(everyMs = 60_000) {
    if (everyMs <= 0 || this.timer) return;
    this.timer = setInterval(() => this.check(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  check(now = new Date()) {
    try {
      if (sampleClarity(this.ctx, now) === undefined && !this.warned) {
        this.warned = true;
        this.deps.log?.("clarity.json is from a newer version — left as it is");
      }
    } catch (e) {
      this.deps.log?.(`! clarity sample failed: ${(e as Error).message}`);
    }
  }
}
