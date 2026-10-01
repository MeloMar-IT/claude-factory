import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { FACTORY_HOME } from "../flow/load.js";
import { clockMinutes, composeNotice, deliver, fit, hasChannel, inQuietHours, minutesNow, runMessage, summaryNotice, type Notice, type NoticeItem } from "../notify.js";
import { runOrigin } from "../your-turn.js";
import type { ApiContext } from "./server.js";
import { turnFor } from "./your-turn.js";

const DAY = 86_400_000;
/** Successes older than this are never told. */
const DONE_WINDOW_MS = 7 * DAY;
/** What was told about something that is gone is kept this long (longer than the window above). */
const KEEP_MS = 30 * DAY;

export interface NotifierDeps {
  /** http://localhost:<port> */
  baseUrl: string;
  /** Resolves false when no channel got the notice (it is then tried again at the next check). */
  send?: (n: Notice, cfg: Config["notify"]) => Promise<boolean | void>;
  log?: (m: string) => void;
  /** Tests only; default: this machine's. */
  timeZone?: string;
}

interface State {
  notified: Record<string, { stamp: string; at: string }>;
  lastSentAt?: string;
  doneSince?: string;
  successesOn?: boolean;
  lastSummaryDay?: string;
  lastSummaryAt?: string;
}

const stateFile = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "notifications.json");

const isStr = (v: unknown): v is string => typeof v === "string";

/** A missing, broken or oddly shaped file reads as empty. */
function readState(): State {
  try {
    const d = JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
    const n = d.notified;
    if (!d || typeof d !== "object" || !n || typeof n !== "object" || Array.isArray(n)) return { notified: {} };
    for (const e of Object.values(n)) {
      const x = e as { stamp?: unknown; at?: unknown } | null;
      if (!x || !isStr(x.stamp) || !isStr(x.at)) return { notified: {} };
    }
    return {
      notified: n as State["notified"],
      lastSentAt: isStr(d.lastSentAt) ? d.lastSentAt : undefined,
      doneSince: isStr(d.doneSince) ? d.doneSince : undefined,
      successesOn: typeof d.successesOn === "boolean" ? d.successesOn : undefined,
      lastSummaryDay: isStr(d.lastSummaryDay) ? d.lastSummaryDay : undefined,
      lastSummaryAt: isStr(d.lastSummaryAt) ? d.lastSummaryAt : undefined,
    };
  } catch {
    return { notified: {} };
  }
}

function writeState(s: State) {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

/** A bit more than two checks. */
const SWITCH_GRACE_MS = 90_000;

/** The day ("YYYY-MM-DD") of the most recent time the clock showed `at`: today once it has passed, else yesterday. */
function occurrenceDay(tz: string | undefined, now: Date, at: string): string {
  const m = minutesNow(tz, now);
  return m.minutes >= clockMinutes(at) ? m.day : minutesNow(tz, new Date(now.getTime() - DAY)).day;
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Tells the owner (macOS, Slack) when something lands in Your turn: grouped, throttled, with quiet hours and an optional daily summary. */
export class TurnNotifier {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private ctx: ApiContext, private d: NotifierDeps) {}

  start(everyMs = 30_000) {
    if (this.timer) return;
    try {
      this.baseline(new Date()); // successes that finish before the first check still count
    } catch (e) {
      this.d.log?.(`notification failed: ${(e as Error).message}`);
    }
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return !!this.timer;
  }

  /**
   * Successes older than the moment they were switched on are never told. While they are off, the
   * baseline follows the clock, so a success that finishes between "switched on" and the next check counts.
   */
  private baseline(now: Date, state = readState()): State {
    const cfg = this.ctx.config().notify;
    if (!hasChannel(cfg)) return state;
    const nowIso = now.toISOString();
    const age = now.getTime() - time(state.doneSince);
    if (!cfg.successes) {
      state.doneSince = nowIso;
      state.successesOn = false;
      writeState(state);
    } else if (!state.doneSince || state.successesOn !== true) {
      // Just switched on: keep the baseline of the last check, unless there was none lately (e.g. the server was down).
      if (state.successesOn !== false || !(age <= SWITCH_GRACE_MS)) state.doneSince = nowIso;
      state.successesOn = true;
      writeState(state);
    }
    // A summary time that is already past when it is first configured is not owed.
    if (cfg.daily_summary_at && !state.lastSummaryDay) {
      const m = minutesNow(this.d.timeZone, now);
      if (m.minutes < clockMinutes(cfg.daily_summary_at)) {
        state.lastSummaryDay = occurrenceDay(this.d.timeZone, now, cfg.daily_summary_at);
        writeState(state);
      }
    }
    return state;
  }

  async check(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.run(now);
    } catch (e) {
      this.d.log?.(`notification failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async run(now: Date) {
    const { ctx, d } = this;
    const cfg = ctx.config().notify;
    if (!hasChannel(cfg)) return;
    const tz = d.timeZone;
    const send = d.send ?? deliver;
    const state = this.baseline(now);
    const nowIso = now.toISOString();
    if (inQuietHours(cfg.quiet_hours, now, tz)) return;

    const turn = turnFor(ctx, now);
    const shownKeys = new Set(turn.data.groups.flatMap((g) => g.items).map((i) => i.key));
    const shown = turn.all.filter((i) => shownKeys.has(i.key));
    const fresh = shown.filter((i) => state.notified[i.key]?.stamp !== i.stamp);

    const briefs = ctx.scheduler.briefs();
    const doneRuns: { runId: string; finishedAt: string; item: NoticeItem }[] = [];
    if (cfg.successes) {
      const after = Math.max(time(state.doneSince), now.getTime() - DONE_WINDOW_MS);
      for (const b of briefs) {
        if (b.status !== "succeeded" || !b.finishedAt || time(b.finishedAt) <= after) continue;
        if (runOrigin(b.source) === "eval" || state.notified[`done|${b.runId}`]) continue;
        const run = ctx.scheduler.get(b.runId);
        if (!run) continue;
        const what = run.vars?.issue ? `${run.vars.github_repo}#${run.vars.issue}` : run.task.split("\n")[0] || run.flow;
        doneRuns.push({ runId: b.runId, finishedAt: b.finishedAt, item: { what, text: runMessage(ctx.config(), run), url: `${d.baseUrl}/#/runs/${b.runId}` } });
      }
    }

    if (state.lastSentAt && now.getTime() - time(state.lastSentAt) < cfg.throttle_minutes * 60_000) return;

    if (fresh.length || doneRuns.length) {
      const items: NoticeItem[] = fresh.map((i) => {
        const what = i.next.issue !== undefined ? `${i.repo}#${i.next.issue} ${i.what}` : i.what;
        const u = i.next.where.url;
        const url = u && /^https?:\/\//.test(u) ? u : u?.startsWith("#/") ? `${d.baseUrl}/${u}` : undefined;
        return { what, text: fit(what, i.next), url };
      });
      const notice = composeNotice(items, doneRuns.map((r) => r.item), { turn: `${d.baseUrl}/#/your-turn`, runs: `${d.baseUrl}/#/runs` });
      if (notice) {
        if ((await send(notice, cfg)) === false) {
          d.log?.(`notification not delivered: ${notice.title}`);
          return; // nothing is marked: the next check tries again
        }
        for (const i of fresh) state.notified[i.key] = { stamp: i.stamp, at: nowIso };
        for (const r of doneRuns) state.notified[`done|${r.runId}`] = { stamp: r.finishedAt, at: nowIso };
        const current = new Set([...turn.all.map((i) => i.key), ...doneRuns.map((r) => `done|${r.runId}`)]);
        for (const [k, e] of Object.entries(state.notified)) {
          if (!current.has(k) && now.getTime() - time(e.at) > KEEP_MS) delete state.notified[k];
        }
        state.lastSentAt = nowIso;
        writeState(state);
        d.log?.(`notification: ${notice.title}`);
        return;
      }
    }

    const at = cfg.daily_summary_at;
    const clock = minutesNow(tz, now);
    if (!at) return;
    // The most recent scheduled time; one that fell into quiet hours or the throttle is still owed.
    const owed = occurrenceDay(tz, now, at);
    if (state.lastSummaryDay === owed) return;
    const last = time(state.lastSummaryAt);
    const since = !Number.isNaN(last) && now.getTime() - last < DONE_WINDOW_MS ? last : now.getTime() - DAY;
    const stories = new Set<string>();
    let otherRuns = 0;
    for (const b of briefs) {
      if (b.status !== "succeeded" || !b.finishedAt || time(b.finishedAt) <= since || runOrigin(b.source) === "eval") continue;
      const run = ctx.scheduler.get(b.runId);
      if (!run) continue;
      if (run.vars?.github_repo && run.vars.issue) stories.add(`${run.vars.github_repo}#${run.vars.issue}`);
      else otherRuns++;
    }
    const release = turn.release && clock.minutes + turn.release.inMinutes < 1440 ? turn.release.at : undefined;
    const notice = summaryNotice(
      { stories: stories.size, otherRuns, waiting: turn.data.count, building: turn.building, releaseAt: release },
      `${d.baseUrl}/#/your-turn`,
    );
    if (notice) {
      if ((await send(notice, cfg)) === false) {
        d.log?.(`notification not delivered: ${notice.title}`);
        return; // the summary is tried again at the next check
      }
      state.lastSentAt = nowIso;
      d.log?.(`notification: ${notice.title}`);
    }
    state.lastSummaryDay = owed;
    state.lastSummaryAt = nowIso;
    writeState(state);
  }
}
