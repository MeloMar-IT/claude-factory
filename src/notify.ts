import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { withScfAliases } from "./engine/template.js";
import type { Config } from "./config.js";
import type { RunSummary } from "./engine/state.js";
import { releaseAtFor, runNextStep, trackingWatcher, type NextStep } from "./next-step.js";
import { labelNames } from "./queue/watcher.js";

export function runMessage(config: Config, s: RunSummary): string {
  const what = s.vars.issue ? `${s.vars.github_repo}#${s.vars.issue}` : s.task.split("\n")[0] || s.flow;
  const w = trackingWatcher(config.watchers, s);
  const next = runNextStep(s, { watched: !!w, failedLabel: w && labelNames(w).failed, releaseAt: releaseAtFor(config.watchers, s) });
  return fit(what, next);
}

const MAX_MESSAGE = 300;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

/** "<what> — <why> — <what to do>." in at most 300 characters; only what and why are shortened, never the action. */
export function fit(what: string, next: NextStep): string {
  const tail = next.text.slice(next.why.length).replace(/\s+/g, " "); // " — <what to do>."
  const room = MAX_MESSAGE - tail.length - 3; // 3: the " — " after what
  if (room < 0) return flat(next.text).slice(0, MAX_MESSAGE);
  const w = flat(what);
  const why = flat(next.why);
  const whyLen = Math.min(why.length, Math.max(0, room - Math.min(w.length, 20)));
  return `${cut(w, room - whyLen)} — ${cut(why, whyLen)}${tail}`.slice(0, MAX_MESSAGE);
}

export interface Notice {
  title: string;
  message: string;
  /** Opened by a click (http or https only). */
  url?: string;
}

/** One line of a notice: the name of the thing, its full text and where it lives. */
export interface NoticeItem {
  what: string;
  text: string;
  url?: string;
}

type Quiet = { from: string; to: string } | undefined;

/** Minutes since midnight and the date ("YYYY-MM-DD") on the clock of `timeZone` (default: this machine's). */
export function minutesNow(timeZone: string | undefined, now: Date): { minutes: number; day: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { minutes: Number(p.hour) * 60 + Number(p.minute), day: `${p.year}-${p.month}-${p.day}` };
}

export const clockMinutes = (t: string): number => {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
};

/** Is `now` inside the quiet hours? The window may cross midnight; from === to is never quiet. */
export function inQuietHours(q: Quiet, now: Date, timeZone?: string): boolean {
  if (!q) return false;
  const from = clockMinutes(q.from), to = clockMinutes(q.to);
  if (from === to) return false;
  const m = minutesNow(timeZone, now).minutes;
  return from < to ? m >= from && m < to : m >= from || m < to;
}

const names = (list: NoticeItem[]): string => {
  const first = list.slice(0, 3).map((i) => cut(flat(i.what), 60)).join("; ");
  return list.length > 3 ? `${first} and ${list.length - 3} more` : first;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** One grouped notice for what waits for the user and (when switched on) what succeeded. Undefined when both are empty. */
export function composeNotice(turn: NoticeItem[], done: NoticeItem[], pages: { turn: string; runs: string }): Notice | undefined {
  if (!turn.length && !done.length) return undefined;
  const fin = (n: Notice): Notice => ({ ...n, message: cut(n.message, MAX_MESSAGE) });
  if (turn.length === 1 && !done.length) return fin({ title: "Foundry · your turn", message: turn[0]!.text, url: turn[0]!.url ?? pages.turn });
  if (!turn.length && done.length === 1) return fin({ title: "Foundry · run succeeded", message: done[0]!.text, url: done[0]!.url ?? pages.runs });
  if (!turn.length) return fin({ title: `Foundry · ${done.length} runs succeeded`, message: names(done), url: pages.runs });
  const also = done.length ? ` Also: ${done.length} ${plural(done.length, "run", "runs")} succeeded.` : "";
  const message = cut(names(turn), MAX_MESSAGE - also.length) + also;
  return {
    title: turn.length === 1 ? "Foundry · 1 thing needs you" : `Foundry · ${turn.length} things need you`,
    message,
    url: turn.length === 1 ? (turn[0]!.url ?? pages.turn) : pages.turn,
  };
}

export interface SummaryFacts {
  stories: number;
  otherRuns: number;
  waiting: number;
  building: number;
  releaseAt?: string;
}

/** The daily summary: done since yesterday, waiting for you, expected today. Undefined when there is nothing to say. */
export function summaryNotice(f: SummaryFacts, pageUrl: string): Notice | undefined {
  if (!f.stories && !f.otherRuns && !f.waiting && !f.building && !f.releaseAt) return undefined;
  const done: string[] = [];
  if (f.stories) done.push(`${f.stories} ${plural(f.stories, "story", "stories")}`);
  if (f.otherRuns) done.push(f.stories ? `${f.otherRuns} other ${plural(f.otherRuns, "run", "runs")}` : `${f.otherRuns} ${plural(f.otherRuns, "run", "runs")}`);
  const expected: string[] = [];
  if (f.building) expected.push(`${f.building} ${plural(f.building, "story", "stories")} being built`);
  if (f.releaseAt) expected.push(`release pull request around ${f.releaseAt}`);
  return {
    title: "Foundry · daily summary",
    message: `Done since yesterday: ${done.join(", ") || "nothing"}. Waiting for you: ${f.waiting || "nothing"}. Expected today: ${expected.join(", ") || "nothing yet"}.`,
    url: pageUrl,
  };
}

const q = (t: string) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const isHttp = (u: string | undefined): u is string => !!u && /^https?:\/\//.test(u);

/** The programs to try, in order, to show a desktop notification. */
export function desktopCommands(n: Notice): { cmd: string; args: string[] }[] {
  const message = /^[[(<-]/.test(n.message) ? `\\${n.message}` : n.message;
  const tn = ["-title", n.title, "-message", message];
  if (isHttp(n.url)) tn.push("-open", n.url);
  return [
    { cmd: "terminal-notifier", args: tn },
    { cmd: "osascript", args: ["-e", `display notification ${q(n.message)} with title ${q(n.title)}`] },
  ];
}

export type Runner = (cmd: string, args: string[]) => Promise<"ok" | "failed">;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((r) => execFile(cmd, args, { timeout: 10_000 }, (err) => r(err ? "failed" : "ok")));

/** Shows a desktop notification; goes on to the next program when one fails. */
export async function sendDesktop(n: Notice, run: Runner = defaultRunner): Promise<boolean> {
  for (const c of desktopCommands(n)) if ((await run(c.cmd, c.args)) === "ok") return true;
  return false;
}

/** Is `terminal-notifier` on the PATH (so a click can open the item)? */
export function clickThrough(): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "terminal-notifier"), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Posts to Slack; true when Slack answered with success. Never throws. */
export async function sendSlack(webhook: string, n: Notice): Promise<boolean> {
  const link = n.url && /^https?:\/\/[^\s<>|]+$/.test(n.url) ? `\n<${n.url}|Open>` : "";
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `*${esc(n.title)}*\n${esc(n.message)}${link}` }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false; // a failing webhook must not stop anything
  }
}

type NotifyConfig = Config["notify"];

/** Is a channel for notices (macOS or Slack) switched on here? */
export function hasChannel(n: NotifyConfig): boolean {
  return (n.macos && process.platform === "darwin") || !!n.slack_webhook;
}

/** Sends a notice through the macOS and Slack channels. True when at least one channel got it. Never throws. */
export async function deliver(n: Notice, cfg: NotifyConfig): Promise<boolean> {
  const jobs: Promise<boolean>[] = [];
  if (cfg.macos && process.platform === "darwin") jobs.push(sendDesktop(n).catch(() => false));
  if (cfg.slack_webhook) jobs.push(sendSlack(cfg.slack_webhook, n));
  return (await Promise.all(jobs)).some(Boolean);
}

/** Runs the notify command for a finished run. macOS and Slack are sent by the server (see TurnNotifier). Never throws. */
export async function notifyRun(config: Config, s: RunSummary): Promise<void> {
  if (process.env.FACTORY_NO_NOTIFY === "1") return;
  const n = config.notify;
  if (s.status === "running" || !n.command || !n.on.includes(s.status)) return;
  const msg = runMessage(config, s);
  await new Promise((r) => {
    const child = spawn("/bin/sh", ["-c", n.command!], {
      stdio: "ignore",
      env: withScfAliases({
        ...process.env,
        FACTORY_EVENT: "run.finished",
        FACTORY_RUN_ID: s.runId,
        FACTORY_FLOW: s.flow,
        FACTORY_STATUS: s.status,
        FACTORY_MESSAGE: msg,
      }),
    });
    child.on("close", r);
    child.on("error", r);
  });
}
