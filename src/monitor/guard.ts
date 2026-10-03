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

/** The state file. Keys that this version does not know are kept. */
export interface GuardData {
  version: number;
  /** Bug stories are switched off. `by` is `cli` or an account id. */
  off?: { since: string; by: string };
  /** When the file was last started fresh after it could not be read. */
  reset?: string;
  [key: string]: unknown;
}

export type Loaded = { ok: true; data: GuardData } | { ok: false };

const isTime = (x: unknown): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x));
const BY_RE = /^(cli|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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
  | { state: "unreadable" };

export interface StateOptions {
  /** When the server started; without it there is no quiet time. */
  startedAt?: Date;
  /** Minutes of quiet time after the start (0: none). */
  cooldownMinutes?: number;
  now?: Date;
  file?: string;
}

/** Pure on its input: unreadable wins over off, off wins over quiet. */
export function storiesState(loaded: Loaded, o: StateOptions = {}): StoriesState {
  if (!loaded.ok) return { state: "unreadable" };
  const reset = loaded.data.reset ? { reset: loaded.data.reset } : {};
  if (loaded.data.off) return { state: "off", since: loaded.data.off.since, by: loaded.data.off.by, ...reset };
  if (o.startedAt && (o.cooldownMinutes ?? 0) > 0) {
    const until = o.startedAt.getTime() + o.cooldownMinutes! * 60_000;
    if ((o.now ?? new Date()).getTime() < until) return { state: "quiet", until: new Date(until).toISOString(), ...reset };
  }
  return { state: "on", ...reset };
}

/** Reads the file now and says what the state is. */
export const currentState = (o: StateOptions = {}): StoriesState => storiesState(loadGuard(o.file), o);

export type Reason = "off" | "cooldown" | "unreadable";
export type Verdict = { go: true } | { go: false; reason: Reason; note: string };

/** May the monitor make bug stories now? Reads the file at every call. */
export function storiesVerdict(o: StateOptions = {}): Verdict {
  const s = currentState(o);
  if (s.state === "on") return { go: true };
  if (s.state === "off") return { go: false, reason: "off", note: "bug stories are switched off" };
  if (s.state === "quiet") return { go: false, reason: "cooldown", note: "quiet time after the restart" };
  return { go: false, reason: "unreadable", note: "the state file monitor-guard.json cannot be read" };
}

// ── the log ──

export interface LogEntry {
  event: "off" | "on" | "story-made" | "story-skipped";
  by?: string;
  reset?: boolean;
  /** Why a story was skipped: off, cooldown, unreadable, day_limit, check_limit, request_limit, github. */
  reason?: string;
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
    default: {
      const why: Record<string, string> = {
        off: "bug stories are off",
        cooldown: "quiet time after the restart",
        unreadable: "the state file cannot be read",
        day_limit: "the limit for a day is used up",
        check_limit: "the limit for one check is reached",
        request_limit: "GitHub's request limit is used up",
        github: "GitHub did not answer",
      };
      return `bug story skipped (${e.detector ?? ""}): ${why[e.reason ?? ""] ?? e.reason ?? ""}`;
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
  if (e.repo !== undefined) o.repo = cut(e.repo, 100);
  if (e.issue !== undefined && Number.isInteger(e.issue)) o.issue = e.issue;
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
  | { changed: boolean; state: "on" | "off"; since?: string; reset?: string }
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
      recover(file, { version: GUARD_VERSION, reset: at }, rename, check);
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
    if (!d.off) return { changed: false, state: "on" } as SwitchResult;
    delete d.off;
    saveGuard(d, file, check);
    return { changed: true, state: "on" } as SwitchResult;
  }, o.waitMs ?? LOCK_WAIT_MS, sub === "off"); // "off" always gets the lock, from a stuck holder too
  if (result.changed) {
    const reset = result.state === "on" && "reset" in result && !!result.reset;
    writeLog({ event: sub, by, ...(reset ? { reset: true } : {}) }, { now: o.now, onError: o.onLogError, file: o.logFile });
  }
  return result;
}
