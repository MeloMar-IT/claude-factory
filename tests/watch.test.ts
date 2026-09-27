import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
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

  it("resumes an approval from a /approve comment by someone with write access", async () => {
    issues([6]);
    const w = watcher({ flow: "github-pr", vars: { test_cmd: "test -f feature.txt", require_approval: "yes", ci_settle_sec: "0" } });
    await w.tick();
    await settle();
    const run = runFor("6");
    expect(run.status).toBe("waiting");
    expect(gh.ghLog()).toMatch(/gh issue edit 6 .*--add-label factory:waiting-approval/);

    issues([6, "factory:waiting-approval"]);
    const request = { author: { login: "bot" }, body: `ready <!-- claude-factory run=${run.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
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
});

describe("scheduler", () => {
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
