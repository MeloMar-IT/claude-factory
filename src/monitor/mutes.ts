import { randomBytes } from "node:crypto";
import { BY_RE, guardFile, loadGuard, lockDir, MAX_MUTE_HOURS, MAX_MUTES, saveGuard, validReason, withMonitorLock, writeLog, type GuardData, type Loaded, type Mute, type SwitchOptions } from "./guard.js";
import { markerHash } from "./story.js";

/**
 * The admin's mutes of a detector or a finding. They live in monitor-guard.json (`mutes`), are changed under monitor.lock
 * and written through a temporary file, like the off switch. A muted finding is still recorded; only its story is not made.
 */

export type MuteErrorCode = "invalid" | "not_found" | "exists" | "full" | "locked" | "unreadable";

export class MuteError extends Error {
  constructor(public code: MuteErrorCode, message: string) {
    super(message);
  }
}

export interface MuteInput {
  /** The detector; for a finding mute, the detector of the finding. */
  detector: string;
  /** Set for a finding mute. */
  fingerprint?: string;
  reason: string;
  /** Missing: for good. */
  hours?: number;
  /** An account id. */
  by: string;
}

/** Is the mute still in force at `now`? It ends exactly at `until`. */
export const inForce = (m: Mute, now: Date): boolean => !m.until || Date.parse(m.until) > now.getTime();

/** The mutes in force at `now`. An unreadable file has none (the state is "unreadable" then, and no story is made anyway). */
export function activeMutes(loaded: Loaded, now: Date): Mute[] {
  return loaded.ok ? (loaded.data.mutes ?? []).filter((m) => inForce(m, now)) : [];
}

/** The mute that holds a finding: a mute of the finding first, else one of its detector. */
export function muteFor(mutes: Mute[], f: { detector: string; fingerprint: string }): Mute | undefined {
  return mutes.find((m) => m.kind === "finding" && m.fingerprint === f.fingerprint) ?? mutes.find((m) => m.kind === "detector" && m.detector === f.detector);
}

/** One plain line for a mute, as `scf monitor status` prints it. The finding is named by its hash, never by the fingerprint. */
export function muteLine(m: Mute): string {
  const what = m.kind === "finding" ? `finding ${markerHash(m.fingerprint ?? "")} of ${m.detector}` : `detector ${m.detector}`;
  return `${what}: ${m.reason} (since ${m.since}, ${m.until ? `until ${m.until}` : "for good"}, by ${m.by})`;
}

const sameTarget = (a: Mute, b: Pick<Mute, "kind" | "detector" | "fingerprint">) => a.kind === b.kind && (a.kind === "finding" ? a.fingerprint === b.fingerprint : a.detector === b.detector);

interface MuteOptions extends SwitchOptions {
  onLogError?: (msg: string) => void;
}

/** Runs `change` on the state under monitor.lock and saves the result. The errors are MuteErrors. */
function change<T>(o: MuteOptions, change: (data: GuardData, now: Date) => { data: GuardData; result: T }): T {
  const file = o.file ?? guardFile();
  const now = o.now ?? new Date();
  return withMonitorLock((locked, own) => {
    if (!locked) throw new MuteError("locked", `monitor.lock is held by another process; try again, or remove ${lockDir()} if no process uses it`);
    const loaded = loadGuard(file);
    if (!loaded.ok) throw new MuteError("unreadable", "the state file monitor-guard.json cannot be read");
    o.beforeWrite?.();
    const { data, result } = change(loaded.data, now);
    saveGuard(data, file, () => {
      if (!own()) throw new MuteError("locked", "monitor.lock was taken over; nothing was changed");
    });
    return result;
  }, o.waitMs);
}

/** Makes a mute. Throws a MuteError: `invalid`, `exists` (the same detector or the same finding is muted), `full`, `locked`, `unreadable`. */
export function addMute(i: MuteInput, o: MuteOptions = {}): Mute {
  if (!validReason(i.reason)) throw new MuteError("invalid", "the reason must be 1 to 200 characters without control characters");
  if (i.hours !== undefined && !(typeof i.hours === "number" && Number.isFinite(i.hours) && i.hours > 0 && i.hours <= MAX_MUTE_HOURS)) throw new MuteError("invalid", `hours must be a number above 0 and at most ${MAX_MUTE_HOURS}`);
  if (!BY_RE.test(i.by)) throw new MuteError("invalid", "by must be cli or an account id");
  if (!i.detector) throw new MuteError("invalid", "a detector is needed");
  const now = o.now ?? new Date();
  const { m: mute, dropped } = change(o, (data) => {
    const held = (data.mutes ?? []).filter((m) => inForce(m, now));
    const dropped = (data.mutes ?? []).filter((m) => !inForce(m, now)); // ran out: removed now, so they never fill the list
    const target = { kind: i.fingerprint !== undefined ? ("finding" as const) : ("detector" as const), detector: i.detector, fingerprint: i.fingerprint };
    if (held.some((m) => sameTarget(m, target))) throw new MuteError("exists", `this ${target.kind} is already muted; end that mute first`);
    if (held.length >= MAX_MUTES) throw new MuteError("full", `there are ${MAX_MUTES} mutes already; end one first`);
    const m: Mute = {
      id: randomBytes(8).toString("hex"),
      kind: target.kind,
      detector: i.detector,
      ...(i.fingerprint !== undefined ? { fingerprint: i.fingerprint } : {}),
      reason: i.reason,
      since: now.toISOString(),
      ...(i.hours !== undefined ? { until: new Date(now.getTime() + i.hours * 3_600_000).toISOString() } : {}),
      by: i.by,
    };
    return { data: { ...data, mutes: [...held, m] }, result: { m, dropped } };
  });
  for (const x of dropped) writeLog({ event: "mute-ended", reason: "expired", detector: x.detector, ...(x.fingerprint ? { fingerprint: x.fingerprint } : {}), mute: x.id, text: x.reason }, { now, onError: o.onLogError, file: o.logFile });
  writeLog({ event: "mute-made", by: mute.by, detector: mute.detector, ...(mute.fingerprint ? { fingerprint: mute.fingerprint } : {}), mute: mute.id, text: mute.reason, ...(mute.until ? { until: mute.until } : {}) }, { now, onError: o.onLogError, file: o.logFile });
  return mute;
}

/** Ends a mute in force (an expired one is gone already: `not_found`). */
export function endMute(id: string, by: string, o: MuteOptions = {}): Mute {
  if (!BY_RE.test(by)) throw new MuteError("invalid", "by must be cli or an account id");
  const now = o.now ?? new Date();
  const mute = change(o, (data) => {
    const m = (data.mutes ?? []).find((x) => x.id === id && inForce(x, now));
    if (!m) throw new MuteError("not_found", "mute not found");
    const left = (data.mutes ?? []).filter((x) => x !== m);
    const { mutes: _old, ...rest } = data;
    return { data: left.length ? { ...rest, mutes: left } : rest, result: m };
  });
  writeLog({ event: "mute-ended", by, detector: mute.detector, ...(mute.fingerprint ? { fingerprint: mute.fingerprint } : {}), mute: mute.id, text: mute.reason }, { now, onError: o.onLogError, file: o.logFile });
  return mute;
}

/**
 * Takes the mutes that ran out from the file, one `mute-ended` line each. Nothing expired: no lock is taken. The lock is
 * not waited for (the next check tries again): returns [] then.
 */
export function expireMutes(now: Date, o: MuteOptions = {}): Mute[] {
  const file = o.file ?? guardFile();
  const first = loadGuard(file);
  if (!first.ok || !(first.data.mutes ?? []).some((m) => !inForce(m, now))) return [];
  let gone: Mute[] = [];
  try {
    gone = change({ ...o, waitMs: 0, now }, (data) => {
      const out = (data.mutes ?? []).filter((m) => !inForce(m, now));
      const left = (data.mutes ?? []).filter((m) => inForce(m, now));
      const { mutes: _old, ...rest } = data;
      return { data: out.length ? (left.length ? { ...rest, mutes: left } : rest) : data, result: out };
    });
  } catch (e) {
    if (e instanceof MuteError) return [];
    throw e;
  }
  for (const m of gone) writeLog({ event: "mute-ended", reason: "expired", detector: m.detector, ...(m.fingerprint ? { fingerprint: m.fingerprint } : {}), mute: m.id, text: m.reason }, { now, onError: o.onLogError, file: o.logFile });
  return gone;
}
