import { watcherOwner } from "../auth/run-owner.js";
import type { WatcherConfig } from "../config.js";
import { loadRun, saveRun, spentToday, type RunSummary } from "../engine/state.js";
import { errorLine, explainError } from "../errors.js";
import { loadFlow } from "../flow/load.js";
import { canWrite, commentsAfter, ensureLabel, gh, ghJson, isBot, isStatusComment, issueComments, setLabels, type Comment, type Issue } from "../github.js";
import { failedIndex, failureSummary } from "../failure.js";
import { countQuestions, firstLine, releaseAtFor, runClosedIssue, LIMIT_RETRY_MS, nextStep, runNextStep, type NextData, type BlockerInfo, type NextKind, type NextStep } from "../next-step.js";
import { LABEL_WORDS } from "../words.js";
import { dependencies, openDependencies } from "./deps.js";
import type { Scheduler } from "./scheduler.js";
import { StatusComments } from "./status-comment.js";

/** Status labels the watcher puts on issues. Remove one to have the issue picked up again. */
export const STATUS_LABELS = {
  working: { name: "factory:working", color: "1d4ed8", description: LABEL_WORDS.working },
  done: { name: "factory:done", color: "15803d", description: LABEL_WORDS.done },
  needsInfo: { name: "factory:needs-info", color: "d97706", description: LABEL_WORDS.needsInfo },
  waiting: { name: "factory:waiting-approval", color: "7c3aed", description: LABEL_WORDS.waiting },
  failed: { name: "factory:failed", color: "b91c1c", description: LABEL_WORDS.failed },
} as const;
type LabelKey = keyof typeof STATUS_LABELS;
type LabelNames = Record<LabelKey, string>;

/** Status label names for a watcher: its own names where set, factory:* otherwise. */
export function labelNames(cfg: WatcherConfig): LabelNames {
  const o = cfg.status_labels ?? {};
  return {
    working: o.working ?? STATUS_LABELS.working.name,
    done: o.done ?? STATUS_LABELS.done.name,
    needsInfo: o.needs_info ?? STATUS_LABELS.needsInfo.name,
    waiting: o.waiting ?? STATUS_LABELS.waiting.name,
    failed: o.failed ?? STATUS_LABELS.failed.name,
  };
}

/**
 * The failure comment on an issue: what to do first, then what happened and why, then the raw text under Details.
 * `factoryWhat` (the record's "The Foundry failed, not the code: …") is set when the Foundry itself failed:
 * the first line says so and it replaces the What and Why lines.
 */
export function failureComment(s: RunSummary, next: NextStep): string {
  const factory = next.cause === "factory";
  const e = explainError(s.reason);
  const sum = next.failure ?? failureSummary(s, { watched: true });
  const hist = Array.isArray(s.history) ? s.history : [];
  const failed = hist[failedIndex(hist)];
  const tail = (failed?.output || failed?.error || "").trim().slice(-3000);
  const raw = [e.detail, tail].filter(Boolean).join("\n\n");
  return [
    firstLine(next),
    "",
    factory ? "🤖 **Spaghetti Code Foundry** itself failed on this issue, not the code." : "🤖 **Spaghetti Code Foundry** could not finish this issue.",
    "",
    `- **What happened:** ${sum.what.replace(/[.!?]+$/, "")}.`,
    `- **Why:** ${sum.why}`,
    `- **Kind of problem:** ${sum.kind}`,
    `- **Already tried:** ${sum.tried.replace(/[.!?]+$/, "")}.`,
    ...(sum.byModel ? ["", "_(A model read the output of the failing step to write the Why line. It can be wrong; the raw text is under Details.)_"] : []),
    "",
    "**Your options**",
    ...sum.options.map((o) => `- ${o}`),
    failed ? `\nLast failing step: \`${failed.id}\`${failed.visit > 1 ? ` (attempt ${failed.visit})` : ""}` : "",
    raw ? `\n<details><summary>Details</summary>\n\n\`\`\`\n${raw.replace(/`{3,}/g, (m) => "ˋ".repeat(m.length))}\n\`\`\`\n</details>` : "",
    `\n<!-- claude-factory run=${s.runId} -->`,
  ].join("\n");
}

/** Flow each source runs when the watcher doesn't name one. */
export const DEFAULT_FLOWS: Partial<Record<WatcherConfig["source"], string>> = {
  issues: "issue-gitflow",
  schedule: "release-daily",
  // pr-feedback and ci-failures have no shipped flow any more: such a watcher names its own.
};

/** "5m" | "30s" | "1h" | "7d" | "10" (minutes) → ms. */
export function parseInterval(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(text.trim());
  if (!m) throw new Error(`invalid interval "${text}" (use e.g. 30s, 5m, 1h, 7d)`);
  const n = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? "m") as "s" | "m" | "h" | "d"];
  if (n > 2_000_000_000) throw new Error("interval must be at most 23 days");
  if (n < 10_000) throw new Error("interval must be at least 10s");
  return n;
}

export interface WatcherDeps {
  scheduler: Scheduler;
  runsDir: string;
  /** Local dir used to look up flows by name. */
  repo: string;
  dailyBudget?: () => number | undefined;
  /** Is this running run waiting for a code area? (reads the step log) */
  areaWait?: (run: RunSummary) => { runId: string; areas: string } | undefined;
  log: (msg: string) => void;
  /** Shared by the watchers of one repository (the manager sets it). */
  statusComments?: StatusComments;
  /** Every watcher's config, to find the scheduled release of a finished run. */
  watchers?: () => WatcherConfig[];
  /** Called after every check, good or failed (the monitor's request-limit reading). A rejection is ignored. */
  afterCheck?: () => Promise<void> | void;
}

export interface WatcherStatus {
  id: string;
  lastTick?: string;
  /** End of the last check that finished without an error. */
  lastOk?: string;
  /** When the watcher was started (for the stale check, before its first check). */
  startedAt?: string;
  nextTick?: string;
  lastError?: string;
  lastActions: string[];
  /** Why issues with the trigger label are not being started right now (rebuilt every check). */
  holds?: Hold[];
  /** Since when the checks fail (kept while they keep failing). */
  errorSince?: string;
  /** How many checks in a row failed (kept while they keep failing). */
  errorCount?: number;
  /** The pull request that pauses new work (pause_while_pr_open). */
  pausedBy?: { number: number; url?: string; title?: string; createdAt?: string };
}

export interface Hold {
  issue?: number;
  title?: string;
  /** The record's one sentence. */
  reason: string;
  /** Link to what it waits for (e.g. the release pull request). */
  url?: string;
  next: NextStep;
  /** A time from GitHub (comment, pull request); the same after a restart. */
  since?: string;
  /** When this server first saw the hold; starts again after a restart. */
  seen?: string;
}

const holdKey = (h: Hold) => `${h.issue ?? ""}|${h.next.kind}|${h.next.runId ?? ""}`;

/** A hold carries its record; reason and url come from it. */
export function toHold(next: NextStep): Hold {
  return { issue: next.issue, title: next.title || undefined, reason: next.text, url: next.where.url, next };
}

/** Every non-excluded issue a tick saw. */
export interface TrackedIssue { issue: number; title: string; runId?: string; done?: boolean }

const APPROVE_RE = /^\s*\/(approve|reject)\b[ \t]*(.*)$/im;

/** Stopped for a reason that clears by itself: daily budget, or a `wait_*` step (e.g. waiting for a PR merge). */
/** Stepped aside for a busy code area (stopped at wait_for_area): the run that holds the area. */
export function steppedAsideFor(s: RunSummary): string | undefined {
  if (s.status !== "stopped" || !/stopped at step "(?:[\w-]+\/)*wait_for_area"/.test(s.reason ?? "")) return undefined;
  const out = [...s.history].reverse().find((h) => h.id === "claim_areas")?.output ?? "";
  return /^waiting for run (\S+) \(/m.exec(out)?.[1];
}

function isPaused(s: RunSummary): boolean {
  return /daily budget|usage limit reached|signed out —|stopped at step "(?:[\w-]+\/)*wait_/.test(s.reason ?? "");
}

/** Usage limits reset after a while; try a limited run again at most every 30 minutes. */
export { LIMIT_RETRY_MS };
function retryLimitAfter(s: RunSummary): boolean {
  return Date.now() - new Date(s.finishedAt ?? s.startedAt).getTime() >= LIMIT_RETRY_MS;
}

function labelFor(s: RunSummary, L: LabelNames): string {
  switch (s.status) {
    case "succeeded": return L.done;
    case "waiting": return L.waiting;
    case "stopped": return isPaused(s) ? L.working : L.needsInfo;
    case "running": return L.working;
    default: return /interrupted/.test(s.reason ?? "") ? L.working : L.failed;
  }
}

/** Minutes since midnight in a time zone (default: this machine's). */
export function minutesNow(timeZone?: string, now = new Date()): { day: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Polls one GitHub repo and turns tickets / PR comments into runs. */
export class Watcher {
  status: WatcherStatus;
  /** Issues the last tick saw (for the next-step records). */
  tracked: TrackedIssue[] = [];
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickToken = 0;
  /** A check that takes longer is given up, so "Check now" and the next check work again (gh has no timeout). */
  checkTimeoutMs = 10 * 60_000;
  private kickAgain = false;
  private setupDone = false;
  private stopped = false;
  /** Runs whose end will set the label (so a run is waited for once). */
  private waitingFor = new Set<string>();

  private L: LabelNames;
  private allStatus: string[];
  private statusComments: StatusComments;

  constructor(public cfg: WatcherConfig, private d: WatcherDeps) {
    this.status = { id: cfg.id, lastActions: [] };
    this.L = labelNames(cfg);
    this.allStatus = Object.values(this.L);
    this.statusComments = d.statusComments ?? new StatusComments(cfg.github_repo, (m) => d.log(`[${cfg.id}] ${m}`));
    if (cfg.source === "issues" && cfg.status_comment) this.statusComments.expect(cfg.id);
  }

  private get repo() {
    return this.cfg.github_repo;
  }

  private flowName() {
    // "default" (the schema default) means the source's own flow.
    if (this.cfg.flow !== "default") return this.cfg.flow;
    const f = DEFAULT_FLOWS[this.cfg.source];
    if (!f) throw new Error(`a ${this.cfg.source} watcher must name its flow (there is no default for it)`);
    return f;
  }

  start() {
    this.stopped = false;
    this.status.startedAt = new Date().toISOString();
    const loop = async () => {
      await this.tick();
      if (this.stopped) return;
      let every: number;
      try {
        every = parseInterval(this.cfg.every);
      } catch {
        return; // tick() reported the invalid interval as the watcher's error
      }
      this.status.nextTick = new Date(Date.now() + every).toISOString();
      this.timer = setTimeout(loop, every);
    };
    void loop();
  }

  /** Stop polling. Runs keep going; their labels are reconciled on the next start. */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.status.nextTick = undefined;
  }

  private act(msg: string) {
    this.d.log(`[${this.cfg.id}] ${msg}`);
    this.status.lastActions = [`${new Date().toLocaleTimeString()} ${msg}`, ...this.status.lastActions].slice(0, 20);
  }

  private async setup() {
    if (this.setupDone) return;
    await gh(["repo", "view", this.repo, "--json", "nameWithOwner"]).catch((e: Error) => {
      throw new Error(`cannot access ${this.repo} with gh: ${errorLine(e.message)}`);
    });
    if (this.cfg.source === "issues") {
      const review = this.cfg.vars.review_plan_label ?? "";
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase(); // GitHub label names ignore case
      const both = same(review, this.cfg.label); // one label starts the work and asks for a plan check
      await ensureLabel(this.repo, this.cfg.label, "c2410c", both ? LABEL_WORDS.triggerReview : LABEL_WORDS.trigger);
      for (const [k, l] of Object.entries(STATUS_LABELS)) await ensureLabel(this.repo, this.L[k as LabelKey], l.color, l.description);
      if (review.trim() && !both) {
        if (this.allStatus.some((s) => same(s, review))) this.act(`label ${review} is the review label and a status label — it keeps the status description`);
        else await ensureLabel(this.repo, review, "0e7490", LABEL_WORDS.review);
      }
    }
    loadFlow(this.flowName(), this.d.repo); // fail early on a missing flow
    this.setupDone = true;
  }

  /** Check now (e.g. a run just finished): no human needed means no waiting for the next interval. */
  kick() {
    if (this.stopped) return;
    if (this.ticking) this.kickAgain = true;
    else void this.tick();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const token = ++this.tickToken;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the check took longer than ${Math.round(this.checkTimeoutMs / 1000)}s and was given up`)), this.checkTimeoutMs);
        }),
      ]);
      if (token === this.tickToken) {
        this.status.lastError = undefined;
        this.status.errorSince = undefined;
        this.status.errorCount = undefined;
        this.status.lastOk = new Date().toISOString();
      }
    } catch (e) {
      this.status.lastError = errorLine((e as Error).message);
      this.status.errorSince ??= new Date().toISOString();
      this.status.errorCount = (this.status.errorCount ?? 0) + 1;
      this.d.log(`[${this.cfg.id}] ! ${this.status.lastError}`);
    } finally {
      clearTimeout(timer);
      this.status.lastTick = new Date().toISOString();
      try {
        await this.d.afterCheck?.();
      } catch {
        // the hook must not change the outcome of a check
      }
      this.ticking = false;
      if (this.kickAgain && !this.stopped) {
        this.kickAgain = false;
        setTimeout(() => void this.tick(), 0);
      }
    }
  }

  /** One check; throws when it fails. */
  private async check() {
    parseInterval(this.cfg.every);
    await this.setup();
    if (this.cfg.source === "issues") await this.tickIssues();
    else if (this.cfg.source === "pr-feedback") await this.tickPrs();
    else if (this.cfg.source === "ci-failures") await this.tickCi();
    else await this.tickSchedule();
  }

  /** Latest run per issue/PR number for this repo (newest first in the list). */
  /**
   * A run that stepped aside for a code area is resumed only when the run that holds the area no
   * longer works. Resuming sooner only stops again — and when every stop makes the watchers check
   * again, that is an endless loop of checks that uses up GitHub's request limit.
   */
  private areaMayBeFree(run: RunSummary): boolean {
    const holder = steppedAsideFor(run);
    if (!holder) return true;
    try {
      return loadRun(this.d.runsDir, holder)?.status !== "running";
    } catch {
      return true; // the holder's run is gone: its area is free
    }
  }

  private latestRuns(key: "issue" | "pr", anyFlow = false): Map<string, RunSummary> {
    const m = new Map<string, RunSummary>();
    for (const s of this.d.scheduler.list(1000)) {
      if (s.vars?.github_repo !== this.repo || !s.vars[key]) continue;
      if (!anyFlow && s.flow !== this.flowName()) continue; // e.g. a plan watcher and a code watcher on the same issues
      if (!m.has(s.vars[key]!)) m.set(s.vars[key]!, s);
    }
    return m;
  }

  private budgetLeft(): boolean {
    const cap = this.d.dailyBudget?.();
    return cap === undefined || spentToday(this.d.runsDir) < cap;
  }

  /** Newest runs this watcher's repo has with var `key` set (newest first). */
  private runsWith(key: string): RunSummary[] {
    return this.d.scheduler.list(1000).filter((s) => s.vars?.github_repo === this.repo && s.vars[key]);
  }

  /**
   * The latest finished run of each workflow on the watched branch; a failed one gets a
   * ci-fix run (once per CI run). A workflow that went green again is left alone.
   */
  private async tickCi() {
    const branch = this.cfg.branch ?? (await ghJson<{ defaultBranchRef: { name: string } }>(["repo", "view", this.repo, "--json", "defaultBranchRef"])).defaultBranchRef.name;
    const ciRuns = await ghJson<{ databaseId: number; workflowName: string; status: string; conclusion: string; headSha: string; url: string }[]>(
      ["run", "list", "--repo", this.repo, "--branch", branch, "--limit", "40", "--json", "databaseId,workflowName,status,conclusion,headSha,url"]);
    const handled = new Set(this.runsWith("ci_run").map((s) => s.vars.ci_run));
    const seen = new Set<string>();
    let started = 0;
    for (const r of ciRuns) {
      if (r.status !== "completed" || seen.has(r.workflowName)) continue;
      seen.add(r.workflowName);
      if (r.conclusion !== "failure" || handled.has(String(r.databaseId))) continue;
      const lockKey = `${this.repo}#ci:${r.workflowName}`;
      if (this.d.scheduler.isLocked(lockKey) || started >= this.cfg.max_per_tick || !this.budgetLeft()) continue;
      const { flow } = loadFlow(this.flowName(), this.d.repo);
      const runId = this.queue({
        kind: "run", flow, repo: this.d.repo,
        task: `Fix failing CI: ${r.workflowName} on ${branch} (${r.headSha.slice(0, 7)})`,
        vars: { ...this.cfg.vars, github_repo: this.repo, ci_run: String(r.databaseId), ci_workflow: r.workflowName, ci_sha: r.headSha, ci_url: r.url },
      }, { lockKey, source: `watcher ${this.cfg.id} ci ${r.workflowName}` });
      this.act(`CI “${r.workflowName}” is red on ${branch} → run ${runId}`);
      started++;
    }
  }

  /** Run the chore when the last one started at least `every` ago (survives restarts). */
  private async tickSchedule() {
    const last = this.d.scheduler.list(1000).find((s) => s.vars?.chore_watcher === this.cfg.id);
    if (this.cfg.at) {
      // Once a day at `at` (caught up later that day if the Mac was off at that time).
      const now = minutesNow(this.cfg.timezone);
      const [hh, mm] = this.cfg.at.split(":").map(Number) as [number, number];
      if (now.minutes < hh * 60 + mm) return;
      if (last && minutesNow(this.cfg.timezone, new Date(last.startedAt)).day === now.day) return;
    } else {
      const every = parseInterval(this.cfg.every);
      // 5% slack so timer jitter doesn't skip a whole period.
      if (last && Date.now() - new Date(last.startedAt).getTime() < every * 0.95) return;
    }
    const lockKey = `${this.repo}#chore:${this.cfg.id}`;
    if (this.d.scheduler.isLocked(lockKey) || !this.budgetLeft()) return;
    const { flow } = loadFlow(this.flowName(), this.d.repo);
    const runId = this.queue({
      kind: "run", flow, repo: this.d.repo, task: this.cfg.task ?? "",
      vars: { ...this.cfg.vars, github_repo: this.repo, chore_watcher: this.cfg.id },
    }, { lockKey, source: `watcher ${this.cfg.id} schedule` });
    this.act(`scheduled chore → run ${runId}`);
  }

  /** Every run a watcher starts goes through here: a new run belongs to the watcher's owner; a resume keeps the run's own. */
  private queue(job: Parameters<Scheduler["submit"]>[0], meta: { lockKey?: string; source?: string }): string {
    return this.d.scheduler.submit(job, { ...meta, ...(job.kind === "run" ? { owner: watcherOwner(this.cfg.owner) } : {}) });
  }

  private submit(n: number, kind: "issue" | "pr", job: Parameters<Scheduler["submit"]>[0]): string {
    return this.queue(job, { lockKey: kind === "issue" ? this.lockFor(n) : `${this.repo}#${n}`, source: `watcher ${this.cfg.id} ${kind} #${n}` });
  }

  /** Update labels when a run we started finishes (the next tick would also reconcile). */
  private labelWhenDone(issue: number, runId: string) {
    if (this.waitingFor.has(runId)) return;
    this.waitingFor.add(runId);
    void this.d.scheduler.wait(runId).then(async (s) => {
      this.waitingFor.delete(runId);
      if (!s || this.stopped) return;
      // Cancelled while the issue is closed: clear the labels, no failure comment.
      if (s.status === "cancelled" && (await this.issueClosed(issue))) {
        await setLabels(this.repo, issue, undefined, this.allStatus).catch(() => {});
        this.act(`#${issue} (closed) → cancelled · label → none`);
        return;
      }
      // A split original was closed in favour of its parts: clear its labels, don't mark it done.
      const split = s.status === "succeeded" && s.history.at(-1)?.id === "create_split";
      const label = split ? undefined : labelFor(s, this.L);
      const remove = s.status === "succeeded" ? [...this.allStatus, ...this.cfg.remove_on_done] : this.allStatus;
      await setLabels(this.repo, issue, label, remove).catch(() => {});
      if (label === this.L.failed && this.cfg.comment_on_failure) await this.commentFailure(issue, s).catch(() => {});
      const why = s.reason ? explainError(s.reason) : undefined;
      this.act(`#${issue} → ${s.status}${why ? ` (${why.what}: ${why.why})` : ""} · $${s.totalCostUsd.toFixed(3)} · label → ${label ?? "none"}`);
    });
  }

  private async issueClosed(issue: number): Promise<boolean> {
    try {
      const out = await gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "state", "--jq", ".state"]);
      return out.trim().toUpperCase() === "CLOSED";
    } catch {
      return false; // unknown: count it as open
    }
  }

  /** Tell the issue why the run failed, with the tail of the failing step's output. */
  private async commentFailure(issue: number, s: RunSummary) {
    const next = this.failedHold({ number: issue, title: "" }, s, s.reason).next;
    const body = failureComment(s, next);
    await gh(["issue", "comment", String(issue), "--repo", this.repo, "--body", body]);
  }

  /** Lock key for a run on this issue: per issue, or per watcher when runs share a branch. */
  private lockFor(n: number) {
    return this.cfg.one_at_a_time ? `${this.repo}#watcher:${this.cfg.id}` : `${this.repo}#${n}`;
  }

  /** An open PR whose head branch starts with pause_while_pr_open (then start nothing new). */
  private async pausingPr(): Promise<{ text: string; number: number; url?: string; title?: string; createdAt?: string } | undefined> {
    const prefix = this.cfg.pause_while_pr_open;
    if (!prefix) return undefined;
    const prs = await ghJson<{ number: number; headRefName: string; state: string; url?: string; title?: string; createdAt?: string }[]>(["pr", "list", "--repo", this.repo, "--state", "open", "--limit", "100", "--json", "number,headRefName,state,url,title,createdAt"]);
    const pr = prs.find((p) => p.state === "OPEN" && p.headRefName.startsWith(prefix));
    return pr ? { text: `PR #${pr.number} (${pr.headRefName})`, number: pr.number, url: pr.url, title: pr.title, createdAt: pr.createdAt } : undefined;
  }

  private startNew(issue: Issue) {
    const { flow } = loadFlow(this.flowName(), this.d.repo);
    const runId = this.submit(issue.number, "issue", {
      kind: "run", flow, task: "", repo: this.d.repo,
      vars: { trigger_label: this.cfg.label, ...this.cfg.vars, github_repo: this.repo, issue: String(issue.number) },
    });
    this.act(`#${issue.number} “${issue.title}” → run ${runId} · label → ${this.L.working}`);
    return runId;
  }

  private resume(issue: number, runId: string, why: string, decision?: { approved: boolean; by: string; note?: string }, labelled = false) {
    this.submit(issue, "issue", { kind: "resume", runId, decision });
    this.act(`#${issue} ${why} → resuming run ${runId}${labelled ? ` · label → ${this.L.working}` : ""}`);
  }

  /** A hold for a reason; the text comes from the next-step module. */
  private held(kind: NextKind, issue?: { number: number; title: string }, data: NextData = {}): Hold {
    const issueUrl = issue ? `https://github.com/${this.repo}/issues/${issue.number}` : undefined;
    return toHold(nextStep(kind, { repo: this.repo, issue: issue?.number, title: issue?.title }, { watched: true, issueUrl, ...data }));
  }

  /** A hold for an issue with the failed label: the run's own record when it failed, else a plain one (a cancelled run also gets the label). */
  private failedHold(issue: { number: number; title: string }, run?: RunSummary, reason?: string): Hold {
    if (run?.status === "failed") {
      const next = runNextStep(run, { watched: true, failedLabel: this.L.failed, title: issue.title });
      if (next.kind === "failed") return toHold(next);
    }
    return this.held("failed", issue, { failedLabel: this.L.failed, runId: run?.runId, reason });
  }

  /** A hold for an issue whose run exists. */
  private heldRun(issue: Issue, run: RunSummary, extra: Parameters<typeof runNextStep>[1] = {}): Hold {
    return toHold(runNextStep(run, { watched: true, failedLabel: this.L.failed, title: issue.title, ...extra }));
  }

  private async tickIssues() {
    // A check that was given up (timeout) must not start runs or store holds next to a newer check.
    const mine = this.tickToken;
    const alive = () => { if (mine !== this.tickToken) throw new Error("this check was given up"); };
    const issues = await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--label", this.cfg.label, "--state", "open", "--limit", "100", "--json", "number,title,labels,body"]);
    let everyIssue: Issue[] | undefined; // all issues, fetched once per tick when a dependency must be checked
    const openDepsOf = async (issue: Issue) => {
      if (!/depends\s+on|blocked\s+by/i.test(issue.body ?? "")) return [];
      everyIssue ??= await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--state", "all", "--limit", "500", "--json", "number,title,labels,state,body"]);
      return openDependencies(dependencies(issue.body ?? "", issue.number, everyIssue), everyIssue, this.cfg.dependency_done_labels);
    };
    const blockedBy = async (issue: Issue) => (this.cfg.wait_for_dependencies ? openDepsOf(issue) : []);
    /** What a blocker is doing: its hold, its newest run (any flow), or what it waits for itself. */
    const describeBlocker = async (b: number, seen: Set<number>): Promise<BlockerInfo> => {
      const own = holds.find((h) => h.issue === b)?.next;
      if (own) return { issue: b, next: own };
      anyRuns ??= this.latestRuns("issue", true);
      const r = anyRuns.get(String(b));
      if (r) return { issue: b, next: runNextStep(r, { watched: true, failedLabel: this.L.failed }) };
      const blocker = everyIssue?.find((i) => i.number === b);
      if (!blocker || seen.has(b)) return { issue: b };
      const deps = (await openDepsOf(blocker)).filter((d) => !seen.has(d));
      if (!deps.length) return { issue: b };
      const next = nextStep("dependency", { repo: this.repo, issue: b, title: blocker.title }, {
        watched: true, issueUrl: `https://github.com/${this.repo}/issues/${b}`,
        blockers: await Promise.all(deps.map((d) => describeBlocker(d, new Set([...seen, b])))),
      });
      return { issue: b, next };
    };
    const runs = this.latestRuns("issue");
    const budgetLeft = this.budgetLeft();
    let started = 0;
    const excluded = new Set(this.cfg.exclude_labels);
    const paused = await this.pausingPr();
    if (paused && this.status.lastActions[0]?.includes(paused.text) !== true) this.act(`not starting new work while ${paused.text} is open`);
    const holds: Hold[] = [];
    const tracked: TrackedIssue[] = [];
    let anyRuns: Map<string, RunSummary> | undefined; // newest run per issue in any flow (to describe blockers)
    const checked = this.prechecked();
    const toCheck: Issue[] = [];
    // The status comment is ours too, but it is not a question or an approval request: it never ends the wait.
    const asked = (c: Comment) => isBot(c) && !isStatusComment(c);
    const questionCount = (comments: Comment[]) => countQuestions([...comments].reverse().find(asked)?.body);

    for (const issue of issues.sort((a, b) => a.number - b.number)) {
      alive();
      const n = issue.number;
      if (issue.labels.some((l) => excluded.has(l.name))) continue;
      const status = issue.labels.map((l) => l.name).find((l) => this.allStatus.includes(l));
      const run = runs.get(String(n));
      // A job that is still queued has no run file yet: take its id from the queue.
      // A queued job may be a fresh run next to an older run file: the queued one is the current work.
      const queuedId = this.d.scheduler.queue().pending.find((p) => p.githubRepo === this.repo && p.issue === String(n))?.runId;
      const track: TrackedIssue = { issue: n, title: issue.title, runId: queuedId ?? run?.runId, done: status === this.L.done };
      tracked.push(track);

      // Questions asked up front (no run yet): wait for an answer, then start like a new issue.
      let answeredEarly = false;
      if (status === this.L.needsInfo && !run) {
        const comments = await issueComments(this.repo, n);
        const answers = commentsAfter(comments, asked);
        if (!answers.length) {
          holds.push({ ...this.held("questions", issue, { questions: questionCount(comments) }), since: [...comments].reverse().find(asked)?.createdAt });
          continue;
        }
        answeredEarly = true;
      }
      // A run that is working (running or queued, e.g. approved or resumed in the UI): the label says so.
      if (run && (this.d.scheduler.isActive(run.runId) || this.d.scheduler.isQueued(run.runId))) {
        if (status && status !== this.L.working) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.act(`#${n} label → ${this.L.working} (its run is working)`);
          this.labelWhenDone(n, run.runId);
        }
        const areaWait = run.status === "running" ? this.d.areaWait?.(run) : undefined;
        if (areaWait) holds.push(this.heldRun(issue, run, { areaWait }));
        continue;
      }
      if (this.d.scheduler.isLocked(this.lockFor(n))) {
        if (this.cfg.one_at_a_time && (!status || answeredEarly)) {
          const blockingRun = this.d.scheduler.queue().active.find((a) => a.lockKey === this.lockFor(n))?.runId;
          holds.push(this.held("one_at_a_time", issue, { blockingRun }));
        }
        continue;
      }

      if (!status || (status === this.L.working && !run) || answeredEarly) {
        if (this.cfg.precheck_flow && !status && !run && !checked.has(n)) {
          toCheck.push(issue);
          continue;
        }
        // No run yet — also when the working label is left over from a start that failed.
        const blockers = await blockedBy(issue);
        if (blockers.length) {
          const msg = `#${n} waits for ${blockers.map((b) => `#${b}`).join(", ")} (depends on)`;
          if (!this.status.lastActions.some((a) => a.endsWith(msg))) this.act(msg);
          const info = await Promise.all(blockers.map((b) => describeBlocker(b, new Set([n]))));
          holds.push(this.held("dependency", issue, { blockers: info }));
          continue;
        }
        if (paused) { holds.push(this.held("release", issue, { pr: paused })); continue; }
        if (!budgetLeft) { holds.push(this.held("daily_budget", issue)); continue; }
        if (started >= this.cfg.max_per_tick) { holds.push(this.held("starting", issue, { maxPerTick: this.cfg.max_per_tick })); continue; }
        alive();
        // It ran before: GitHub's issue list can lag behind (a just-failed or just-finished issue still
        // listed without its new label, or as open). Ask for this issue directly before starting again.
        if (run && run.status !== "running" && !(await this.reallyStartable(n))) continue;
        const runId = this.startNew(issue);
        track.runId = runId;
        await setLabels(this.repo, n, this.L.working, this.allStatus);
        this.labelWhenDone(n, runId);
        started++;
      } else if (status === this.L.working && run) {
        // Reconcile: the label says working but nothing is running (restart, crash, budget pause).
        const resumable = run.status === "cancelled" || /interrupted/.test(run.reason ?? "") ||
          (run.status === "stopped" && /daily budget/.test(run.reason ?? "") && budgetLeft) ||
          (run.status === "stopped" && /usage limit reached|signed out —/.test(run.reason ?? "") && retryLimitAfter(run)) ||
          (run.status === "stopped" && isPaused(run) && !/daily budget|usage limit reached|signed out —/.test(run.reason ?? "") && !paused && this.areaMayBeFree(run));
        if (resumable && started < this.cfg.max_per_tick) {
          this.resume(n, run.runId, run.status !== "stopped" ? "was interrupted" : /daily budget/.test(run.reason ?? "") ? "budget available again" : /usage limit/.test(run.reason ?? "") ? "trying again after the usage limit" : "can continue now");
          this.labelWhenDone(n, run.runId);
          started++;
        } else if (!resumable && labelFor(run, this.L) !== this.L.working) {
          await setLabels(this.repo, n, labelFor(run, this.L), this.allStatus);
          this.act(`#${n} label → ${labelFor(run, this.L)}`);
        } else if (!resumable) {
          // Paused on a limit, a code area or an interruption: say why nothing happens.
          const next = runNextStep(run, { watched: true, failedLabel: this.L.failed, title: issue.title, pr: paused, areaWait: this.d.areaWait?.(run) });
          if (["usage_limit", "daily_budget", "interrupted", "release", "area_lock"].includes(next.kind)) holds.push(toHold(next));
        } else {
          // Resumable, but max_per_tick is used up: only the per-check limit is in the way.
          holds.push(this.held("starting", issue, { maxPerTick: this.cfg.max_per_tick, runId: run.runId }));
        }
      } else if (run && status !== this.L.done && labelFor(run, this.L) !== status) {
        // Reconcile: the label does not match the newest run (e.g. approved in the UI, or the
        // server restarted meanwhile). A done label is left alone.
        const label = labelFor(run, this.L);
        await setLabels(this.repo, n, label, run.status === "succeeded" ? [...this.allStatus, ...this.cfg.remove_on_done] : this.allStatus);
        this.act(`#${n} label → ${label}`);
      } else if (status === this.L.needsInfo && run?.status === "stopped") {
        const comments = await issueComments(this.repo, n);
        const answers = commentsAfter(comments, asked);
        if (answers.length && started < this.cfg.max_per_tick) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.resume(n, run.runId, `answered by @${answers[0]!.author.login}`, undefined, true);
          this.labelWhenDone(n, run.runId);
          started++;
        } else if (!answers.length) {
          holds.push(this.heldRun(issue, run, { questions: questionCount(comments) }));
        } else {
          holds.push(this.held("starting", issue, { maxPerTick: this.cfg.max_per_tick, runId: run.runId })); // answered; waits for the per-check limit
        }
      } else if (status === this.L.waiting && run?.status === "waiting") {
        const decision = await this.findDecision(run.runId, await issueComments(this.repo, n));
        if (decision) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.resume(n, run.runId, `${decision.approved ? "approved" : "rejected"} by @${decision.by}`, decision, true);
          this.labelWhenDone(n, run.runId);
        } else {
          holds.push(this.heldRun(issue, run));
        }
      } else if (status === this.L.failed) {
        holds.push(this.failedHold(issue, run, run?.status === "failed" ? run.reason : undefined));
      }
    }
    if (toCheck.length) await this.precheck(toCheck, holds, budgetLeft);
    let tidyError: Error | undefined;
    const closed: { issue: number; title: string }[] = [];
    let closedWhole = false;
    await this.tidyClosed(runs, holds, closed).then((w) => { closedWhole = w; }, (e: Error) => { tidyError = e; });
    await this.endWaitsOfClosedIssues(new Set(issues.map((i) => i.number))).catch((e: Error) => { tidyError ??= e; });
    if (paused && !holds.some((x) => x.next.kind === "release")) holds.unshift(this.held("release", undefined, { pr: paused }));
    alive();
    const before = new Map((this.status.holds ?? []).map((h) => [holdKey(h), h.seen]));
    const now = new Date().toISOString();
    for (const h of holds) {
      if (!h.since && h.next.kind === "release") h.since = paused?.createdAt;
      h.seen = before.get(holdKey(h)) ?? now;
    }
    this.status.holds = holds;
    this.status.pausedBy = paused ? { number: paused.number, url: paused.url, title: paused.title, createdAt: paused.createdAt } : undefined;
    this.tracked = tracked;
    if (this.cfg.status_comment) await this.reportStatus(runs, holds, tracked, closed, !tidyError && closedWhole && issues.length < 100, () => mine === this.tickToken && !this.stopped);
    // The closed-issue scan is part of the check: its failure is the check's error.
    if (tidyError) throw new Error(`tidying closed issues: ${errorLine(tidyError.message)}`);
  }

  /** Tells the shared writer what this check saw. Never throws, and does not touch Recent activity. */
  private async reportStatus(runs: Map<string, RunSummary>, holds: Hold[], tracked: TrackedIssue[], closed: { issue: number; title: string }[], complete: boolean, alive: () => boolean) {
    try {
      let all: RunSummary[] | undefined; // loaded at most once per check
      await this.statusComments.report(this.cfg.id, {
        id: this.cfg.id, label: this.cfg.label, failedLabel: this.L.failed, tracked, holds, closed, complete,
        scheduler: this.d.scheduler, areaWait: this.d.areaWait,
        lastRunId: (n) => runs.get(String(n))?.runId,
        releaseAt: (run) => releaseAtFor(this.d.watchers?.() ?? [], run, (all ??= this.d.scheduler.list(1000))),
      }, alive);
    } catch (e) {
      this.d.log(`[${this.cfg.id}] ! status comments: ${errorLine((e as Error).message)}`);
    }
  }

  /**
   * Closed issues (e.g. by a merged pull request) that still carry a waiting/working/error label:
   * done if their last run succeeded, otherwise just without the stale status labels.
   * Fills `handled` with the closed issues it dealt with; returns true when GitHub's list was whole (not cut at its limit).
   */
  private async tidyClosed(runs: Map<string, RunSummary>, holds: Hold[], handled: { issue: number; title: string }[]): Promise<boolean> {
    const pending = this.d.scheduler.queue().pending;
    const stale = [this.L.working, this.L.waiting, this.L.needsInfo, this.L.failed];
    const limit = 30;
    const closed = await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--state", "closed", "--limit", String(limit),
      "--search", `label:${stale.map((l) => `"${l}"`).join(",")} sort:updated-desc`, "--json", "number,title,labels,state"]);
    for (const issue of closed) {
      if (issue.state && issue.state.toUpperCase() !== "CLOSED") continue;
      const names = issue.labels.map((l) => l.name);
      if (!names.some((l) => stale.includes(l))) continue;
      const run = runs.get(String(issue.number));
      handled.push({ issue: issue.number, title: issue.title ?? "" });
      const queuedId = pending.find((p) => p.githubRepo === this.repo && p.issue === String(issue.number))?.runId;
      const working = !!queuedId || (!!run && (this.d.scheduler.isActive(run.runId) || this.d.scheduler.isQueued(run.runId)));
      if (working || run?.status === "waiting") {
        // Still busy: change nothing. Say so, unless the run closed the issue itself.
        if (!(run?.runId === (queuedId ?? run?.runId) && runClosedIssue(run))) holds.push(this.held("closed_elsewhere", { number: issue.number, title: issue.title ?? "" }, { runId: queuedId ?? run?.runId, runWaits: !working }));
        continue;
      }
      const done = run?.status === "succeeded" && run.history.at(-1)?.id !== "create_split";
      await setLabels(this.repo, issue.number, done ? this.L.done : undefined, [...this.allStatus, ...this.cfg.remove_on_done].filter((l) => names.includes(l)));
      this.act(`#${issue.number} (closed) label → ${done ? this.L.done : "none"}`);
    }
    return closed.length < limit;
  }

  /**
   * A run that waits for a person (questions, a decision) whose issue was closed on GitHub has nothing
   * left to wait for: end it, so it no longer shows up as needing attention. Any flow, also old ones.
   */
  private async endWaitsOfClosedIssues(openListed: Set<number>) {
    const candidates = [...this.latestRuns("issue", true).values()].filter((r) =>
      (r.status === "stopped" || r.status === "waiting") && !openListed.has(Number(r.vars.issue)) &&
      !this.d.scheduler.isActive(r.runId) && !this.d.scheduler.isQueued(r.runId));
    for (const r of candidates.slice(0, 10)) {
      let state: string;
      try {
        state = (await ghJson<{ state: string }>(["issue", "view", r.vars.issue!, "--repo", this.repo, "--json", "state"])).state;
      } catch {
        continue; // can't tell now; the next check tries again
      }
      if (state.toUpperCase() !== "CLOSED") continue;
      const s = loadRun(this.d.runsDir, r.runId);
      if (!s || (s.status !== "stopped" && s.status !== "waiting")) continue;
      Object.assign(s, { status: "cancelled", reason: "the issue was closed on GitHub — nothing left to do", waiting: undefined, finishedAt: s.finishedAt ?? new Date().toISOString() });
      saveRun(s);
      this.act(`#${r.vars.issue} is closed → ended its run ${r.runId}, which waited for a person`);
    }
  }

  /** Issues already covered by a finished precheck run (a failed check doesn't hold issues back). */
  private prechecked(): Set<number> {
    const done = new Set<number>();
    if (!this.cfg.precheck_flow) return done;
    for (const r of this.d.scheduler.list(1000)) {
      if (r.flow !== this.cfg.precheck_flow || r.vars?.github_repo !== this.repo || !r.vars.issues) continue;
      if (!["succeeded", "failed", "stopped", "cancelled"].includes(r.status)) continue;
      for (const x of r.vars.issues.split(/[\s,]+/)) if (/^\d+$/.test(x)) done.add(Number(x));
    }
    return done;
  }

  /** One run over all new issues that asks the owner's open questions before any of them is built. */
  private async precheck(list: Issue[], holds: Hold[], budgetLeft: boolean) {
    const lockKey = `${this.repo}#precheck:${this.cfg.id}`;
    const hold = (kind: NextKind) => { for (const i of list) holds.push(this.held(kind, i)); };
    if (this.d.scheduler.isLocked(lockKey)) return hold("checking");
    if (!budgetLeft) return hold("daily_budget");
    const { flow } = loadFlow(this.cfg.precheck_flow!, this.d.repo);
    const nums = list.map((i) => i.number);
    const runId = this.queue({
      kind: "run", flow, task: "", repo: this.d.repo,
      vars: { ...this.cfg.vars, github_repo: this.repo, issues: nums.join(" "), needs_info_label: this.L.needsInfo },
    }, { lockKey, source: `watcher ${this.cfg.id} precheck ${nums.map((x) => `#${x}`).join(" ")}` });
    this.act(`checking ${nums.map((x) => `#${x}`).join(", ")} for open questions → run ${runId}`);
    hold("checking");
  }

  /** The issue as GitHub has it right now (not the search list): open, and without a status label. */
  private async reallyStartable(n: number): Promise<boolean> {
    try {
      const fresh = await ghJson<{ state: string; labels: { name: string }[] }>(["issue", "view", String(n), "--repo", this.repo, "--json", "state,labels"]);
      return fresh.state.toUpperCase() === "OPEN" && !fresh.labels.some((l) => this.allStatus.includes(l.name));
    } catch {
      return false; // can't tell: try again at the next check rather than start twice
    }
  }

  /** First /approve or /reject after the run's approval request, from someone with write access. */
  private async findDecision(runId: string, comments: Comment[]) {
    const after = commentsAfter(comments, (c) => c.body.includes(`run=${runId} approval`));
    for (const c of after) {
      const m = APPROVE_RE.exec(c.body);
      if (!m) continue;
      if (!(await canWrite(this.repo, c.author.login))) {
        this.act(`ignored /${m[1]} from @${c.author.login} (no write access)`);
        continue;
      }
      return { approved: m[1]!.toLowerCase() === "approve", by: c.author.login, note: m[2]?.trim() || undefined };
    }
    return undefined;
  }

  private async tickPrs() {
    const prs = await ghJson<{ number: number; headRefName: string }[]>(["pr", "list", "--repo", this.repo, "--state", "open", "--limit", "50", "--json", "number,headRefName"]);
    const runs = this.latestRuns("pr");
    let started = 0;
    for (const pr of prs) {
      if (!pr.headRefName.startsWith("factory/") || started >= this.cfg.max_per_tick) continue;
      if (this.d.scheduler.isLocked(`${this.repo}#${pr.number}`)) continue;
      const view = await ghJson<{
        comments: Comment[];
        reviews: { author: { login: string }; body: string; state: string; submittedAt: string }[];
        commits: { committedDate: string }[];
      }>(["pr", "view", String(pr.number), "--repo", this.repo, "--json", "comments,reviews,commits"]);
      const lineComments = await ghJson<{ body: string; created_at: string }[]>(["api", `repos/${this.repo}/pulls/${pr.number}/comments`]);
      const t = (s: string | undefined) => (s ? new Date(s).getTime() : 0);
      const human = [
        ...view.comments.filter((c) => !isBot(c)).map((c) => t(c.createdAt)),
        ...view.reviews.filter((r) => r.body || r.state === "CHANGES_REQUESTED").filter((r) => !isBot(r)).map((r) => t(r.submittedAt)),
        ...lineComments.filter((c) => !isBot(c)).map((c) => t(c.created_at)),
      ];
      const lastHuman = Math.max(0, ...human);
      const lastOurs = Math.max(
        0,
        ...view.comments.filter(isBot).map((c) => t(c.createdAt)),
        ...view.commits.map((c) => t(c.committedDate)),
        t(runs.get(String(pr.number))?.startedAt),
      );
      if (lastHuman > lastOurs) {
        const { flow } = loadFlow(this.flowName(), this.d.repo);
        const runId = this.submit(pr.number, "pr", {
          kind: "run", flow, task: "", repo: this.d.repo,
          vars: { ...this.cfg.vars, github_repo: this.repo, pr: String(pr.number) },
        });
        this.act(`PR #${pr.number} has new review feedback → run ${runId}`);
        started++;
      }
    }
  }
}
