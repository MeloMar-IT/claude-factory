import type { NextStep } from "./next-step.js";

/** What the "Your turn" page lists. Pure: the server passes in what it knows. */

/** One thing that may wait for the user. */
export interface TurnSource {
  /** Stable identity, used by Dismiss. */
  key: string;
  next: NextStep;
  /** Since when it waits (a real time, or the time this server first saw it). */
  since?: string;
  /** What Dismiss remembers: the real time, or "" when there is none (then only the key counts). */
  stamp: string;
  dismissable: boolean;
  /** The watcher that knows about it. */
  watcher?: string;
  /** Title of the pull request, for a release. */
  prTitle?: string;
}

export interface TurnItem {
  key: string;
  repo: string;
  what: string;
  next: NextStep;
  since?: string;
  /** How many stories wait for this one. */
  unblocks: number;
  dismissable: boolean;
  watcher?: string;
}

export interface YourTurn {
  count: number;
  groups: { repo: string; items: TurnItem[] }[];
  /** How many items are hidden by Dismiss. */
  dismissed: number;
  /** Set only when count is 0. */
  empty?: string;
}

export interface TurnOptions {
  /** Dismissed keys → the stamp they were dismissed at. */
  dismissed?: Record<string, { since: string }>;
  /** Stories being built right now. */
  building?: number;
  /** "HH:MM" of the next release that the running work feeds. */
  releaseAt?: string;
}

/** Does the user have to do something? Never for work that runs, queues or waits for another story. */
export function needsUser(next: NextStep): boolean {
  if (next.kind === "cancelled") return false;
  return next.who === "You" || next.who === "Something is wrong";
}

export type RunOrigin = "hand" | "watcher" | "eval" | "unknown";

/** Who started a run, from `RunSummary.source`. */
export function runOrigin(source: string | undefined): RunOrigin {
  if (source === "ui" || source === "cli" || source?.startsWith("ui ")) return "hand";
  if (source?.startsWith("watcher ")) return "watcher";
  if (source?.startsWith("eval")) return "eval";
  return "unknown";
}

/** The text when nothing waits: what is being built and when the next thing for the user is expected. */
export function emptyText(building: number, releaseAt?: string): string {
  if (building <= 0) return "Nothing needs you.";
  const built = `${building === 1 ? "1 story is" : `${building} stories are`} being built`;
  if (!releaseAt) return `Nothing needs you. ${built}.`;
  return `Nothing needs you. ${built}; the next thing for you is expected around ${releaseAt} (release pull request).`;
}

const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
};

/** The earliest valid time of a list, as the original text. */
function earliest(list: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const s of list) if (!Number.isNaN(time(s)) && (best === undefined || time(s) < time(best))) best = s;
  return best;
}

/** The stories that wait, directly or through other stories, for these issues to be done (the issues themselves count when `own`). */
function unblocksOf(repo: string, roots: number[], deps: TurnSource[], own = false): number {
  const dependents = new Map<number, Set<number>>();
  for (const d of deps) {
    const n = d.next.issue;
    if (d.next.repo !== repo || n === undefined) continue;
    for (const b of d.next.blockers ?? []) (dependents.get(b.issue) ?? dependents.set(b.issue, new Set()).get(b.issue)!).add(n);
  }
  const seen = new Set<number>();
  const todo = [...roots];
  while (todo.length) {
    for (const n of dependents.get(todo.pop()!) ?? []) {
      if (roots.includes(n) || seen.has(n)) continue;
      seen.add(n);
      todo.push(n);
    }
  }
  return seen.size + (own ? roots.length : 0);
}

/** Sort: more unblocked first, then older first, no time last. */
function byImportance(a: TurnItem, b: TurnItem): number {
  if (a.unblocks !== b.unblocks) return b.unblocks - a.unblocks;
  const ta = time(a.since), tb = time(b.since);
  if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
  return Number.isNaN(ta) ? 0 : ta - tb;
}

/** Every current item (also dismissed ones, with their stamp) and the page the user sees. */
export function buildTurn(sources: TurnSource[], o: TurnOptions = {}): { data: YourTurn; all: (TurnItem & { stamp: string })[] } {
  // The same key from two places is one thing.
  const byKey = new Map<string, TurnSource>();
  for (const s of sources) {
    const have = byKey.get(s.key);
    if (!have || (!needsUser(have.next) && needsUser(s.next))) byKey.set(s.key, s);
  }
  const unique = [...byKey.values()];
  const deps = unique.filter((s) => s.next.kind === "dependency");
  const waiting = unique.filter((s) => needsUser(s.next));

  const all: (TurnItem & { stamp: string })[] = [];
  const releases = new Map<string, TurnSource[]>();
  for (const s of waiting) {
    if (s.next.kind === "release" && s.next.where.url) {
      const list = releases.get(s.next.where.url) ?? [];
      list.push(s);
      releases.set(s.next.where.url, list);
      continue;
    }
    all.push({
      key: s.key, repo: s.next.repo, what: s.next.title || s.next.where.label, next: s.next, since: s.since,
      unblocks: s.next.issue === undefined ? 0 : unblocksOf(s.next.repo, [s.next.issue], deps),
      dismissable: s.dismissable, watcher: s.watcher, stamp: s.stamp,
    });
  }
  for (const [url, list] of releases) {
    const first = list.find((s) => s.next.issue === undefined) ?? list[0]!;
    const what = list.find((s) => s.prTitle)?.prTitle ?? first.next.where.label;
    all.push({
      key: `release|${url}`, repo: first.next.repo, what,
      next: { ...first.next, issue: undefined, title: what, runId: undefined },
      since: earliest(list.map((s) => s.since)),
      unblocks: unblocksOf(first.next.repo, [...new Set(list.flatMap((s) => (s.next.issue === undefined ? [] : [s.next.issue])))], deps, true),
      dismissable: list.every((s) => s.dismissable), watcher: first.watcher ?? list.find((s) => s.watcher)?.watcher,
      stamp: earliest(list.map((s) => s.stamp)) ?? "",
    });
  }

  const dismissed = o.dismissed ?? {};
  const hidden = (i: TurnItem & { stamp: string }) => i.dismissable && dismissed[i.key] !== undefined && dismissed[i.key]!.since === i.stamp;
  const shown = all.filter((i) => !hidden(i)).sort(byImportance);

  const groups: YourTurn["groups"] = [];
  for (const item of shown) {
    const repo = item.repo || "Other";
    let g = groups.find((x) => x.repo === repo);
    if (!g) groups.push((g = { repo, items: [] }));
    g.items.push(publicItem(item));
  }
  const data: YourTurn = { count: shown.length, groups, dismissed: all.length - shown.length };
  if (!shown.length) data.empty = emptyText(o.building ?? 0, o.releaseAt);
  return { data, all };
}

function publicItem(i: TurnItem & { stamp: string }): TurnItem {
  const { stamp: _stamp, ...item } = i;
  return item;
}

/** A schedule watcher's daily time ("HH:MM") in its own time zone (default: this machine's). */
export interface ReleaseTime { at: string; timezone?: string }

/** Minutes from `now` until the next time the watcher's clock shows `at`. */
function minutesUntil(t: ReleaseTime, now: Date): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.at);
  if (!m) return undefined;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: t.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const here = Number(parts.hour) * 60 + Number(parts.minute);
  return (Number(m[1]) * 60 + Number(m[2]) - here + 1440) % 1440;
}

/** The release that comes first after `now`, judged in each watcher's time zone, with the minutes to wait (wraps at 24 h); undefined for none. */
export function soonest(times: ReleaseTime[], now = new Date()): { at: string; inMinutes: number } | undefined {
  let best: { at: string; inMinutes: number } | undefined;
  for (const t of times) {
    const wait = minutesUntil(t, now);
    if (wait !== undefined && (!best || wait < best.inMinutes)) best = { at: t.at, inMinutes: wait };
  }
  return best;
}

/** The "HH:MM" of the release that comes first after `now`; undefined for none. */
export function soonestAt(times: ReleaseTime[], now = new Date()): string | undefined {
  return soonest(times, now)?.at;
}
