/**
 * Waits and locks for wrong password tries, in memory (a restart clears them).
 *
 * A key (an e-mail, or a client address) is counted before the password is checked. From the 5th count a wait grows
 * (1, 2, 4, 8, 16, 32 s, then 60 s). The 20th count of a key that may lock puts a 30-minute lock on it. A try that
 * turned out fine is given back, so right passwords do not use up tries.
 */
export const WAIT_FROM = 5;
export const LOCK_AT = 20;
export const LOCK_MS = 30 * 60 * 1000;
export const FORGET_MS = 30 * 60 * 1000;
export const MAX_WAIT_MS = 60 * 1000;
export const THROTTLE_ENTRIES = 1000;

/** The wait (ms) after the n-th count: none for 1 to 4, then 1 s doubling up to 32 s, then 60 s. */
export function waitAfter(n: number): number {
  if (n < WAIT_FROM) return 0;
  return Math.min(1000 * 2 ** (n - WAIT_FROM), MAX_WAIT_MS);
}

export type Verdict = { kind: "open" } | { kind: "wait"; waitMs: number } | { kind: "locked"; waitMs: number };

const OPEN: Verdict = { kind: "open" };
const RANK = { open: 0, wait: 1, locked: 2 };

/** The strongest refusal: locked over wait over open; of two of a kind, the longer. */
export function worst(...vs: Verdict[]): Verdict {
  let w: Verdict = OPEN;
  for (const v of vs) {
    const a = RANK[v.kind];
    const b = RANK[w.kind];
    if (a > b || (a === b && v.kind !== "open" && (v as { waitMs: number }).waitMs > (w as { waitMs: number }).waitMs)) w = v;
  }
  return w;
}

/** "1 second", "8 seconds", "1 minute", "2 minutes". Rounds up. */
export function throttleText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} ${s === 1 ? "second" : "seconds"}`;
  const m = Math.ceil(s / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** The sentence for a 429 answer. */
export function verdictText(v: Verdict): string {
  if (v.kind === "open") return "";
  return v.kind === "locked" ? `too many wrong tries; this account is locked for ${throttleText(v.waitMs)}` : `too many tries; try again in ${throttleText(v.waitMs)}`;
}

/** The `Retry-After` header value: whole seconds, at least 1. */
export const retryAfter = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

interface Entry {
  /** The wait end of each count that is still counted (the last one is the current wait). */
  untils: number[];
  /** The time of each count that is still counted, in step with `untils`. */
  times: number[];
  count: number;
  lockedUntil?: number;
  last: number;
  keep: boolean;
}

/** One counted try. `giveBack()` takes it out again, once. */
export interface Try {
  giveBack(): void;
}

export interface ThrottleOptions {
  /** Whether the 20th count locks (default true). Without it the wait stays at 60 s. */
  lock?: boolean;
  /** At most this many entries (default 1000). */
  cap?: number;
  now?: () => number;
}

export class Throttle {
  private entries = new Map<string, Entry>();
  private lock: boolean;
  private cap: number;
  private now: () => number;

  constructor(opts: ThrottleOptions = {}) {
    this.lock = opts.lock ?? true;
    this.cap = opts.cap ?? THROTTLE_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  private over(e: Entry, t: number): boolean {
    return e.lockedUntil !== undefined ? t >= e.lockedUntil : t - e.last >= FORGET_MS;
  }

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && this.over(e, this.now())) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  get size(): number {
    return this.entries.size;
  }

  countOf(key: string): number {
    return this.live(key)?.count ?? 0;
  }

  /** When the lock of the key ends (ms), or undefined. */
  lockedUntilOf(key: string): number | undefined {
    return this.live(key)?.lockedUntil;
  }

  check(key: string): Verdict {
    const e = this.live(key);
    if (!e) return OPEN;
    const t = this.now();
    if (e.lockedUntil !== undefined) return { kind: "locked", waitMs: e.lockedUntil - t };
    const until = e.untils[e.untils.length - 1] ?? 0;
    return until > t ? { kind: "wait", waitMs: until - t } : OPEN;
  }

  /** Removes the entry (and so the lock). */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Counts a try. `keep`: the entry is not dropped for room unless nothing else can go. */
  count(key: string, opts: { keep?: boolean } = {}): Try {
    const t = this.now();
    let e = this.live(key);
    if (!e) {
      this.makeRoom(t);
      e = { untils: [], times: [], count: 0, last: t, keep: false };
      this.entries.set(key, e);
    }
    const entry = e;
    if (opts.keep) entry.keep = true;
    entry.count++;
    entry.last = t;
    if (this.lock && entry.count >= LOCK_AT) entry.lockedUntil = t + LOCK_MS;
    entry.untils.push(t + waitAfter(entry.count));
    entry.times.push(t);
    if (entry.untils.length > LOCK_AT) {
      entry.untils.shift();
      entry.times.shift();
    }
    let given = false;
    return {
      giveBack: () => {
        if (given) return;
        given = true;
        if (this.entries.get(key) !== entry || entry.lockedUntil !== undefined) return;
        entry.count--;
        entry.untils.pop();
        entry.times.pop();
        entry.last = entry.times[entry.times.length - 1] ?? entry.last; // the earlier tries expire on their own time
        if (entry.count <= 0) this.entries.delete(key);
      },
    };
  }

  /** Drops entries that are over, then (if still full) one more: unkept before kept, unlocked before locked, oldest first. */
  private makeRoom(t: number): void {
    if (this.entries.size < this.cap) return;
    for (const [k, e] of this.entries) if (this.over(e, t)) this.entries.delete(k);
    if (this.entries.size < this.cap) return;
    // Kept entries (stored accounts) are never dropped for room: when only they are left, the map may grow past the cap.
    // That is bounded by the number of accounts. Unkept: unlocked before locked, oldest first.
    for (const locked of [false, true]) {
      for (const [k, e] of this.entries) {
        if (!e.keep && (e.lockedUntil !== undefined) === locked) {
          this.entries.delete(k);
          return;
        }
      }
    }
  }
}
