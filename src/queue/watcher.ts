import type { WatcherConfig } from "../config.js";
import { spentToday, type RunSummary } from "../engine/state.js";
import { loadFlow } from "../flow/load.js";
import { canWrite, commentsAfter, ensureLabel, gh, ghJson, isBot, issueComments, setLabels, type Comment, type Issue } from "../github.js";
import type { Scheduler } from "./scheduler.js";

/** Status labels the watcher puts on issues. Remove one to have the issue picked up again. */
export const STATUS_LABELS = {
  working: { name: "factory:working", color: "1d4ed8", description: "claude-factory is working on this" },
  done: { name: "factory:done", color: "15803d", description: "claude-factory finished this" },
  needsInfo: { name: "factory:needs-info", color: "d97706", description: "claude-factory needs more information — reply to continue" },
  waiting: { name: "factory:waiting-approval", color: "7c3aed", description: "claude-factory waits for /approve or /reject" },
  failed: { name: "factory:failed", color: "b91c1c", description: "claude-factory run failed — remove this label to retry" },
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

/** Flow each source runs when the watcher doesn't name one. */
export const DEFAULT_FLOWS: Record<WatcherConfig["source"], string> = {
  issues: "github-issue",
  "pr-feedback": "pr-feedback",
  "ci-failures": "ci-fix",
  schedule: "chore",
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
  log: (msg: string) => void;
}

export interface WatcherStatus {
  id: string;
  lastTick?: string;
  nextTick?: string;
  lastError?: string;
  lastActions: string[];
}

const APPROVE_RE = /^\s*\/(approve|reject)\b[ \t]*(.*)$/im;

/** Stopped for a reason that clears by itself: daily budget, or a `wait_*` step (e.g. waiting for a PR merge). */
function isPaused(s: RunSummary): boolean {
  return /daily budget|usage limit reached|stopped at step "(?:[\w-]+\/)*wait_/.test(s.reason ?? "");
}

/** Usage limits reset after a while; try a limited run again at most every 30 minutes. */
export const LIMIT_RETRY_MS = 30 * 60_000;
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
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private setupDone = false;
  private stopped = false;

  private L: LabelNames;
  private allStatus: string[];

  constructor(public cfg: WatcherConfig, private d: WatcherDeps) {
    this.status = { id: cfg.id, lastActions: [] };
    this.L = labelNames(cfg);
    this.allStatus = Object.values(this.L);
  }

  private get repo() {
    return this.cfg.github_repo;
  }

  private flowName() {
    // "github-issue" is the schema default; other sources mean their own flow unless one is chosen.
    return this.cfg.flow === "github-issue" ? DEFAULT_FLOWS[this.cfg.source] : this.cfg.flow;
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      await this.tick();
      if (this.stopped) return;
      const every = parseInterval(this.cfg.every);
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
      throw new Error(`cannot access ${this.repo} with gh: ${e.message.split("\n")[0]}`);
    });
    if (this.cfg.source === "issues") {
      await ensureLabel(this.repo, this.cfg.label, "c2410c", "Let claude-factory work on this issue");
      for (const [k, l] of Object.entries(STATUS_LABELS)) await ensureLabel(this.repo, this.L[k as LabelKey], l.color, l.description);
    }
    loadFlow(this.flowName(), this.d.repo); // fail early on a missing flow
    this.setupDone = true;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.setup();
      if (this.cfg.source === "issues") await this.tickIssues();
      else if (this.cfg.source === "pr-feedback") await this.tickPrs();
      else if (this.cfg.source === "ci-failures") await this.tickCi();
      else await this.tickSchedule();
      this.status.lastError = undefined;
    } catch (e) {
      this.status.lastError = (e as Error).message.split("\n")[0];
      this.d.log(`[${this.cfg.id}] ! ${this.status.lastError}`);
    } finally {
      this.status.lastTick = new Date().toISOString();
      this.ticking = false;
    }
  }

  /** Latest run per issue/PR number for this repo (newest first in the list). */
  private latestRuns(key: "issue" | "pr"): Map<string, RunSummary> {
    const m = new Map<string, RunSummary>();
    for (const s of this.d.scheduler.list(1000)) {
      if (s.vars?.github_repo !== this.repo || !s.vars[key]) continue;
      if (s.flow !== this.flowName()) continue; // e.g. a plan watcher and a code watcher on the same issues
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
      const runId = this.d.scheduler.submit({
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
    const runId = this.d.scheduler.submit({
      kind: "run", flow, repo: this.d.repo, task: this.cfg.task ?? "",
      vars: { ...this.cfg.vars, github_repo: this.repo, chore_watcher: this.cfg.id },
    }, { lockKey, source: `watcher ${this.cfg.id} schedule` });
    this.act(`scheduled chore → run ${runId}`);
  }

  private submit(n: number, kind: "issue" | "pr", job: Parameters<Scheduler["submit"]>[0]): string {
    return this.d.scheduler.submit(job, { lockKey: kind === "issue" ? this.lockFor(n) : `${this.repo}#${n}`, source: `watcher ${this.cfg.id} ${kind} #${n}` });
  }

  /** Update labels when a run we started finishes (the next tick would also reconcile). */
  private labelWhenDone(issue: number, runId: string) {
    void this.d.scheduler.wait(runId).then(async (s) => {
      if (!s || this.stopped) return;
      const label = labelFor(s, this.L);
      const remove = s.status === "succeeded" ? [...this.allStatus, ...this.cfg.remove_on_done] : this.allStatus;
      await setLabels(this.repo, issue, label, remove).catch(() => {});
      if (label === this.L.failed && this.cfg.comment_on_failure) await this.commentFailure(issue, s).catch(() => {});
      this.act(`#${issue} → ${s.status}${s.reason ? ` (${s.reason})` : ""} · $${s.totalCostUsd.toFixed(3)}`);
    });
  }

  /** Tell the issue why the run failed, with the tail of the failing step's output. */
  private async commentFailure(issue: number, s: RunSummary) {
    const failed = [...s.history].reverse().find((h) => !h.ok);
    const tail = (failed?.output || failed?.error || "").trim().slice(-3000);
    const body = [
      `🤖 **claude-factory** could not finish this issue: ${s.reason ?? s.status}`,
      failed ? `\nLast failing step: \`${failed.id}\`${failed.visit > 1 ? ` (attempt ${failed.visit})` : ""}` : "",
      tail ? `\n<details><summary>Output (tail)</summary>\n\n\`\`\`\n${tail.replace(/```/g, "ˋˋˋ")}\n\`\`\`\n</details>` : "",
      `\n_Remove the \`${this.L.failed}\` label to try again._`,
      `\n<!-- claude-factory run=${s.runId} -->`,
    ].join("\n");
    await gh(["issue", "comment", String(issue), "--repo", this.repo, "--body", body]);
  }

  /** Lock key for a run on this issue: per issue, or per watcher when runs share a branch. */
  private lockFor(n: number) {
    return this.cfg.one_at_a_time ? `${this.repo}#watcher:${this.cfg.id}` : `${this.repo}#${n}`;
  }

  /** An open PR whose head branch starts with pause_while_pr_open (then start nothing new). */
  private async pausingPr(): Promise<string | undefined> {
    const prefix = this.cfg.pause_while_pr_open;
    if (!prefix) return undefined;
    const prs = await ghJson<{ number: number; headRefName: string; state: string }[]>(["pr", "list", "--repo", this.repo, "--state", "open", "--limit", "100", "--json", "number,headRefName,state"]);
    const pr = prs.find((p) => p.state === "OPEN" && p.headRefName.startsWith(prefix));
    return pr ? `PR #${pr.number} (${pr.headRefName})` : undefined;
  }

  private startNew(issue: Issue) {
    const { flow } = loadFlow(this.flowName(), this.d.repo);
    const runId = this.submit(issue.number, "issue", {
      kind: "run", flow, task: "", repo: this.d.repo,
      vars: { ...this.cfg.vars, github_repo: this.repo, issue: String(issue.number) },
    });
    this.act(`#${issue.number} “${issue.title}” → run ${runId}`);
    return runId;
  }

  private resume(issue: number, runId: string, why: string, decision?: { approved: boolean; by: string; note?: string }) {
    this.submit(issue, "issue", { kind: "resume", runId, decision });
    this.act(`#${issue} ${why} → resuming run ${runId}`);
  }

  private async tickIssues() {
    const issues = await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--label", this.cfg.label, "--state", "open", "--limit", "100", "--json", "number,title,labels"]);
    const runs = this.latestRuns("issue");
    const budgetLeft = this.budgetLeft();
    let started = 0;
    const excluded = new Set(this.cfg.exclude_labels);
    const paused = await this.pausingPr();
    if (paused && this.status.lastActions[0]?.includes(paused) !== true) this.act(`not starting new work while ${paused} is open`);

    for (const issue of issues.sort((a, b) => a.number - b.number)) {
      const n = issue.number;
      if (issue.labels.some((l) => excluded.has(l.name))) continue;
      if (this.d.scheduler.isLocked(this.lockFor(n))) continue;
      const status = issue.labels.map((l) => l.name).find((l) => this.allStatus.includes(l));
      const run = runs.get(String(n));

      if (!status || (status === this.L.working && !run)) {
        // No run yet — also when the working label is left over from a start that failed.
        if (started >= this.cfg.max_per_tick || !budgetLeft || paused) continue;
        const runId = this.startNew(issue);
        await setLabels(this.repo, n, this.L.working, this.allStatus);
        this.labelWhenDone(n, runId);
        started++;
      } else if (status === this.L.working && run) {
        // Reconcile: the label says working but nothing is running (restart, crash, budget pause).
        const resumable = run.status === "cancelled" || /interrupted/.test(run.reason ?? "") ||
          (run.status === "stopped" && /daily budget/.test(run.reason ?? "") && budgetLeft) ||
          (run.status === "stopped" && /usage limit reached/.test(run.reason ?? "") && retryLimitAfter(run)) ||
          (run.status === "stopped" && isPaused(run) && !/daily budget|usage limit reached/.test(run.reason ?? "") && !paused);
        if (resumable && started < this.cfg.max_per_tick) {
          this.resume(n, run.runId, run.status !== "stopped" ? "was interrupted" : /daily budget/.test(run.reason ?? "") ? "budget available again" : /usage limit/.test(run.reason ?? "") ? "trying again after the usage limit" : "can continue now");
          this.labelWhenDone(n, run.runId);
          started++;
        } else if (!resumable && labelFor(run, this.L) !== this.L.working) {
          await setLabels(this.repo, n, labelFor(run, this.L), this.allStatus);
          this.act(`#${n} label → ${labelFor(run, this.L)}`);
        }
      } else if (status === this.L.needsInfo && run?.status === "stopped") {
        const comments = await issueComments(this.repo, n);
        const answers = commentsAfter(comments, isBot);
        if (answers.length && started < this.cfg.max_per_tick) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.resume(n, run.runId, `answered by @${answers[0]!.author.login}`);
          this.labelWhenDone(n, run.runId);
          started++;
        }
      } else if (status === this.L.waiting && run?.status === "waiting") {
        const decision = await this.findDecision(run.runId, await issueComments(this.repo, n));
        if (decision) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.resume(n, run.runId, `${decision.approved ? "approved" : "rejected"} by @${decision.by}`, decision);
          this.labelWhenDone(n, run.runId);
        }
      }
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
