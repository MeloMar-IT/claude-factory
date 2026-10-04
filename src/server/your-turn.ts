import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { evalsDir } from "../evals.js";
import { dirname, join } from "node:path";
import type { RunSummary } from "../engine/state.js";
import { FACTORY_HOME } from "../flow/load.js";
import { breakerNow, breakerWhy } from "../monitor/guard.js";
import { nextStep, releaseWatchersFor, trackingWatcher, type NextStep } from "../next-step.js";
import { buildTurn, runOrigin, soonest, type ReleaseTime, type TurnSource, type YourTurn } from "../your-turn.js";
import { HttpError, readJson, send, str } from "./http.js";
import { collectNext, knownRuns, runSince, type Entry } from "./next.js";
import type { ApiContext, Route } from "./server.js";

const DAY = 86_400_000;
/** Failed and stopped runs started by hand show for this long. Waiting runs show at any age. */
const RECENT_MS = 7 * DAY;
/** A dismissal of something that is gone is kept this long (e.g. across a restart). */
const KEEP_MS = 30 * DAY;

type Store = Record<string, { since: string; at: string }>;

const storeFile = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "your-turn.json");

/** What was dismissed. A missing, broken or oddly shaped file reads as empty. */
function readStore(): Store {
  try {
    const d = (JSON.parse(readFileSync(storeFile(), "utf8")) as { dismissed?: unknown }).dismissed;
    if (!d || typeof d !== "object" || Array.isArray(d)) return {};
    for (const e of Object.values(d)) {
      const x = e as { since?: unknown; at?: unknown } | null;
      if (!x || typeof x.since !== "string" || typeof x.at !== "string") return {};
    }
    return d as Store;
  } catch {
    return {};
  }
}

function writeStore(dismissed: Store) {
  const file = storeFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ dismissed }, null, 2));
  renameSync(tmp, file);
}

/** Run ids in the eval reports. Runs of older versions have no `source`, so this is how their origin is known. */
export function evalRunIds(): Set<string> {
  const ids = new Set<string>();
  const dir = evalsDir();
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as { results?: { runId?: unknown }[] };
        for (const x of r.results ?? []) if (typeof x.runId === "string") ids.add(x.runId);
      } catch {
        // a broken report: skip it
      }
    }
  } catch {
    // no reports yet
  }
  return ids;
}

/** An item the user acted on shows as "done — continuing" for this long (the watcher normally picks it up within seconds). */
const ACTED_MS = 10 * 60_000;
const actedStore = new WeakMap<ApiContext, Map<string, { since: string; at: number }>>();

/** Remembers that the user acted on an item (at this stamp); it moves to "Done — continuing". In memory only. */
export function markActed(ctx: ApiContext, key: string, stamp: string, now = new Date()) {
  const m = actedStore.get(ctx) ?? actedStore.set(ctx, new Map()).get(ctx)!;
  m.set(key, { since: stamp, at: now.getTime() });
}

/** Was this item (at this stamp) acted on already, and not yet expired? */
export function wasActed(ctx: ApiContext, key: string, stamp: string, now = new Date()): boolean {
  return actedNow(ctx, now)[key]?.since === stamp;
}

function actedNow(ctx: ApiContext, now: Date): Record<string, { since: string }> {
  const m = actedStore.get(ctx);
  const out: Record<string, { since: string }> = {};
  for (const [k, e] of m ?? []) {
    if (now.getTime() - e.at >= ACTED_MS) m!.delete(k);
    else out[k] = { since: e.since };
  }
  return out;
}

/** The identity of an item that has no key of its own: repository, issue, kind and run. */
export const turnKey = (n: NextStep) => `${n.repo}#${n.issue ?? ""}|${n.kind}|${n.runId ?? ""}`;
const keyOf = turnKey;

/** Every current item (dismissed ones too) and the page. */
export function turnFor(ctx: ApiContext, now = new Date()) {
  const cfg = ctx.config();
  const list = knownRuns(ctx);
  const tracked = ctx.watchers.tracked();
  const c = collectNext(ctx, list);

  const fromEntry = (e: Entry): TurnSource => {
    const error = e.next.kind === "watcher_error";
    return {
      key: error ? `error|${e.watcher ?? e.next.repo}` : keyOf(e.next), next: e.next, since: e.since ?? e.seen,
      stamp: e.since ?? "", dismissable: !error, watcher: e.watcher, prTitle: e.prTitle,
    };
  };
  const sources: TurnSource[] = [...c.watchers.map(fromEntry), ...c.issues.map(fromEntry)];

  // The circuit breaker is open: one item for the admin that goes away when it is closed. The monitor is not a tracked watcher.
  const mon = ctx.watchers.statuses().find((w) => w.source === "monitor" && w.enabled);
  const open = mon ? breakerNow() : undefined;
  if (mon && open) {
    sources.push({ key: "monitor|breaker", next: nextStep("monitor_stopped", { title: "Monitor" }, { reason: breakerWhy(open) }), since: open.since, stamp: open.since, dismissable: false, watcher: mon.id });
  }

  // An issue closed on GitHub while its run is busy is no longer tracked: the watcher's hold is all there is.
  const q = ctx.scheduler.queue();
  const live = new Set([...q.active.map((a) => a.runId), ...q.pending.map((p) => p.runId)]);
  for (const t of tracked) {
    for (const h of t.status.holds ?? []) {
      const id = h.next.runId;
      if (h.next.kind !== "closed_elsewhere" || h.issue === undefined || !id || t.issues.some((i) => i.issue === h.issue)) continue;
      const run = list.find((r) => r.runId === id) ?? ctx.scheduler.get(id);
      if (!live.has(id) && run?.status !== "waiting") continue; // the run is over: nothing is left to cancel
      const since = h.since ?? (run ? runSince(run) : h.seen);
      // A queued run has no run page yet: the Runs page lists the queue, where it can be cancelled.
      const next = run ? h.next : { ...h.next, where: { label: "Runs page", url: "#/runs" } };
      sources.push({ key: keyOf(h.next), next, since, stamp: since ?? "", dismissable: true, watcher: t.watcher.id });
    }
  }

  // Runs that no tracked issue speaks for: by hand, or by a watcher that is not an issues watcher.
  const covered = new Set<string | undefined>([
    ...c.issues.map((i) => i.next.runId),
    ...tracked.flatMap((t) => [...t.issues.map((i) => i.runId), ...(t.status.holds ?? []).map((h) => h.next.runId)]),
  ]);
  const cutoff = now.getTime() - RECENT_MS;
  let evalIds: Set<string> | undefined;
  for (const b of ctx.scheduler.briefs()) {
    const recent = Date.parse(b.finishedAt ?? b.startedAt) >= cutoff;
    if (!(b.status === "waiting" || ((b.status === "failed" || b.status === "stopped") && recent))) continue;
    if (covered.has(b.runId)) continue;
    const origin = runOrigin(b.source);
    if (origin === "eval") continue;
    if (origin === "unknown" && (evalIds ??= evalRunIds()).has(b.runId)) continue; // an eval run of an older version
    const run: RunSummary | undefined = list.find((r) => r.runId === b.runId) ?? ctx.scheduler.get(b.runId);
    if (!run) continue;
    if (origin !== "hand" && trackingWatcher(cfg.watchers, run)) continue; // its watcher shows it
    const next = c.next(run);
    const since = runSince(run);
    sources.push({ key: keyOf(next), next, since, stamp: since, dismissable: true });
  }

  const stories = new Set<string>();
  const times: ReleaseTime[] = [];
  for (const i of c.issues) if (i.next.kind === "running") stories.add(i.key);
  for (const r of list) {
    if (r.status !== "running" || !r.vars?.github_repo || !r.vars.issue) continue;
    stories.add(`${r.vars.github_repo}#${r.vars.issue}`);
    for (const w of releaseWatchersFor(cfg.watchers, r)) if (w.at) times.push({ at: w.at, timezone: w.timezone });
  }

  const release = soonest(times, now);
  return { ...buildTurn(sources, { dismissed: readStore(), acted: actedNow(ctx, now), building: stories.size, releaseAt: release?.at }), building: stories.size, release };
}

export function yourTurn(ctx: ApiContext): YourTurn {
  return turnFor(ctx).data;
}

/**
 * Remembers a dismissal. Only a key of a current item is accepted. What is gone is kept for
 * 30 days (the holds live in memory, so right after a restart they are not there yet).
 */
export function dismissTurn(ctx: ApiContext, key: string, now = new Date()) {
  const { all } = turnFor(ctx, now);
  const item = all.find((i) => i.key === key);
  if (!item || !item.dismissable) throw new HttpError(404, "no such item");
  const current = new Set(all.map((i) => i.key));
  const store: Store = {};
  for (const [k, e] of Object.entries(readStore())) {
    if (current.has(k) || now.getTime() - Date.parse(e.at) <= KEEP_MS) store[k] = e;
  }
  store[key] = { since: item.stamp, at: now.toISOString() };
  writeStore(store);
}

export const yourTurnRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "your-turn") return false;
  if (!seg[1] && method === "GET") return send(res, 200, yourTurn(ctx)), true;
  if (seg[1] === "dismiss" && !seg[2] && method === "POST") {
    dismissTurn(ctx, str(await readJson(req), "key"));
    return send(res, 200, yourTurn(ctx)), true;
  }
  if (seg[1] === "restore" && !seg[2] && method === "POST") {
    await readJson(req);
    writeStore({});
    return send(res, 200, yourTurn(ctx)), true;
  }
  return false;
};
