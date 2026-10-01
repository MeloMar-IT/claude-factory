import type { RunSummary } from "./engine/state.js";
import type { NextStep } from "./next-step.js";
import type { TurnItem } from "./your-turn.js";

/** What "Since you last looked" says. Pure: the server passes in the runs, pull requests and Your turn items. */

/** Pull requests read per repository, and finished runs read per request. */
export const MERGED_LIMIT = 200;
export const MAX_RUNS = 2000;
/** Entries shown per group; the rest is only counted. */
export const SHOWN = 5;
/** Repositories asked for release pull requests per request. */
export const MAX_REPOS = 20;

export type SinceGroupId = "done" | "develop" | "released" | "failed" | "waiting";

export interface SinceEntry {
  repo: string;
  issue?: number;
  title: string;
  where: { label: string; url: string };
  /** When it happened (ISO). */
  at: string;
}

export interface SinceGroup {
  id: SinceGroupId;
  label: string;
  /** All entries; `items` has only the newest few. */
  count: number;
  items: SinceEntry[];
}

export interface SinceSummary {
  since: string;
  now: string;
  total: number;
  /** False when something could not be read, so the summary may be missing entries. */
  complete: boolean;
  notes: string[];
  groups: SinceGroup[];
}

/** Merged release pull requests of one repository, as read from GitHub. */
export interface MergedRead {
  repo: string;
  ok: boolean;
  /** The limit was reached: older pull requests may exist. */
  full: boolean;
  /** When the oldest pull request read (of any kind) was merged. */
  oldest?: string;
  prs: { number: number; title: string; url: string; mergedAt: string; baseRefName: string }[];
}

/** The time the user last looked. Undefined for no valid time; a time in the future is now. */
export function parseSince(s: string | null | undefined, now = new Date()): Date | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return new Date(Math.min(t, now.getTime()));
}

/** Is this a pull request body of a release (the rolling or the daily one)? The plain marker is an ordinary pull request. */
export function isReleaseBody(body: string): boolean {
  return /<!--\s*(?:claude-factory|spaghetti-code-foundry)\s+run=\S*\s+(?:release|daily)\s*-->/.test(body);
}

const stepOk = (run: RunSummary, id: string) => (run.history ?? []).some((h) => h.ok && (h.id.split("/").pop() ?? h.id) === id);
const issueOf = (run: RunSummary): number | undefined => (/^\d+$/.test(run.vars?.issue ?? "") ? Number(run.vars.issue) : undefined);

/**
 * How far a story got: "develop" when its run pushed to develop (even if a later step failed),
 * "done" when it succeeded with a commit. Undefined for anything else, or a run without a story.
 */
export function storyOutcome(run: RunSummary): "develop" | "done" | undefined {
  if (!run.vars?.github_repo || issueOf(run) === undefined) return undefined;
  if (stepOk(run, "push_develop")) return "develop";
  if (run.status === "succeeded" && stepOk(run, "commit")) return "done";
  return undefined;
}

/** The title of the issue, from the output of the `pull_ticket` step ("# #7: Add x"). */
export function storyTitle(run: RunSummary): string {
  const step = (run.history ?? []).find((h) => h.id === "pull_ticket");
  return /^# #\d+: (.+)/.exec(step?.output ?? "")?.[1]?.trim() ?? "";
}

export interface SinceInput {
  since: Date;
  now: Date;
  /** Finished runs with their records. */
  runs: { run: RunSummary; next: NextStep }[];
  merged: MergedRead[];
  /** The items of Your turn that are shown (not dismissed). */
  waiting: (TurnItem & { stamp: string })[];
  runsCut?: boolean;
  /** More repositories were known than are asked. */
  reposCut?: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stories = (n: number) => plural(n, "story", "stories");

export function buildSince(o: SinceInput): SinceSummary {
  const from = o.since.getTime();
  const to = o.now.getTime();
  const inWindow = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return !Number.isNaN(t) && t > from && t <= to;
  };
  const newest = (a: SinceEntry, b: SinceEntry) => Date.parse(b.at) - Date.parse(a.at);

  const finished = o.runs
    .filter(({ run }) => (run.status === "succeeded" || run.status === "failed") && inWindow(run.finishedAt))
    .sort((a, b) => Date.parse(b.run.finishedAt!) - Date.parse(a.run.finishedAt!));

  const entryOf = (run: RunSummary, title: string, where: SinceEntry["where"]): SinceEntry => ({
    repo: run.vars?.github_repo ?? "", issue: issueOf(run), title, where, at: run.finishedAt!,
  });
  const runWhere = (run: RunSummary) => ({ label: "Run", url: `#/runs/${run.runId}` });

  // One entry per story, from its newest run. Newest first, so the first one seen wins.
  const done: SinceEntry[] = [];
  const develop: SinceEntry[] = [];
  const failed: SinceEntry[] = [];
  const seenStory = new Set<string>();
  const seenFailed = new Set<string>();
  const failedRuns = new Set<string>();
  for (const { run, next } of finished) {
    const issue = issueOf(run);
    const story = issue === undefined ? "" : `${run.vars.github_repo}#${issue}`;
    const outcome = storyOutcome(run);
    if (outcome && !seenStory.has(story)) {
      seenStory.add(story);
      const e = entryOf(run, storyTitle(run) || next.title || run.flow, runWhere(run));
      (outcome === "develop" ? develop : done).push(e);
    }
    if (run.status === "failed" && next.kind !== "superseded" && next.kind !== "interrupted") {
      const key = story || run.runId;
      failedRuns.add(run.runId);
      if (seenFailed.has(key)) continue;
      seenFailed.add(key);
      failed.push(entryOf(run, next.title || storyTitle(run) || run.flow, next.where?.url ? next.where : runWhere(run)));
    }
  }

  const released: SinceEntry[] = [];
  const bases = new Map<string, number>();
  const seenUrl = new Set<string>();
  for (const m of o.merged) {
    for (const p of m.prs) {
      if (!inWindow(p.mergedAt) || seenUrl.has(p.url)) continue;
      seenUrl.add(p.url);
      bases.set(p.baseRefName, (bases.get(p.baseRefName) ?? 0) + 1);
      released.push({ repo: m.repo, title: p.title, where: { label: `Pull request #${p.number}`, url: p.url }, at: p.mergedAt });
    }
  }
  released.sort(newest);

  const waiting: SinceEntry[] = o.waiting
    .filter((i) => inWindow(i.stamp) && !(i.next.runId && failedRuns.has(i.next.runId)))
    .map((i) => ({ repo: i.repo, issue: i.next.issue, title: i.what, where: i.next.where, at: i.stamp }))
    .sort(newest);

  const releaseLabel = [...bases].map(([base, n]) => `${plural(n, "release", "releases")} to ${base}`).join(", ");
  const defs: [SinceGroupId, string, SinceEntry[]][] = [
    ["done", `${stories(done.length)} done`, done],
    ["develop", `${stories(develop.length)} merged into develop`, develop],
    ["released", releaseLabel, released],
    ["failed", `${failed.length} failed`, failed],
    ["waiting", `${waiting.length} newly waiting for you`, waiting],
  ];
  const groups: SinceGroup[] = defs
    .filter(([, , list]) => list.length > 0)
    .map(([id, label, list]) => ({ id, label, count: list.length, items: list.sort(newest).slice(0, SHOWN) }));

  const notes: string[] = [];
  const bad = o.merged.filter((m) => !m.ok).map((m) => m.repo);
  if (bad.length) notes.push(`Releases of ${bad.join(", ")} could not be read from GitHub right now.`);
  // A full read matters only when its oldest pull request is still inside the window: older ones may be missing.
  const full = o.merged.filter((m) => m.ok && m.full && !(m.oldest && Date.parse(m.oldest) <= from)).map((m) => m.repo);
  if (full.length) notes.push(`Only the newest ${MERGED_LIMIT} merged pull requests of ${full.join(", ")} were checked.`);
  if (o.runsCut) notes.push(`Only the newest ${MAX_RUNS} finished runs were checked.`);
  if (o.reposCut) notes.push(`Only the first ${MAX_REPOS} repositories were checked for releases.`);

  return {
    since: o.since.toISOString(), now: o.now.toISOString(),
    total: groups.reduce((n, g) => n + g.count, 0),
    complete: notes.length === 0, notes, groups,
  };
}
