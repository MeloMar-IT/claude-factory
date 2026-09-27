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
const ALL_STATUS: string[] = Object.values(STATUS_LABELS).map((l) => l.name);

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

function labelFor(s: RunSummary): string | undefined {
  switch (s.status) {
    case "succeeded": return STATUS_LABELS.done.name;
    case "waiting": return STATUS_LABELS.waiting.name;
    case "stopped": return /daily budget/.test(s.reason ?? "") ? STATUS_LABELS.working.name : STATUS_LABELS.needsInfo.name;
    case "running": return STATUS_LABELS.working.name;
    default: return /interrupted/.test(s.reason ?? "") ? STATUS_LABELS.working.name : STATUS_LABELS.failed.name;
  }
}

/** Polls one GitHub repo and turns tickets / PR comments into runs. */
export class Watcher {
  status: WatcherStatus;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private setupDone = false;
  private stopped = false;

  constructor(public cfg: WatcherConfig, private d: WatcherDeps) {
    this.status = { id: cfg.id, lastActions: [] };
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
      for (const l of Object.values(STATUS_LABELS)) await ensureLabel(this.repo, l.name, l.color, l.description);
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
      if (key === "pr" && s.flow !== this.flowName()) continue;
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
    const every = parseInterval(this.cfg.every);
    const last = this.d.scheduler.list(1000).find((s) => s.vars?.chore_watcher === this.cfg.id);
    // 5% slack so timer jitter doesn't skip a whole period.
    if (last && Date.now() - new Date(last.startedAt).getTime() < every * 0.95) return;
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
    return this.d.scheduler.submit(job, { lockKey: `${this.repo}#${n}`, source: `watcher ${this.cfg.id} ${kind} #${n}` });
  }

  /** Update labels when a run we started finishes (the next tick would also reconcile). */
  private labelWhenDone(issue: number, runId: string) {
    void this.d.scheduler.wait(runId).then(async (s) => {
      if (!s || this.stopped) return;
      const label = labelFor(s);
      await setLabels(this.repo, issue, label, ALL_STATUS).catch(() => {});
      this.act(`#${issue} → ${s.status}${s.reason ? ` (${s.reason})` : ""} · $${s.totalCostUsd.toFixed(3)}`);
    });
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

    for (const issue of issues.sort((a, b) => a.number - b.number)) {
      const n = issue.number;
      if (this.d.scheduler.isLocked(`${this.repo}#${n}`)) continue;
      const status = issue.labels.map((l) => l.name).find((l) => ALL_STATUS.includes(l));
      const run = runs.get(String(n));

      if (!status) {
        if (started >= this.cfg.max_per_tick || !budgetLeft) continue;
        await setLabels(this.repo, n, STATUS_LABELS.working.name, ALL_STATUS);
        this.labelWhenDone(n, this.startNew(issue));
        started++;
      } else if (status === STATUS_LABELS.working.name) {
        // Reconcile: the label says working but nothing is running (restart, crash, budget pause).
        if (!run) continue;
        const resumable = run.status === "cancelled" || /interrupted/.test(run.reason ?? "") ||
          (run.status === "stopped" && /daily budget/.test(run.reason ?? "") && budgetLeft);
        if (resumable && started < this.cfg.max_per_tick) {
          this.resume(n, run.runId, run.status === "stopped" ? "budget available again" : "was interrupted");
          this.labelWhenDone(n, run.runId);
          started++;
        } else if (!resumable && labelFor(run) !== STATUS_LABELS.working.name) {
          await setLabels(this.repo, n, labelFor(run), ALL_STATUS);
          this.act(`#${n} label → ${labelFor(run)}`);
        }
      } else if (status === STATUS_LABELS.needsInfo.name && run?.status === "stopped") {
        const comments = await issueComments(this.repo, n);
        const answers = commentsAfter(comments, isBot);
        if (answers.length && started < this.cfg.max_per_tick) {
          await setLabels(this.repo, n, STATUS_LABELS.working.name, ALL_STATUS);
          this.resume(n, run.runId, `answered by @${answers[0]!.author.login}`);
          this.labelWhenDone(n, run.runId);
          started++;
        }
      } else if (status === STATUS_LABELS.waiting.name && run?.status === "waiting") {
        const decision = await this.findDecision(run.runId, await issueComments(this.repo, n));
        if (decision) {
          await setLabels(this.repo, n, STATUS_LABELS.working.name, ALL_STATUS);
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
