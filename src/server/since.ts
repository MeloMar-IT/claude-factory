import type { RunSummary } from "../engine/state.js";
import { ghJson } from "../github.js";
import { buildSince, isReleaseBody, MAX_REPOS, MAX_RUNS, MERGED_LIMIT, parseSince, type MergedRead, type SinceSummary } from "../since.js";
import { runOrigin } from "../your-turn.js";
import { HttpError, send } from "./http.js";
import { nextFor } from "./next.js";
import type { ApiContext, Route } from "./server.js";
import { evalRunIds, turnFor } from "./your-turn.js";

/** A call to gh that takes longer than this is killed. */
export const GH_TIMEOUT_MS = 8000;
/** A good answer is reused for this long. */
const REUSE_MS = 15_000;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const cache = new Map<string, { at: number; read: Promise<MergedRead> }>();

const failed = (repo: string): MergedRead => ({ repo, ok: false, full: false, prs: [] });

async function readMerged(repo: string, timeoutMs: number): Promise<MergedRead> {
  const raw = await ghJson<{ number?: unknown; title?: unknown; url?: unknown; mergedAt?: unknown; baseRefName?: unknown; body?: unknown }[]>(
    ["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(MERGED_LIMIT), "--json", "number,title,url,mergedAt,baseRefName,body"],
    undefined, timeoutMs);
  const prs: MergedRead["prs"] = [];
  for (const p of raw) {
    if (typeof p.number !== "number" || typeof p.title !== "string" || typeof p.url !== "string"
      || typeof p.mergedAt !== "string" || typeof p.baseRefName !== "string") continue;
    if (!isReleaseBody(typeof p.body === "string" ? p.body : "")) continue;
    prs.push({ number: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt, baseRefName: p.baseRefName });
  }
  const times = raw.map((p) => (typeof p.mergedAt === "string" ? Date.parse(p.mergedAt) : NaN)).filter((t) => !Number.isNaN(t));
  const oldest = times.length ? new Date(Math.min(...times)).toISOString() : undefined;
  return { repo, ok: true, full: raw.length >= MERGED_LIMIT, oldest, prs };
}

/** Merged release pull requests of a repo. A good answer is reused for 15 s; never rejects. */
export function mergedPrs(repo: string, timeoutMs = GH_TIMEOUT_MS, now = Date.now()): Promise<MergedRead> {
  const have = cache.get(repo);
  if (have && now - have.at < REUSE_MS) return have.read;
  const read = readMerged(repo, timeoutMs).catch(() => {
    if (cache.get(repo)?.read === read) cache.delete(repo); // a failure is not kept: the next request tries again
    return failed(repo);
  });
  cache.set(repo, { at: now, read });
  return read;
}

export async function sinceFor(
  ctx: ApiContext, since: Date, now = new Date(),
  o: { prs?: (repo: string) => Promise<MergedRead>; maxRuns?: number } = {},
): Promise<SinceSummary> {
  const { data, all } = turnFor(ctx, now);
  const shown = new Set(data.groups.flatMap((g) => g.items.map((i) => i.key)));
  const waiting = all.filter((i) => shown.has(i.key));

  const from = since.getTime();
  const to = now.getTime();
  let evalIds: Set<string> | undefined;
  const finished = ctx.scheduler.briefs()
    .filter((b) => {
      if (b.status !== "succeeded" && b.status !== "failed") return false;
      const t = b.finishedAt ? Date.parse(b.finishedAt) : NaN;
      if (!(t > from && t <= to)) return false;
      const origin = runOrigin(b.source);
      if (origin === "eval") return false;
      return !(origin === "unknown" && (evalIds ??= evalRunIds()).has(b.runId));
    })
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!));
  const max = o.maxRuns ?? MAX_RUNS;
  const runsCut = finished.length > max;
  const loaded = finished.slice(0, max).flatMap((b) => ctx.scheduler.get(b.runId) ?? []);

  // The newest runs plus the window, so a failed run is checked for a replacement against all of it.
  const listed = ctx.scheduler.list(200);
  const known = new Set(listed.map((r) => r.runId));
  const next = nextFor(ctx, [...listed, ...loaded.filter((r) => !known.has(r.runId))]);
  const runs = loaded.map((run) => ({ run, next: next(run) }));

  const repos: string[] = [];
  let reposCut = false;
  const add = (r: string | undefined) => {
    if (!r || !REPO.test(r) || repos.includes(r)) return;
    if (repos.length < MAX_REPOS) repos.push(r);
    else reposCut = true;
  };
  for (const w of ctx.config().watchers) add(w.github_repo);
  for (const r of loaded as RunSummary[]) add(r.vars?.github_repo);
  // Also the newest runs of any age (a manual run or a removed watcher), so a later release is found.
  for (const r of listed) {
    const origin = runOrigin(r.source);
    if (origin === "eval" || (origin === "unknown" && (evalIds ??= evalRunIds()).has(r.runId))) continue;
    add(r.vars?.github_repo);
  }

  const read = o.prs ?? mergedPrs;
  const merged = await Promise.all(repos.map((r) => read(r).catch(() => failed(r))));
  return buildSince({ since, now, runs, merged, waiting, runsCut, reposCut });
}

export const sinceRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "since" || seg[1] || method !== "GET") return false;
  const since = parseSince(new URL(req.url ?? "/", "http://x").searchParams.get("since"));
  if (!since) throw new HttpError(400, '"since" must be a time');
  return send(res, 200, await sinceFor(ctx, since)), true;
};
