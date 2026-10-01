import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { evalsDir } from "../evals.js";
import { dirname, join } from "node:path";
import type { RunSummary } from "../engine/state.js";
import { FACTORY_HOME } from "../flow/load.js";
import { releaseWatchersFor, trackingWatcher, type NextStep } from "../next-step.js";
import { buildTurn, runOrigin, soonestAt, type ReleaseTime, type TurnSource, type YourTurn } from "../your-turn.js";
import { HttpError, readJson, send, str } from "./http.js";
import { collectNext, runSince, type Entry } from "./next.js";
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
function evalRunIds(): Set<string> {
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

const keyOf =(n: NextStep) => `${n.repo}#${n.issue ?? ""}|${n.kind}|${n.runId ?? ""}`;

/** Every current item (dismissed ones too) and the page. */
export function turnFor(ctx: ApiContext, now = new Date()) {
  const cfg = ctx.config();
  const list = ctx.scheduler.list(200);
  const tracked = ctx.watchers.tracked();
  const loaded = new Set(list.map((r) => r.runId));
  for (const t of tracked) {
    for (const i of t.issues) {
      const run = i.runId && !loaded.has(i.runId) ? ctx.scheduler.get(i.runId) : undefined;
      if (run) list.push(run), loaded.add(run.runId);
    }
  }
  const c = collectNext(ctx, list);

  const fromEntry = (e: Entry): TurnSource => {
    const error = e.next.kind === "watcher_error";
    return {
      key: error ? `error|${e.watcher ?? e.next.repo}` : keyOf(e.next), next: e.next, since: e.since ?? e.seen,
      stamp: e.since ?? "", dismissable: !error, watcher: e.watcher, prTitle: e.prTitle,
    };
  };
  const sources: TurnSource[] = [...c.watchers.map(fromEntry), ...c.issues.map(fromEntry)];

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

  return buildTurn(sources, { dismissed: readStore(), building: stories.size, releaseAt: soonestAt(times, now) });
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
