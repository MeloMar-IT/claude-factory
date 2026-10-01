import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { BOT_MARKER, BOT_MARKERS, commentsAfter, isBot } from "../src/github.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { parseInterval, Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

describe("parseInterval", () => {
  it("parses units and defaults to minutes", () => {
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("2")).toBe(120_000);
    expect(parseInterval("7d")).toBe(604_800_000);
    expect(() => parseInterval("30d")).toThrow(/at most/);
    expect(() => parseInterval("1s")).toThrow(/at least 10s/);
    expect(() => parseInterval("soon")).toThrow(/invalid interval/);
  });
});

describe("watcher", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let lines: string[];
  const config = ConfigSchema.parse({ protected_branches: [], concurrency: 2 });

  beforeEach(() => {
    gh = fakeGithub();
    lines = [];
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
  });
  afterEach(() => gh.restore());

  const watcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: (l) => lines.push(l),
    });
  const issues = (...list: [number, string?][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, status]) => ({
      number, title: `issue ${number}`, labels: [{ name: "claude-factory" }, ...(status ? [{ name: status }] : [])],
    })));
  };
  /** Let runs finish and label callbacks run. */
  const settle = async () => {
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  };
  const runFor = (issue: string) => scheduler.list().find((s) => s.vars.issue === issue)!;

  it("starts the oldest new issue and labels it done", async () => {
    issues([9], [3, "factory:done"], [5]);
    const w = watcher();
    await w.tick();
    await settle();
    expect(w.status.lastError).toBeUndefined();
    const log = gh.ghLog();
    expect(log).toContain("gh label create factory:waiting-approval --repo acme/app");
    expect(log).toMatch(/gh issue edit 5 .*--add-label factory:working/);
    expect(log).toMatch(/gh issue edit 5 .*--add-label factory:done/);
    expect(log).not.toMatch(/issue edit (3|9) /);
    expect(runFor("5").status).toBe("succeeded");
  });

  it("starts an issue that has the working label but never got a run", async () => {
    issues([4, "factory:working"]);
    const w = watcher();
    await w.tick();
    await settle();
    expect(w.status.lastError).toBeUndefined();
    expect(runFor("4").status).toBe("succeeded");
    expect(gh.ghLog()).toMatch(/gh issue edit 4 .*--add-label factory:done/);
  });

  it("asks for info, then resumes the same run once someone answers", async () => {
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issues([4]);
    const w = watcher();
    await w.tick();
    await settle();
    const first = runFor("4");
    expect(first.status).toBe("stopped");
    expect(first.state.next).toBe("pull_ticket");
    expect(gh.ghLog()).toMatch(/gh issue edit 4 .*--add-label factory:needs-info/);

    // No answer yet → nothing happens.
    issues([4, "factory:needs-info"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [{ author: { login: "bot" }, body: "questions <!-- claude-factory run=x -->", createdAt: "2026-01-01T00:00:00Z" }] });
    await w.tick();
    await settle();
    expect(runFor("4").resumes ?? 0).toBe(0);

    // A bot comment with only the new marker is not an answer either.
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [{ author: { login: "bot" }, body: "questions <!-- spaghetti-code-foundry run=x -->", createdAt: "2026-01-01T00:00:00Z" }] });
    await w.tick();
    await settle();
    expect(runFor("4").resumes ?? 0).toBe(0);

    // Answered → resume the same run, which now plans successfully.
    delete process.env.FAKE_PLAN;
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "questions <!-- claude-factory run=x -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" },
    ] });
    await w.tick();
    await settle();
    const resumed = runFor("4");
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.resumes).toBe(1);
    expect(resumed.status).toBe("succeeded");
    expect(lines.join("\n")).toContain("answered by @marcel");
  });

  it.each(["claude-factory", "spaghetti-code-foundry"])("resumes an approval from a /approve comment by someone with write access (%s marker)", async (marker) => {
    issues([6]);
    const w = watcher({ flow: "github-pr", vars: { test_cmd: "test -f feature.txt", require_approval: "yes", ci_settle_sec: "0" } });
    await w.tick();
    await settle();
    const run = runFor("6");
    expect(run.status).toBe("waiting");
    expect(gh.ghLog()).toMatch(/gh issue edit 6 .*--add-label factory:waiting-approval/);

    issues([6, "factory:waiting-approval"]);
    const request = { author: { login: "bot" }, body: `ready <!-- ${marker} run=${run.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "mallory" }, body: "/approve", createdAt: "2026-01-01T01:00:00Z" }] });
    process.env.FAKE_GH_PERMISSION = "read";
    await w.tick();
    await settle();
    expect(runFor("6").status).toBe("waiting");
    expect(lines.join("\n")).toContain("ignored /approve from @mallory");

    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "marcel" }, body: "/approve ship it", createdAt: "2026-01-01T02:00:00Z" }] });
    await w.tick();
    await settle();
    const done = runFor("6");
    expect(done.status).toBe("succeeded");
    expect(done.history.find((h) => h.id === "approve")!.output).toBe("approved by marcel: ship it");
  });

  it("the approval request github-pr posts keeps the old marker, and /approve on it resumes the run", async () => {
    issues([6]);
    const w = watcher({ flow: "github-pr", vars: { test_cmd: "test -f feature.txt", require_approval: "yes", ci_settle_sec: "0" } });
    await w.tick();
    await settle();
    const run = runFor("6");
    expect(run.status).toBe("waiting");

    // The comment the flow really posted (the fake gh logs every comment body).
    const log = gh.ghLog();
    const marker = `<!-- claude-factory run=${run.runId} approval -->`;
    const start = log.indexOf("✋ **Spaghetti Code Foundry is ready to push** branch");
    const end = log.indexOf(marker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(log).not.toContain("<!-- spaghetti-code-foundry");
    const posted = log.slice(start, end + marker.length);

    issues([6, "factory:waiting-approval"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: posted, createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: "/approve ship it", createdAt: "2026-01-01T02:00:00Z" },
    ] });
    await w.tick();
    await settle();
    const done = runFor("6");
    expect(done.runId).toBe(run.runId);
    expect(done.status).toBe("succeeded");
    expect(done.history.find((h) => h.id === "approve")!.output).toBe("approved by marcel: ship it");
  });

  it("resumes a run that was interrupted by a crash", async () => {
    issues([8]);
    const w = watcher();
    await w.tick();
    await settle();
    // Simulate a crash mid-run: rewind the saved run to "running" at the commit step.
    const s = loadRun(join(gh.tmp, "runs"), runFor("8").runId)!;
    Object.assign(s, { status: "running", finishedAt: undefined });
    s.state.next = "push_result";
    saveRun(s);
    issues([8, "factory:working"]);
    await w.tick();
    await settle();
    expect(lines.join("\n")).toContain("#8 was interrupted → resuming");
    expect(runFor("8").status).toBe("succeeded");
    expect(runFor("8").history.at(-1)!.id).toBe("push_result");
  });

  it("runs pr-feedback once for new review comments on factory PRs", async () => {
    execFileSync("git", ["-C", gh.remote, "branch", "factory/pr-17", "main"]);
    process.env.FAKE_GH_PRS = JSON.stringify([{ number: 17, headRefName: "factory/x" }, { number: 18, headRefName: "feature/human" }]);
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({
      comments: [{ author: { login: "alice" }, body: "please rename x", createdAt: new Date(Date.now() - 60_000).toISOString() }],
      reviews: [],
      commits: [{ committedDate: new Date(Date.now() - 3_600_000).toISOString() }],
    });
    const w = watcher({ source: "pr-feedback", vars: { test_cmd: "true" } });
    await w.tick();
    await settle();
    const runs = scheduler.list().filter((s) => s.flow === "pr-feedback");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.vars.pr).toBe("17");
    expect(runs[0]!.status).toBe("succeeded");
    await w.tick(); // the same comment must not trigger again
    await settle();
    expect(scheduler.list().filter((s) => s.flow === "pr-feedback")).toHaveLength(1);
  });

  it("a comment carrying only the new marker is not PR feedback", async () => {
    process.env.FAKE_GH_PRS = JSON.stringify([{ number: 17, headRefName: "factory/x" }]);
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({
      comments: [{ author: { login: "bot" }, body: "🤖 **Spaghetti Code Foundry** went through the review comments:\nok\n<!-- spaghetti-code-foundry run=x -->", createdAt: new Date(Date.now() - 60_000).toISOString() }],
      reviews: [],
      commits: [{ committedDate: new Date(Date.now() - 3_600_000).toISOString() }],
    });
    const w = watcher({ source: "pr-feedback", vars: { test_cmd: "true" } });
    await w.tick();
    await settle();
    expect(scheduler.list().filter((s) => s.flow === "pr-feedback")).toHaveLength(0);
  });

  it("opens a ci-fix run when CI is red on the default branch, once per CI run", async () => {
    const ciRun = (id: number, workflowName: string, conclusion: string) =>
      ({ databaseId: id, workflowName, status: "completed", conclusion, headSha: `abc${id}def0`, url: `https://ci/${id}` });
    process.env.FAKE_GH_RUNS = JSON.stringify([ciRun(7, "CI", "failure"), ciRun(6, "CI", "success"), ciRun(5, "Lint", "success"), ciRun(4, "Lint", "failure")]);
    const w = watcher({ source: "ci-failures", vars: { test_cmd: "test -f main-fix.txt" } });
    await w.tick();
    await settle();
    expect(w.status.lastError).toBeUndefined();
    const runs = scheduler.list().filter((s) => s.flow === "ci-fix");
    expect(runs).toHaveLength(1); // Lint's latest run is green: its old failure is ignored
    expect(runs[0]!.vars).toMatchObject({ ci_run: "7", ci_workflow: "CI", github_repo: "acme/app" });
    expect(runs[0]!.task).toBe("Fix failing CI: CI on main (abc7def)");
    expect(runs[0]!.status).toBe("succeeded");
    expect(gh.ghLog()).toMatch(/gh run view 7 --repo acme\/app --log-failed/);
    expect(gh.ghLog()).toContain("gh pr create");
    const branch = gh.remoteGit("for-each-ref", "--format=%(refname:short)", "refs/heads/factory/").trim();
    expect(gh.remoteGit("show", `${branch}:main-fix.txt`)).toBe("fixed\n");

    await w.tick(); // same failed CI run → nothing new
    await settle();
    expect(scheduler.list().filter((s) => s.flow === "ci-fix")).toHaveLength(1);
  });

  it("runs a scheduled chore once per period, and ends quietly when there is nothing to do", async () => {
    const w = watcher({ source: "schedule", every: "1h", task: "Update deps", vars: { test_cmd: "test -f chore.txt" } });
    await w.tick();
    await settle();
    await w.tick(); // within the hour → no second run
    await settle();
    const chores = scheduler.list().filter((s) => s.flow === "chore");
    expect(chores).toHaveLength(1);
    expect(chores[0]!).toMatchObject({ status: "succeeded", task: "Update deps" });
    expect(chores[0]!.history.map((h) => h.id)).toContain("open_pr");

    const idle = watcher({ id: "idle", source: "schedule", every: "1h", task: "SKIP_CHORE" });
    await idle.tick();
    await settle();
    const quiet = scheduler.list().find((s) => s.vars.chore_watcher === "idle")!;
    expect(quiet.status).toBe("succeeded");
    expect(quiet.history.at(-1)!.id).toBe("implement");
  });

  it("requires a task for schedule watchers", () => {
    expect(() => WatcherSchema.parse({ id: "s", github_repo: "a/b", source: "schedule" })).toThrow(/needs a task/);
  });
});

describe("bot comments", () => {
  const bot = (marker: string) => ({ author: { login: "bot" }, body: `x <!-- ${marker} run=1 -->`, createdAt: "2026-01-01T00:00:00Z" });
  it("recognises the old and the new marker, and only as a comment", () => {
    expect(isBot(bot("claude-factory"))).toBe(true);
    expect(isBot(bot("spaghetti-code-foundry"))).toBe(true);
    expect(isBot({ body: "spaghetti-code-foundry is nice" })).toBe(false);
    expect(isBot({ body: "\"claude-factory\"" })).toBe(false);
    expect(BOT_MARKER).toBe("<!-- claude-factory");
    expect([...BOT_MARKERS]).toEqual(["<!-- claude-factory", "<!-- spaghetti-code-foundry"]);
  });
  it("a new-marker bot comment is not a human answer", () => {
    const botNew = bot("spaghetti-code-foundry");
    const human = { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" };
    expect(commentsAfter([botNew, human, botNew], isBot)).toEqual([]);
    expect(commentsAfter([botNew, human], isBot)).toEqual([human]);
  });
});

describe("scheduler", () => {
  it("runs one coding (one_per_repo) run per repository; planning runs in parallel", async () => {
    const gh = fakeGithub();
    try {
      const config = ConfigSchema.parse({ protected_branches: [], concurrency: 5 });
      const s = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config });
      const { parseFlow } = await import("../src/flow/load.js");
      const flow = (name: string, one: boolean) => parseFlow(`name: ${name}\nworkspace: empty\n${one ? "one_per_repo: true\n" : ""}steps:\n  - {id: a, type: shell, run: sleep 1}`);
      const job = (f: ReturnType<typeof parseFlow>, repo: string) => ({ kind: "run" as const, flow: f, task: "", repo: gh.tmp, vars: { github_repo: repo } });
      const code1 = s.submit(job(flow("code", true), "acme/app"));
      const code2 = s.submit(job(flow("code", true), "acme/app"));
      const other = s.submit(job(flow("code", true), "acme/lib"));
      const plan1 = s.submit(job(flow("plan", false), "acme/app"));
      const plan2 = s.submit(job(flow("plan", false), "acme/app"));
      await new Promise((r) => setTimeout(r, 150));
      const q = s.queue();
      expect(q.active.map((a) => a.runId).sort()).toEqual([code1, other, plan1, plan2].sort());
      expect(q.pending).toMatchObject([{ runId: code2, repoLock: "code:acme/app", waitingFor: code1 }]);
      await s.idle();
      const done = s.list().filter((r) => r.status === "succeeded");
      expect(done).toHaveLength(5);
      const a = done.find((r) => r.runId === code1)!, b = done.find((r) => r.runId === code2)!;
      expect(new Date(b.startedAt).getTime()).toBeGreaterThanOrEqual(new Date(a.finishedAt!).getTime());
    } finally {
      gh.restore();
    }
  });

  it("respects concurrency and per-key locks", async () => {
    const gh = fakeGithub();
    try {
      const config = ConfigSchema.parse({ protected_branches: [], concurrency: 2 });
      const s = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config });
      const { parseFlow } = await import("../src/flow/load.js");
      const flow = parseFlow("name: t\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: sleep 1}");
      const job = { kind: "run" as const, flow, task: "", repo: gh.tmp, vars: {} };
      s.submit(job, { lockKey: "k" });
      s.submit(job, { lockKey: "k" });
      s.submit(job, { lockKey: "other" });
      await new Promise((r) => setTimeout(r, 100));
      const q = s.queue();
      expect(q.active.map((a) => a.lockKey).sort()).toEqual(["k", "other"]);
      expect(q.pending.map((p) => p.lockKey)).toEqual(["k"]);
      await s.idle();
      expect(s.list().filter((r) => r.status === "succeeded")).toHaveLength(3);
    } finally {
      gh.restore();
    }
  });
});
