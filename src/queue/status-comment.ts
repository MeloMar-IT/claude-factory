import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunSummary } from "../engine/state.js";
import { errorLine } from "../errors.js";
import { FACTORY_HOME } from "../flow/load.js";
import { sameBody, STATUS_MARKER, upsertStatusComment } from "../github.js";
import { issueRank, issueRecord } from "../issue-record.js";
import { firstLine, nextStep, runNextStep, type NextBase, type NextData, type NextKind, type NextStep } from "../next-step.js";
import type { Scheduler } from "./scheduler.js";
import type { Hold, TrackedIssue } from "./watcher.js";

/** Kinds whose record for a watcher holds the administrator's wording: a comment on GitHub builds them again for a user. */
const LIMITED: readonly NextKind[] = ["daily_budget", "usage_limit", "failed"];

export const STATUS_NOTE = "_This comment is kept up to date by the Spaghetti Code Foundry. It is edited, never posted again. Other comments are history._";

/** A text that is safe in a comment: one line, no hidden comment markers, no mentions. */
export const plain = (t: string): string => t.replace(/\s+/g, " ").trim().replace(/<!--|-->/g, "").replace(/@(?=\w)/g, "@​");

const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const needsYou = (n: NextStep) => n.who === "You" || n.who === "Something is wrong";

/** Where to look, in words a reader of the issue understands: the app's pages are named, not linked. */
function whereText(n: NextStep, issueUrl: string): string {
  const { label, url } = n.where;
  if (url === issueUrl) return "this issue";
  if (/^https:\/\/[^\s()<>]+$/.test(url)) return `[${plain(label)}](${url})`;
  const run = /^#\/runs\/([\w-]+)$/.exec(url);
  if (run) return `the ${plain(label)} in the Foundry app (run \`${run[1]}\`)`;
  return `the ${plain(label)} in the Foundry app`;
}

/** The text of the status comment for a record. `issueUrl` is the issue's own address. */
export function statusBody(next: NextStep, issueUrl: string): string {
  let detail = plain(next.text);
  if (!needsYou(next)) {
    const prefix = `${next.why.replace(/[.!?]+$/, "")} — `;
    detail = upperFirst(plain(next.text.startsWith(prefix) ? next.text.slice(prefix.length) : next.text));
  }
  return [
    plain(firstLine(next)),
    "",
    detail,
    "",
    ...(next.until ? [`- **Continues:** ${plain(next.until)}`] : []),
    `- **Where:** ${whereText(next, issueUrl)}`,
    "",
    STATUS_NOTE,
    "",
    STATUS_MARKER,
  ].join("\n");
}

/** The last text of an issue the watcher no longer follows. */
export function leftBody(label: string): string {
  return [
    firstLine({ who: "Foundry", action: "", why: "The Foundry no longer follows this issue" }),
    "",
    `It is closed, or it no longer has the \`${label.replace(/`/g, "")}\` label (or it has a label the watcher skips).`,
    "",
    STATUS_NOTE,
    "",
    STATUS_MARKER,
  ].join("\n");
}

/** What one watcher saw in its last check. */
export interface StatusView {
  id: string;
  /** The trigger label. */
  label: string;
  failedLabel: string;
  tracked: TrackedIssue[];
  holds: Hold[];
  /** Closed issues the check handled (still busy, or tidied). */
  closed: { issue: number; title: string }[];
  /** The lists were whole: an issue that is not in them is gone. */
  complete: boolean;
  scheduler: Pick<Scheduler, "queue" | "get">;
  areaWait?: (run: RunSummary) => { runId: string; areas: string } | undefined;
  lastRunId: (issue: number) => string | undefined;
  /** "HH:MM" of the scheduled release a finished run waits for. */
  releaseAt?: (run: RunSummary) => string | undefined;
}

export interface StatusTarget {
  issue: number;
  body: string;
  /** Post a comment when the issue has none of ours. */
  create: boolean;
  /** It is the reader's move: write it first. */
  urgent: boolean;
  /** The issue is gone: this is its last text. */
  final: boolean;
  rank: number;
}

/** The text every issue should have now: one per issue, from the view that knows the most. */
export function statusTargets(repo: string, views: StatusView[], known: ReadonlyMap<number, { owners: string[] }>, all: boolean): StatusTarget[] {
  const best = new Map<number, StatusTarget>();
  for (const v of views) {
    const { pending, active } = v.scheduler.queue();
    const get = (id: string): RunSummary | undefined => {
      try {
        return v.scheduler.get(id);
      } catch {
        return undefined;
      }
    };
    const list: { issue: number; title: string; tracked?: TrackedIssue }[] = v.tracked.map((t) => ({ issue: t.issue, title: t.title, tracked: t }));
    const seen = new Set(list.map((x) => x.issue));
    for (const c of v.closed) if (!seen.has(c.issue)) seen.add(c.issue), list.push(c);
    if (all) for (const [n, k] of known) if (!seen.has(n) && k.owners.includes(v.id)) seen.add(n), list.push({ issue: n, title: "" });

    for (const { issue: n, title, tracked: t } of list) {
      const issueUrl = `https://github.com/${repo}/issues/${n}`;
      const data: NextData = { watched: true, issueUrl };
      const runId = t ? t.runId : pending.find((p) => p.githubRepo === repo && p.issue === String(n))?.runId ?? v.lastRunId(n);
      const run = runId ? get(runId) : undefined;
      const job = runId ? pending.find((p) => p.runId === runId) : undefined;
      const live = !!runId && (!!job || active.some((a) => a.runId === runId));
      const base: NextBase = { repo, issue: n, title, runId };
      const hold = v.holds.find((h) => h.issue === n);

      /** The record of a run, as `nextFor()` builds it for a user (no estimates). */
      const runRecord = (r: RunSummary): NextStep => {
        const pj = pending.find((p) => p.runId === r.runId);
        const rec = runNextStep(r, {
          queued: pj && { waitingFor: pj.waitingFor }, watched: true, failedLabel: v.failedLabel, title,
          areaWait: v.areaWait?.(r), releaseAt: r.status === "succeeded" ? v.releaseAt?.(r) : undefined, forUser: true,
        });
        if (pj || r.status === "running" || r.status === "waiting") {
          const closed = v.holds.find((h) => h.next.kind === "closed_elsewhere" && h.next.runId === r.runId);
          if (closed) return closed.next;
        }
        if (LIMITED.includes(rec.kind)) return rec;
        return v.holds.find((h) => h.next.runId === r.runId && h.next.kind === rec.kind)?.next ?? rec;
      };
      /** A hold of a limit or a failure carries the administrator's wording: build it again for a user. */
      const holdRecord = (h: Hold): NextStep => {
        if (!LIMITED.includes(h.next.kind)) return h.next;
        const hr = h.next.runId ? get(h.next.runId) : undefined;
        if (hr) {
          const rec = runRecord(hr);
          if (rec.kind === h.next.kind) return rec;
        }
        return nextStep(h.next.kind, { ...base, runId: h.next.runId }, { ...data, failedLabel: v.failedLabel, forUser: true, cause: h.next.cause });
      };

      const releases = run?.status === "succeeded" && !!v.releaseAt?.(run);
      let cand: StatusTarget;
      if (t || live || hold || releases) {
        const next = live && !run && !job
          ? nextStep("running", base, data) // a run that just started has no file yet
          : issueRecord({ base, data, run, live, queuedJob: job, hold: hold && holdRecord(hold), done: t?.done, nextOf: runRecord }).next;
        cand = { issue: n, body: statusBody(next, issueUrl), create: !!t, urgent: needsYou(next), final: false, rank: issueRank(live, !!t?.done) };
      } else {
        const finished = run?.status === "succeeded" && run.history.at(-1)?.id !== "create_split";
        cand = { issue: n, body: finished ? statusBody(nextStep("done", base, data), issueUrl) : leftBody(v.label), create: false, urgent: false, final: true, rank: 3 };
      }
      const have = best.get(n);
      if (!have || cand.rank < have.rank) best.set(n, cand);
    }
  }
  return [...best.values()];
}

export const MAX_PER_CHECK = 30;
export const MAX_MS = 60_000;
export const MAX_FAILURES = 3;
export const GH_TIMEOUT_MS = 15_000;

/** The file that remembers which issues have a status comment (issue numbers only), across restarts. */
export const statusFile = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "status-comments.json");

type FileData = Record<string, Record<string, number[]>>;
interface Known { id?: string; body?: string; owners: string[] }

/** A missing, broken or oddly shaped file reads as empty. */
function readFileData(file: string): FileData {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!d || typeof d !== "object" || Array.isArray(d)) return {};
    for (const repo of Object.values(d as object)) {
      if (!repo || typeof repo !== "object" || Array.isArray(repo)) return {};
      for (const nums of Object.values(repo as object)) {
        if (!Array.isArray(nums) || !nums.every((n) => Number.isInteger(n) && n > 0)) return {};
      }
    }
    return d as FileData;
  } catch {
    return {};
  }
}

/**
 * The status comments of one repository: one writer shared by its watchers. Each watcher reports what it
 * saw; passes run one after another and bring GitHub in line.
 */
export class StatusComments {
  private known = new Map<number, Known>();
  private views = new Map<string, StatusView>();
  private expected: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private login?: string;
  private saved: string;
  private maxMs: number;

  constructor(private repo: string, private log: (msg: string) => void, private o: { file?: string; maxMs?: number } = {}) {
    this.maxMs = o.maxMs ?? MAX_MS;
    if (o.file) {
      for (const [id, nums] of Object.entries(readFileData(o.file)[repo] ?? {})) {
        for (const n of nums) {
          const k = this.known.get(n);
          if (k) k.owners.push(id);
          else this.known.set(n, { owners: [id] });
        }
      }
    }
    this.saved = this.entryText();
  }

  /** A watcher that will report (so issues are not called gone before it did). */
  expect(watcherId: string): void {
    if (!this.expected.includes(watcherId)) this.expected.push(watcherId);
    this.views.delete(watcherId);
  }

  /** The watcher stopped: drops its view and the issues only it followed. */
  forget(watcherId: string): void {
    this.views.delete(watcherId);
    this.expected = this.expected.filter((x) => x !== watcherId);
    this.chain = this.chain.then(() => {
      for (const [n, k] of this.known) {
        k.owners = k.owners.filter((x) => x !== watcherId);
        if (!k.owners.length) this.known.delete(n);
      }
      this.persist();
    }).catch(() => {});
  }

  /** Stores the watcher's view, then brings GitHub in line. One pass at a time. Never throws. */
  report(watcherId: string, view: StatusView, alive: () => boolean = () => true): Promise<void> {
    // A watcher that was stopped or replaced meanwhile must not overwrite its successor's view.
    if (!alive()) return this.chain;
    this.views.set(watcherId, view);
    const p = this.chain.then(() => this.pass(alive)).catch((e: Error) => this.log(`! status comments: ${errorLine(e.message)}`));
    this.chain = p;
    return p;
  }

  private entry(): Record<string, number[]> {
    const out: Record<string, number[]> = Object.create(null); // watcher ids like "constructor" are plain keys here
    for (const [n, k] of [...this.known].sort((a, b) => a[0] - b[0])) for (const o of k.owners) (out[o] ??= []).push(n);
    return out;
  }
  private entryText = () => JSON.stringify(this.entry());

  /** Writes this repository's entry when it changed: read the file again, replace the entry, temp file, rename. */
  private persist(): void {
    const file = this.o.file;
    if (!file) return;
    const text = this.entryText();
    if (text === this.saved) return;
    try {
      const all = readFileData(file);
      const entry = this.entry();
      if (Object.keys(entry).length) all[this.repo] = entry;
      else delete all[this.repo];
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2));
      renameSync(tmp, file);
      this.saved = text;
    } catch (e) {
      this.log(`! status comments: could not write ${file}: ${errorLine((e as Error).message)}`);
    }
  }

  private async pass(alive: () => boolean): Promise<void> {
    try {
      await this.run(alive);
    } finally {
      this.persist();
    }
  }

  private async run(alive: () => boolean): Promise<void> {
    const expected = new Set(this.expected);
    const views = this.expected.map((id) => this.views.get(id)).filter((v): v is StatusView => !!v);
    const owners = new Map<number, string[]>();
    for (const v of views) {
      for (const n of new Set([...v.tracked.map((t) => t.issue), ...v.closed.map((c) => c.issue)])) owners.set(n, [...(owners.get(n) ?? []), v.id]);
    }
    for (const [n, k] of this.known) {
      k.owners = owners.get(n) ?? k.owners.filter((o) => expected.has(o));
      if (!k.owners.length) this.known.delete(n);
    }
    const all = this.expected.every((id) => this.views.get(id)?.complete);
    const targets = statusTargets(this.repo, views, this.known, all);
    const work = targets
      .filter((t) => (this.known.has(t.issue) || t.create) && !sameBody(this.known.get(t.issue)?.body, t.body))
      .sort((a, b) => Number(b.urgent) - Number(a.urgent) || Number(a.final) - Number(b.final) || a.issue - b.issue);

    const deadline = Date.now() + this.maxMs;
    let failures = 0;
    for (const [i, t] of work.entries()) {
      if (!alive()) return;
      if (i >= MAX_PER_CHECK || Date.now() >= deadline || failures >= MAX_FAILURES) {
        this.log(`status comments: ${work.length - i} more at the next check`);
        break;
      }
      const have = this.known.get(t.issue);
      try {
        const r = await upsertStatusComment(this.repo, t.issue, t.body, { id: have?.id, create: t.create, timeoutMs: GH_TIMEOUT_MS, deadline, login: this.login });
        this.login = r.login ?? this.login;
        if (t.final) this.known.delete(t.issue);
        else this.known.set(t.issue, { id: r.left > 0 ? undefined : r.id, body: r.left > 0 ? undefined : t.body, owners: owners.get(t.issue) ?? have?.owners ?? [] });
        if (r.changed) this.log(`#${t.issue} status comment ${r.created ? "created" : "updated"}`);
        if (r.removed) this.log(`#${t.issue} removed ${r.removed} extra status comment(s)`);
        if (r.left) this.log(`! status comment #${t.issue}: ${r.left} extra could not be removed`);
      } catch (e) {
        if (Date.now() >= deadline) {
          this.log(`status comments: ${work.length - i} more at the next check`);
          break;
        }
        this.log(`! status comment #${t.issue}: ${errorLine((e as Error).message)}`);
        if (have) have.id = undefined; // the next check reads the comments again
        failures++;
      }
    }
    for (const t of targets) if (t.final && this.known.has(t.issue) && sameBody(this.known.get(t.issue)?.body, t.body)) this.known.delete(t.issue);
  }
}
