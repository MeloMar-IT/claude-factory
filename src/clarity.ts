import type { NextStep } from "./next-step.js";
import { needsUser } from "./your-turn.js";

/**
 * The clarity measure: how long items wait for the user, and how often something waited for the user
 * without being on Your turn. Pure: the server passes in what it sees every minute.
 */

export const CLARITY_VERSION = 1;
const DAY = 86_400_000;
/** Waits are kept this long after they ended. */
const KEEP_MS = 90 * DAY;
const MAX_WAITS = 500;
const MAX_MISSES = 50;
const WINDOW_MS = 30 * DAY;

/** One time an item waited for the user. `until` is missing while it still waits. */
export interface Wait {
  key: string;
  repo: string;
  issue?: number;
  kind: string;
  since: string;
  until?: string;
  /** Milliseconds from `since` to `until`. */
  ms?: number;
  /** What Your turn showed when the wait began; a new stamp is a new wait. */
  stamp: string;
  /** The watcher that knows the item (an unsettled watcher cannot say it is gone). */
  watcher?: string;
  /** The user acted: the item moved to "Done — continuing" at this time. */
  actedAt?: string;
  /** The user set the item aside with Dismiss. */
  dismissed?: boolean;
}

/** Something that waited for the user and was not on Your turn (two samples in a row). */
export interface Miss {
  id: string;
  status: string;
  since: string;
  lastSeen: string;
  /** Your turn listed it again, or it stopped waiting. */
  until?: string;
}

export interface ClarityState {
  version: number;
  updatedAt?: string;
  waits: Wait[];
  missed: number;
  misses: Miss[];
  /** Missing at the last sample, not yet counted. */
  suspects: Record<string, { status: string; since: string }>;
}

export const emptyClarity = (): ClarityState => ({ version: CLARITY_VERSION, waits: [], missed: 0, misses: [], suspects: {} });

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A file written by a newer version: it is left alone. */
export function newerClarity(raw: unknown): boolean {
  return isObj(raw) && typeof raw.version === "number" && raw.version > CLARITY_VERSION;
}

/** What a file holds; anything missing, broken or oddly shaped reads as empty. */
export function parseClarity(raw: unknown): ClarityState {
  if (!isObj(raw) || !Array.isArray(raw.waits) || !Array.isArray(raw.misses) || !isObj(raw.suspects) || typeof raw.missed !== "number") return emptyClarity();
  const waitOk = (w: unknown) => isObj(w) && isStr(w.key) && isStr(w.repo) && isStr(w.kind) && isStr(w.since) && isStr(w.stamp)
    && (w.until === undefined || isStr(w.until)) && (w.ms === undefined || typeof w.ms === "number")
    && (w.issue === undefined || typeof w.issue === "number") && (w.actedAt === undefined || isStr(w.actedAt))
    && (w.watcher === undefined || isStr(w.watcher)) && (w.dismissed === undefined || typeof w.dismissed === "boolean");
  const missOk = (m: unknown) => isObj(m) && isStr(m.id) && isStr(m.status) && isStr(m.since) && isStr(m.lastSeen) && (m.until === undefined || isStr(m.until));
  const suspectOk = (s: unknown) => isObj(s) && isStr(s.status) && isStr(s.since);
  if (!raw.waits.every(waitOk) || !raw.misses.every(missOk) || !Object.values(raw.suspects).every(suspectOk)) return emptyClarity();
  return {
    version: CLARITY_VERSION,
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : undefined,
    waits: raw.waits as Wait[],
    missed: raw.missed,
    misses: raw.misses as Miss[],
    suspects: raw.suspects as ClarityState["suspects"],
  };
}

/** An item as Your turn knows it (shown, dismissed or done-continuing). */
export interface SampleItem {
  key: string;
  repo: string;
  issue?: number;
  kind: string;
  since?: string;
  stamp: string;
  watcher?: string;
  dismissed: boolean;
  acted: boolean;
}

/** A record that needs the user, found outside Your turn (Board, watchers, runs). */
export interface Candidate {
  next: NextStep;
  /** The Your turn key, when the record has one of its own (a watcher error). */
  key?: string;
  watcher?: string;
}

export interface Missing { id: string; status: string }

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** A name for a candidate that is unique and carries no path: "acme/app#7", or the repository and the run, release or watcher. */
export function candidateId(c: Candidate): string {
  const n = c.next;
  const repo = REPO.test(n.repo) ? n.repo : "";
  if (n.issue !== undefined) return `${repo}#${n.issue}`;
  const what = n.kind === "release" && n.where.url ? `release ${n.where.url}` : n.runId ? `run ${n.runId}` : c.key ?? (c.watcher ? `watcher ${c.watcher}` : n.kind);
  return repo ? `${repo} ${what}` : what;
}

/** Is the candidate on Your turn: the same run, the same story, the same release pull request or the same key. */
export function onTurn(c: Candidate, items: { key: string; next: NextStep }[]): boolean {
  const n = c.next;
  return items.some((i) => {
    const m = i.next;
    if (c.key && i.key === c.key) return true;
    if (n.runId && m.runId === n.runId) return true;
    if (n.issue !== undefined && m.issue === n.issue && m.repo === n.repo) return true;
    return n.kind === "release" && !!n.where.url && m.kind === "release" && m.where.url === n.where.url;
  });
}

/** The candidates that need the user and are not on Your turn; one per id. */
export function missing(candidates: Candidate[], items: { key: string; next: NextStep }[]): Missing[] {
  const out = new Map<string, Missing>();
  for (const c of candidates) {
    if (!needsUser(c.next) || onTurn(c, items)) continue;
    const id = candidateId(c);
    if (!out.has(id)) out.set(id, { id, status: c.next.status });
  }
  return [...out.values()];
}

export interface SampleInput {
  items: SampleItem[];
  missing: Missing[];
  /** Watchers that have not finished a good check yet: what is gone from their list may only not be loaded. */
  unsettled?: Set<string>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Folds one sample (the state of the world now) into the state. Returns a new state. */
export function sampleState(prev: ClarityState, input: SampleInput, now: Date): ClarityState {
  const t = now.getTime();
  const waits = prev.waits.map((w) => ({ ...w }));
  const open = new Map<string, Wait>();
  for (const w of waits) if (w.until === undefined) open.set(w.key, w);
  const close = (w: Wait, at: number) => {
    const start = time(w.since);
    w.until = iso(at);
    w.ms = Math.max(0, at - (Number.isNaN(start) ? at : start));
    open.delete(w.key);
  };
  const endOf = (w: Wait) => (w.actedAt ? Math.min(t, time(w.actedAt)) : t);

  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    let w = open.get(item.key);
    if (w && w.stamp !== item.stamp) {
      close(w, endOf(w));
      w = undefined;
    }
    if (!w) {
      const s = time(item.since);
      w = {
        key: item.key, repo: item.repo, kind: item.kind, stamp: item.stamp,
        since: !Number.isNaN(s) && s <= t ? item.since! : iso(t),
        ...(item.issue !== undefined ? { issue: item.issue } : {}),
        ...(item.watcher ? { watcher: item.watcher } : {}),
      };
      waits.push(w);
      open.set(w.key, w);
    }
    if (item.dismissed) w.dismissed = true;
    else if (w.dismissed && !item.acted) delete w.dismissed; // shown again
    if (item.acted && !w.actedAt) w.actedAt = iso(t);
    else if (!item.acted && w.actedAt) delete w.actedAt; // the action did not take: still the same wait
  }
  for (const w of [...open.values()]) {
    if (seen.has(w.key)) continue;
    if (w.watcher && input.unsettled?.has(w.watcher)) continue;
    close(w, endOf(w));
  }

  const keep = waits.filter((w) => w.until === undefined || t - time(w.until) <= KEEP_MS);
  while (keep.length > MAX_WAITS) {
    const at = keep.findIndex((w) => w.until !== undefined);
    if (at < 0) break;
    keep.splice(at, 1);
  }

  // Misses: seen twice in a row is a miss; it ends when Your turn lists the item or it stops waiting.
  const misses = prev.misses.map((m) => ({ ...m }));
  const suspects: ClarityState["suspects"] = {};
  let missed = prev.missed;
  const now_ = iso(t);
  const here = new Set(input.missing.map((m) => m.id));
  for (const m of misses) if (m.until === undefined && !here.has(m.id)) m.until = now_;
  for (const m of input.missing) {
    const incident = misses.find((x) => x.until === undefined && x.id === m.id);
    if (incident) {
      incident.lastSeen = now_;
      incident.status = m.status;
      continue;
    }
    const before = prev.suspects[m.id];
    if (!before) {
      suspects[m.id] = { status: m.status, since: now_ };
      continue;
    }
    missed++;
    misses.push({ id: m.id, status: m.status, since: before.since, lastSeen: now_ });
  }
  // Only finished history is capped: an incident that goes on must stay, or it would be counted again.
  while (misses.length > MAX_MISSES) {
    const old = misses.findIndex((m) => m.until !== undefined);
    if (old < 0) break;
    misses.splice(old, 1);
  }

  return { version: CLARITY_VERSION, updatedAt: now_, waits: keep, missed, misses, suspects };
}

export interface ClaritySummary {
  /** Waits that ended in the last 30 days (not counting dismissed ones). */
  count: number;
  dismissed: number;
  /** Half of the waits lasted this long or less (ms); the lower of the two middle ones for an even number. */
  halfMs?: number;
  longestMs?: number;
  missed: number;
  /** Misses that are still going on. */
  missedNow: number;
  /** The newest five. */
  misses: Miss[];
}

export function summarize(state: ClarityState, now: Date): ClaritySummary {
  const t = now.getTime();
  const inWindow = state.waits.filter((w) => w.until === undefined || t - time(w.until) <= WINDOW_MS);
  const done = inWindow.filter((w) => w.until !== undefined && !w.dismissed);
  const ms = done.map((w) => w.ms ?? 0).sort((a, b) => a - b);
  return {
    count: ms.length,
    dismissed: inWindow.filter((w) => w.dismissed).length,
    ...(ms.length ? { halfMs: ms[Math.ceil(ms.length / 2) - 1], longestMs: ms[ms.length - 1] } : {}),
    missed: state.missed,
    missedNow: state.misses.filter((m) => m.until === undefined).length,
    misses: state.misses.slice(-5).reverse(),
  };
}
