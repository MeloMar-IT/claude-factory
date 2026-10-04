import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";
import { acquireLock, releaseLock } from "../home-migrate.js";

/** Version of monitor-guard.json. Later parts add the breaker and the mutes to the same file. */
export const GUARD_VERSION = 1;
/** Each of the two log files stays within this many bytes (a line is at most MAX_LINE_BYTES). */
export const MAX_LOG_BYTES = 512 * 1024;
export const MAX_LINE_BYTES = 4096;
/** While another process holds the rotation lock, lines are still appended up to this size; past it they are dropped. */
export const HARD_LOG_BYTES = 2 * MAX_LOG_BYTES;
/** How long a state change waits for monitor.lock. */
export const LOCK_WAIT_MS = 2000;
const MAX_BACKUPS = 9;

const home = () => process.env.FACTORY_HOME ?? FACTORY_HOME;
export const guardFile = (): string => join(home(), "monitor-guard.json");
export const logFile = (): string => join(home(), "monitor-log.jsonl");
export const olderLogFile = (): string => join(home(), "monitor-log.1.jsonl");
export const lockDir = (): string => join(home(), "monitor.lock");

/** Why the circuit breaker opened. */
export type BreakerWhy = { reason: "findings"; count: number; minutes: number } | { reason: "failed_fixes"; count: number };
/** An open breaker as it is stored. */
export type BreakerOpen = BreakerWhy & { since: string };

/** One plain sentence for a reason. */
export function breakerWhy(w: { reason: string; count: number; minutes?: number }): string {
  return w.reason === "findings" ? `${w.count} new findings within ${w.minutes} minutes` : `the newest ${w.count} runs of bug stories all failed`;
}

/** A mute made by an admin: one detector (by name) or one finding (by fingerprint), for a time or for good. `by` is an account id. */
export interface Mute {
  id: string;
  kind: "detector" | "finding";
  detector: string;
  /** Only for a finding mute. Never leaves the server. */
  fingerprint?: string;
  reason: string;
  since: string;
  until?: string;
  by: string;
}

/** The longest a mute may last, in hours (one year). */
export const MAX_MUTE_HOURS = 8760;
/** At most this many mutes are stored. */
export const MAX_MUTES = 200;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A reason: 1 to 200 characters, trimmed, without control characters (the rule of the audit log). */
export const validReason = (s: unknown): s is string => typeof s === "string" && s.length >= 1 && s.length <= 200 && s === s.trim() && !CONTROL.test(s);

/** The state file. Keys that this version does not know are kept. */
export interface GuardData {
  version: number;
  /** Bug stories are switched off. `by` is `cli` or an account id. */
  off?: { since: string; by: string };
  /**
   * The circuit breaker. `from` is when it was last switched on: nothing from before counts. `open` is set while it is open.
   * A `from` can be missing (never switched on).
   */
  breaker?: { from?: string; open?: BreakerOpen };
  /** The admin's mutes of a detector or a finding. */
  mutes?: Mute[];
  /** When the file was last started fresh after it could not be read. */
  reset?: string;
  [key: string]: unknown;
}

export type Loaded = { ok: true; data: GuardData } | { ok: false };

const isTime = (x: unknown): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x));
export const BY_RE = /^(cli|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const validMute = (m: unknown): boolean => {
  const x = m as Record<string, unknown>;
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  if (typeof x.id !== "string" || !/^[0-9a-f]{16}$/.test(x.id)) return false;
  if (x.kind !== "detector" && x.kind !== "finding") return false;
  if (typeof x.detector !== "string" || !x.detector || x.detector.length > 80) return false;
  if (x.kind === "finding" ? typeof x.fingerprint !== "string" || !x.fingerprint : x.fingerprint !== undefined) return false;
  return validReason(x.reason) && isTime(x.since) && (x.until === undefined || isTime(x.until)) && typeof x.by === "string" && BY_RE.test(x.by);
};

function parseGuard(text: string): GuardData | undefined {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return undefined;
  const x = d as GuardData;
  if (x.version !== GUARD_VERSION) return undefined;
  if (x.off !== undefined) {
    const o = x.off as unknown as Record<string, unknown>;
    if (!o || typeof o !== "object" || !isTime(o.since) || typeof o.by !== "string" || !BY_RE.test(o.by)) return undefined;
  }
  if (x.reset !== undefined && !isTime(x.reset)) return undefined;
  if (x.mutes !== undefined && (!Array.isArray(x.mutes) || x.mutes.length > MAX_MUTES || !x.mutes.every(validMute))) return undefined;
  if (x.breaker !== undefined) {
    const b = x.breaker as unknown as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) return undefined;
    if (b.from !== undefined && !isTime(b.from)) return undefined;
    if (b.open !== undefined) {
      const o = b.open as Record<string, unknown>;
      const pos = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
      if (!o || typeof o !== "object" || !isTime(o.since) || (o.reason !== "findings" && o.reason !== "failed_fixes") || !pos(o.count)) return undefined;
      if (o.minutes !== undefined && !pos(o.minutes)) return undefined;
      if (o.reason === "findings" && o.minutes === undefined) return undefined;
    }
  }
  return x;
}

/** Reads the state. A missing file is on (empty state); a file that cannot be read or understood is not ok. Never throws, never renames. */
export function loadGuard(file = guardFile()): Loaded {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(file); // a dangling link is not "missing"
      } catch {
        return { ok: true, data: { version: GUARD_VERSION } };
      }
    }
    return { ok: false };
  }
  const data = parseGuard(text);
  return data ? { ok: true, data } : { ok: false };
}

/** Writes through a temporary file, like saveFindings(), so a crash never leaves half a file. */
export function saveGuard(data: GuardData, file = guardFile(), beforeRename?: () => void): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    beforeRename?.(); // throws when the writer lost the lock: nothing is committed
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export type StoriesState =
  | { state: "on"; reset?: string }
  | { state: "off"; since: string; by: string; reset?: string }
  | { state: "quiet"; until: string; reset?: string }
  | ({ state: "breaker"; reset?: string } & BreakerOpen)
  | { state: "unreadable" };

export interface StateOptions {
  /** When the server started; without it there is no quiet time. */
  startedAt?: Date;
  /** Minutes of quiet time after the start (0: none). */
  cooldownMinutes?: number;
  now?: Date;
  file?: string;
}

/** Is `now` within `cooldownMinutes` after the server started? */
export function inQuietTime(now: Date, startedAt?: Date, cooldownMinutes = 0): boolean {
  return !!startedAt && cooldownMinutes > 0 && now.getTime() < startedAt.getTime() + cooldownMinutes * 60_000;
}

/** Pure on its input: unreadable wins over off, off over the breaker, the breaker over quiet. */
export function storiesState(loaded: Loaded, o: StateOptions = {}): StoriesState {
  if (!loaded.ok) return { state: "unreadable" };
  const reset = loaded.data.reset ? { reset: loaded.data.reset } : {};
  if (loaded.data.off) return { state: "off", since: loaded.data.off.since, by: loaded.data.off.by, ...reset };
  if (loaded.data.breaker?.open) return { state: "breaker", ...loaded.data.breaker.open, ...reset };
  const now = o.now ?? new Date();
  if (inQuietTime(now, o.startedAt, o.cooldownMinutes)) return { state: "quiet", until: new Date(o.startedAt!.getTime() + o.cooldownMinutes! * 60_000).toISOString(), ...reset };
  return { state: "on", ...reset };
}

/** The open breaker now, if any (reads the file). */
export function breakerNow(file = guardFile()): BreakerOpen | undefined {
  const l = loadGuard(file);
  return l.ok ? l.data.breaker?.open : undefined; // the off switch does not close it: only "on" does
}

/** Reads the file now and says what the state is. */
export const currentState = (o: StateOptions = {}): StoriesState => storiesState(loadGuard(o.file), o);

export type Reason = "off" | "cooldown" | "unreadable" | "breaker";
export type Verdict = { go: true } | { go: false; reason: Reason; note: string };

/** May the monitor make bug stories now? Reads the file at every call. */
export function storiesVerdict(o: StateOptions = {}): Verdict {
  const s = currentState(o);
  if (s.state === "on") return { go: true };
  if (s.state === "off") return { go: false, reason: "off", note: "bug stories are switched off" };
  if (s.state === "breaker") return { go: false, reason: "breaker", note: "the circuit breaker is open" };
  if (s.state === "quiet") return { go: false, reason: "cooldown", note: "quiet time after the restart" };
  return { go: false, reason: "unreadable", note: "the state file monitor-guard.json cannot be read" };
}

// ── the log ──

export interface LogEntry {
  event: "off" | "on" | "story-made" | "story-skipped" | "breaker-open" | "breaker-closed" | "fix-failed" | "mute-made" | "mute-ended";
  by?: string;
  /** breaker-open: findings or failed_fixes (in `reason`), how many, and within how many minutes. fix-failed: how many times. */
  count?: number;
  minutes?: number;
  reset?: boolean;
  /** Why a story was skipped: off, cooldown, unreadable, muted, day_limit, check_limit, request_limit, github. mute-ended: `expired` for a mute that ran out. */
  reason?: string;
  /** The id of a mute, its reason text, and when it ends (for mute-made, mute-ended and a story skipped because of a mute). */
  mute?: string;
  text?: string;
  until?: string;
  detector?: string;
  fingerprint?: string;
  repo?: string;
  issue?: number;
}

const cut = (s: unknown, n: number): string => String(s).slice(0, n);

/** One plain line for the card's recent activity. */
export function describeEntry(e: LogEntry): string {
  switch (e.event) {
    case "off":
      return "bug stories switched off";
    case "on":
      return "bug stories switched on";
    case "story-made":
      return `bug story #${e.issue ?? "?"} made (${e.detector ?? ""})`;
    case "breaker-open":
      return `circuit breaker opened: ${breakerWhy({ reason: e.reason ?? "", count: e.count ?? 0, minutes: e.minutes })}`;
    case "breaker-closed":
      return "circuit breaker closed";
    case "fix-failed":
      return `the fix failed: bug story #${e.issue ?? "?"} (${e.detector ?? ""}), ${e.count ?? 1} ${e.count === 1 ? "time" : "times"}`;
    case "mute-made":
      return `muted ${e.fingerprint ? `a finding of ${e.detector ?? ""}` : (e.detector ?? "")} ${e.until ? `until ${e.until}` : "for good"}: ${e.text ?? ""}`;
    case "mute-ended":
      return `mute ended (${e.detector ?? ""})${e.reason === "expired" ? ": it ran out" : ""}`;
    default: {
      const why: Record<string, string> = {
        off: "bug stories are off",
        cooldown: "quiet time after the restart",
        unreadable: "the state file cannot be read",
        breaker: "the circuit breaker is open",
        day_limit: "the limit for a day is used up",
        check_limit: "the limit for one check is reached",
        request_limit: "GitHub's request limit is used up",
        github: "GitHub did not answer",
        muted: "muted",
      };
      return `bug story skipped (${e.detector ?? ""}): ${why[e.reason ?? ""] ?? e.reason ?? ""}${e.reason === "muted" && e.text ? `: ${e.text}` : ""}`;
    }
  }
}

export interface LogOptions {
  now?: Date;
  /** Called with a short text when the line could not be written (never throws). */
  onError?: (msg: string) => void;
  file?: string;
}

/** The line as JSON: every free field is cut, so a line stays well under MAX_LINE_BYTES. */
export function logLine(e: LogEntry, at: Date): string {
  const o: Record<string, unknown> = { at: at.toISOString(), event: e.event };
  if (e.by !== undefined) o.by = cut(e.by, 40);
  if (e.reset) o.reset = true;
  if (e.reason !== undefined) o.reason = cut(e.reason, 40);
  if (e.detector !== undefined) o.detector = cut(e.detector, 80);
  if (e.fingerprint !== undefined) o.fingerprint = cut(e.fingerprint, 200);
  if (e.mute !== undefined) o.mute = cut(e.mute, 40);
  if (e.text !== undefined) o.text = cut(e.text, 200);
  if (e.until !== undefined) o.until = cut(e.until, 40);
  if (e.repo !== undefined) o.repo = cut(e.repo, 100);
  if (e.issue !== undefined && Number.isInteger(e.issue)) o.issue = e.issue;
  if (e.count !== undefined && Number.isInteger(e.count)) o.count = e.count;
  if (e.minutes !== undefined && Number.isInteger(e.minutes)) o.minutes = e.minutes;
  let line = JSON.stringify(o);
  if (Buffer.byteLength(line) >= MAX_LINE_BYTES) {
    delete o.fingerprint;
    line = JSON.stringify(o);
  }
  return line;
}

/** Appends one line to monitor-log.jsonl. Past MAX_LOG_BYTES the file moves to monitor-log.1.jsonl (the older one goes). Never throws. */
export function writeLog(e: LogEntry, o: LogOptions = {}): void {
  const file = o.file ?? logFile();
  const older = join(dirname(file), "monitor-log.1.jsonl");
  try {
    const line = logLine(e, o.now ?? new Date()) + "\n";
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // no file yet
    }
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      // Only one process rotates, under a lock of its own (a suspended switch must not stop the rotation).
      const lock = join(dirname(file), "monitor-log.lock");
      if (acquireLock(lock, 0)) {
        try {
          let again = 0;
          try {
            again = statSync(file).size;
          } catch {
            // already rotated
          }
          if (again + Buffer.byteLength(line) > MAX_LOG_BYTES) renameSync(file, older);
        } finally {
          releaseLock(lock);
        }
      } else if (size + Buffer.byteLength(line) > HARD_LOG_BYTES) {
        // Another process holds the rotation lock and the file is far over the limit: the line is dropped, never the bound.
        o.onError?.("the monitor log is over its size limit and cannot be rotated now; a line was dropped");
        return;
      }
    }
    appendFileSync(file, line, { mode: 0o600 });
  } catch (err) {
    o.onError?.(`the monitor log could not be written (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

// ── the switch ──

export interface SwitchOptions {
  waitMs?: number;
  now?: Date;
  file?: string;
  /** For tests: replaces renameSync. */
  rename?: typeof renameSync;
  logFile?: string;
  /** For tests: runs after the state was read and before it is written (a pause of this process). */
  beforeWrite?: () => void;
  /** For tests: runs for "on" right before each commit step (a stall inside the write). */
  beforeCommit?: () => void;
  onLogError?: (msg: string) => void;
}

export type SwitchResult =
  | { changed: boolean; state: "on" | "off"; since?: string; reset?: string; closed?: boolean }
  | { changed: false; state: "unreadable" };

/**
 * Runs `fn` with monitor.lock held. A lock that is not free in `waitMs` makes `locked` false (the caller decides), unless
 * `force`: then the lock of the stuck holder is taken over. `own()` says whether the lock is still ours (a token inside
 * it): a holder that was taken over must not write.
 */
export function withMonitorLock<T>(fn: (locked: boolean, own: () => boolean, forced: boolean) => T, waitMs = LOCK_WAIT_MS, force = false): T {
  mkdirSync(home(), { recursive: true });
  const lock = lockDir();
  const token = randomBytes(8).toString("hex");
  let got = acquireLock(lock, waitMs);
  let forced = false;
  if (!got && force) {
    rmSync(lock, { recursive: true, force: true });
    got = acquireLock(lock, 0);
    forced = got;
  }
  if (got) writeFileSync(join(lock, "token"), token);
  const own = () => {
    try {
      return readFileSync(join(lock, "token"), "utf8") === token;
    } catch {
      return false;
    }
  };
  try {
    return fn(got, own, forced);
  } finally {
    if (got && own()) releaseLock(lock);
  }
}

/** Moves the unreadable file aside (older backups shift up) and puts a fresh one in its place. All or nothing. */
function recover(file: string, fresh: GuardData, rename: typeof renameSync, check: () => void): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const moves: [string, string][] = [];
  const exists = (p: string) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const move = (from: string, to: string) => {
    check(); // a writer that lost the lock moves nothing (what was moved is put back below)
    rename(from, to);
    moves.push([from, to]);
  };
  try {
    writeFileSync(tmp, JSON.stringify(fresh, null, 1), { mode: 0o600 });
    const name = (n: number) => (n === 0 ? `${file}.broken` : `${file}.broken.${n}`);
    let last = -1;
    while (last < MAX_BACKUPS && exists(name(last + 1))) last++;
    // Older backups shift up, from the top down; past MAX_BACKUPS the oldest is replaced.
    for (let n = Math.min(last, MAX_BACKUPS - 1); n >= 0; n--) move(name(n), name(n + 1));
    move(file, name(0));
    move(tmp, file);
  } catch (e) {
    for (const [from, to] of moves.reverse()) {
      try {
        renameSync(to, from);
      } catch {
        // nothing more to do
      }
    }
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Switches bug stories off or on. Under monitor.lock; "off" waits at most `waitMs` and then writes anyway (it must always
 * work), "on" throws when the lock stays held. An unreadable file: "off" does nothing, "on" keeps it as `.broken` and starts fresh.
 */
export function switchStories(sub: "off" | "on", by: string, o: SwitchOptions = {}): SwitchResult {
  if (!BY_RE.test(by)) throw new Error("by must be cli or an account id");
  const file = o.file ?? guardFile();
  const at = (o.now ?? new Date()).toISOString();
  const rename = o.rename ?? renameSync;
  const result = withMonitorLock((locked, own, forced) => {
    if (!locked && sub === "on") throw new Error(`monitor.lock is held by another process; try again, or remove ${lockDir()} if no process uses it`);
    const loaded = loadGuard(file);
    o.beforeWrite?.();
    // "On" gives way: an "off" that took the lock over while we were paused must stay off. Asked again right before each commit.
    const check = () => {
      if (sub === "on") {
        o.beforeCommit?.();
        if (!own()) throw new Error("monitor.lock was taken over by a switch to off; nothing was changed");
      }
    };
    check();
    if (!loaded.ok) {
      if (sub === "off") return { changed: false, state: "unreadable" } as SwitchResult;
      recover(file, { version: GUARD_VERSION, reset: at, breaker: { from: at } }, rename, check);
      return { changed: true, state: "on", reset: at } as SwitchResult;
    }
    const d = { ...loaded.data };
    if (sub === "off") {
      if (d.off) {
        // After a takeover the read may be older than a writer's rename: write the off state again, so it is the last word.
        if (forced) saveGuard(d, file);
        return { changed: false, state: "off", since: d.off.since } as SwitchResult;
      }
      delete d.reset;
      d.off = { since: at, by };
      saveGuard(d, file);
      return { changed: true, state: "off", since: at } as SwitchResult;
    }
    // Every switch-on starts the counts anew (`from`); it is a change only when something was off or open.
    if (!d.off && !d.breaker?.open) return { changed: false, state: "on" } as SwitchResult;
    const closed = !!d.breaker?.open;
    delete d.off;
    d.breaker = { from: at };
    saveGuard(d, file, check);
    return { changed: true, state: "on", ...(closed ? { closed: true } : {}) } as SwitchResult;
  }, o.waitMs ?? LOCK_WAIT_MS, sub === "off"); // "off" always gets the lock, from a stuck holder too
  if (result.changed) {
    const reset = result.state === "on" && "reset" in result && !!result.reset;
    writeLog({ event: sub, by, ...(reset ? { reset: true } : {}) }, { now: o.now, onError: o.onLogError, file: o.logFile });
    if ("closed" in result && result.closed) writeLog({ event: "breaker-closed", by }, { now: o.now, onError: o.onLogError, file: o.logFile });
  }
  return result;
}

/** How long opening the breaker waits for monitor.lock (the monitor's check must not stall). */
export const BREAKER_LOCK_WAIT_MS = 200;

/**
 * Opens the circuit breaker, under monitor.lock. `from` is the `from` the decision was made on: when the file has another
 * one, a switch-on came in between and nothing is opened. Returns the open breaker (also an existing one), or undefined
 * when nothing was opened (off, unreadable, or another `from`). Throws when the lock is not free.
 */
export function openBreaker(why: BreakerWhy, from: string | undefined, o: SwitchOptions & { recheck?: (data: GuardData) => BreakerWhy | undefined } = {}): BreakerOpen | undefined {
  const file = o.file ?? guardFile();
  const since = (o.now ?? new Date()).toISOString();
  return withMonitorLock((locked, own) => {
    if (!locked) throw new Error("monitor.lock is held by another process; the circuit breaker could not be opened");
    const loaded = loadGuard(file);
    if (!loaded.ok || loaded.data.off) return undefined;
    if (loaded.data.breaker?.open) return loaded.data.breaker.open;
    if (loaded.data.breaker?.from !== from) return undefined;
    // Asked again under the lock: a mute made since the decision may take the reason away (or change it).
    const now = o.recheck ? o.recheck(loaded.data) : why;
    if (!now) return undefined;
    const open: BreakerOpen = { ...now, since };
    saveGuard({ ...loaded.data, breaker: { ...loaded.data.breaker, open } }, file, () => {
      if (!own()) throw new Error("monitor.lock was taken over; the circuit breaker was not opened");
    });
    writeLog({ event: "breaker-open", reason: now.reason, count: now.count, ...(now.reason === "findings" ? { minutes: now.minutes } : {}) }, { now: o.now, onError: o.onLogError, file: o.logFile });
    return open;
  }, o.waitMs ?? BREAKER_LOCK_WAIT_MS);
}
