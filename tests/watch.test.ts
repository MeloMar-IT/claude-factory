import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseFlow } from "../src/flow/load.js";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { BOT_MARKER, BOT_MARKERS, commentsAfter, isBot } from "../src/github.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { failureComment, parseInterval, Watcher } from "../src/queue/watcher.js";
import { watcherProblem } from "../src/server/next.js";
import { firstLine } from "../src/next-step.js";
import { LABEL_WORDS } from "../src/words.js";
import { claudeBin, fakeGithub, first, oldFlowFor } from "./helpers/fake-github.js";

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
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, ...over, flow: oldFlowFor(over) }), {
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

  describe("label descriptions", () => {
    const create = (name: string) => gh.ghLog().split("\n").filter((l) => l.startsWith(`gh label create ${name} `));

    it("sets the trigger and status descriptions, and no review label without the var", async () => {
      issues();
      for (const review of [undefined, "  "]) {
        const w = watcher(review === undefined ? {} : { vars: { review_plan_label: review } });
        await w.tick();
      }
      const log = gh.ghLog();
      expect(log).toContain(`gh label create factory:waiting-approval --repo acme/app --color 7c3aed --description ${LABEL_WORDS.waiting} --force`);
      expect(log).toContain(`gh label create claude-factory --repo acme/app --color c2410c --description ${LABEL_WORDS.trigger} --force`);
      expect(log).not.toContain(LABEL_WORDS.review);
    });

    it("creates the review label", async () => {
      issues();
      await watcher({ vars: { review_plan_label: "Factory_review_plan" } }).tick();
      expect(gh.ghLog()).toContain(`gh label create Factory_review_plan --repo acme/app --color 0e7490 --description ${LABEL_WORDS.review} --force`);
    });

    it("uses one combined description when the review label is the trigger label", async () => {
      issues();
      await watcher({ vars: { review_plan_label: "claude-factory" } }).tick();
      const l = create("claude-factory");
      expect(l).toHaveLength(1);
      expect(l[0]).toContain(LABEL_WORDS.triggerReview);
      expect(gh.ghLog()).not.toContain(LABEL_WORDS.trigger);
      expect(gh.ghLog()).not.toContain(LABEL_WORDS.review);
    });

    it("compares label names without case", async () => {
      issues();
      await watcher({ vars: { review_plan_label: "CLAUDE-FACTORY" } }).tick();
      expect(create("claude-factory")).toHaveLength(1);
      expect(create("CLAUDE-FACTORY")).toHaveLength(0);
      const w = watcher({ vars: { review_plan_label: "Factory:Waiting-Approval" } });
      await w.tick();
      expect(create("Factory:Waiting-Approval")).toHaveLength(0);
      expect(w.status.lastActions.join("\n")).toContain("keeps the status description");
    });

    it("keeps the status description when the review label is a status label", async () => {
      issues();
      const w = watcher({ vars: { review_plan_label: "factory:waiting-approval" } });
      await w.tick();
      const l = create("factory:waiting-approval");
      expect(l).toHaveLength(1);
      expect(l[0]).toContain(LABEL_WORDS.waiting);
      expect(w.status.lastActions.join("\n")).toContain("keeps the status description");
    });

    it("uses custom status label names", async () => {
      issues();
      await watcher({ status_labels: { failed: "Factory_ERROR" } }).tick();
      expect(gh.ghLog()).toContain(`gh label create Factory_ERROR --repo acme/app --color b91c1c --description ${LABEL_WORDS.failed} --force`);
    });

    it("creates labels once per watcher and again after a restart", async () => {
      issues();
      const w = watcher();
      await w.tick();
      await w.tick();
      expect(create("factory:failed")).toHaveLength(1);
      await watcher().tick();
      expect(create("factory:failed")).toHaveLength(2);
    });
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

  it("ends a run that waits for answers when its issue is closed on GitHub", async () => {
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issues([4]);
    const w = watcher();
    await w.tick();
    await settle();
    expect(runFor("4").status).toBe("stopped");
    // Someone closes #4 on GitHub (e.g. after splitting it by hand): it leaves the open list.
    issues();
    process.env.FAKE_GH_FRESH = JSON.stringify([{ number: 4, state: "CLOSED" }]);
    await w.tick();
    await settle();
    const ended = runFor("4");
    expect(ended.status).toBe("cancelled");
    expect(ended.reason).toBe("the issue was closed on GitHub — nothing left to do");
    // An issue that is open (just not labelled) keeps its waiting run.
    delete process.env.FAKE_GH_FRESH;
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

  it("resumes an approval from the /approve comment the app composes (the signature is not in the note)", async () => {
    const { composeComment } = await import("../src/turn-actions.js");
    issues([6]);
    const w = watcher({ flow: "github-pr", vars: { test_cmd: "test -f feature.txt", require_approval: "yes", ci_settle_sec: "0" } });
    await w.tick();
    await settle();
    const run = runFor("6");
    issues([6, "factory:waiting-approval"]);
    const request = { author: { login: "bot" }, body: `ready <!-- claude-factory run=${run.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
    const body = composeComment("approve", { name: "Marcel K", text: "ship it\nplease" });
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "marcel" }, body, createdAt: "2026-01-01T02:00:00Z" }] });
    await w.tick();
    await settle();
    expect(runFor("6").history.find((h) => h.id === "approve")!.output).toBe("approved by marcel: ship it please");
  });

  it("resumes a needs-info run from the /defaults comment the app composes", async () => {
    const { composeComment } = await import("../src/turn-actions.js");
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issues([4]);
    const w = watcher();
    await w.tick();
    await settle();
    const first = runFor("4");
    delete process.env.FAKE_PLAN;
    issues([4, "factory:needs-info"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "questions <!-- claude-factory run=x questions -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: composeComment("defaults", { name: "Marcel K" }), createdAt: "2026-01-01T01:00:00Z" },
    ] });
    await w.tick();
    await settle();
    expect(runFor("4").runId).toBe(first.runId);
    expect(runFor("4").status).toBe("succeeded");
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
    const posted = gh.comments().at(-1)!.body; // the whole comment, starting with the first line
    expect(posted.startsWith("**")).toBe(true);
    expect(posted).toContain(marker);

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

  const rewind = (issue: string, over: Record<string, unknown>) => {
    const s = loadRun(join(gh.tmp, "runs"), runFor(issue).runId)!;
    Object.assign(s, over);
    saveRun(s);
  };
  const expectHoldsFromRecords = (w: Watcher) => {
    for (const h of w.status.holds!) {
      expect(h.reason).toBe(h.next.text);
      expect(h.url).toBe(h.next.where.url);
    }
  };

  it("shows a hold for a run paused by the usage limit", async () => {
    issues([8]);
    const w = watcher();
    await w.tick();
    await settle();
    rewind("8", { status: "stopped", reason: "usage limit reached: hit your limit · resets 3:50pm (Europe/Amsterdam) — continues automatically", finishedAt: new Date().toISOString() });
    issues([8, "factory:working"]);
    await w.tick();
    await settle();
    expect(w.status.holds).toMatchObject([{ issue: 8, next: { kind: "usage_limit", who: "A time limit", until: "3:50pm (Europe/Amsterdam)" } }]);
    expectHoldsFromRecords(w);
  });

  it("shows a hold for a run paused by the daily budget", async () => {
    issues([8]);
    const w = watcher();
    await w.tick();
    await settle();
    rewind("8", { status: "stopped", reason: "daily budget of $5 reached — resume tomorrow" });
    issues([8, "factory:working"]);
    const capped = new Watcher(w.cfg, { scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, dailyBudget: () => 0, log: () => {} });
    await capped.tick();
    expect(capped.status.holds).toMatchObject([{ issue: 8, next: { kind: "daily_budget", until: "tomorrow" } }]);
    expect(capped.status.holds![0]!.reason).not.toContain("$");
  });

  it("holds carry the time they wait since", async () => {
    issues([4, "factory:needs-info"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "old <!-- claude-factory run=x -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "bot" }, body: "**Q1.** a? <!-- claude-factory run=x -->", createdAt: "2026-01-02T00:00:00Z" },
    ] });
    const w = watcher();
    await w.tick();
    expect(w.status.holds).toMatchObject([{ issue: 4, next: { kind: "questions" }, since: "2026-01-02T00:00:00Z" }]);
    await watcher().tick(); // a new server sees the same GitHub state
    const again = watcher();
    await again.tick();
    expect(again.status.holds![0]!.since).toBe("2026-01-02T00:00:00Z");
  });

  it("a hold without a time keeps its first-seen time", async () => {
    issues([8, "factory:failed"]);
    const w = watcher();
    await w.tick();
    const first = w.status.holds![0]!;
    expect(first.next.kind).toBe("failed");
    expect(first.since).toBeUndefined();
    expect(first.seen).toBeDefined();
    await new Promise((r) => setTimeout(r, 15));
    await w.tick();
    expect(w.status.holds![0]!.seen).toBe(first.seen);
  });

  it("pause_while_pr_open gives pausedBy and the release time", async () => {
    process.env.FAKE_GH_PRS = JSON.stringify([{ number: 17, headRefName: "factory/x", state: "OPEN", url: "https://github.com/acme/app/pull/17", title: "Daily", createdAt: "2026-09-30T08:00:00Z" }]);
    issues([5]);
    const w = watcher({ pause_while_pr_open: "factory/" });
    await w.tick();
    expect(w.status.pausedBy).toEqual({ number: 17, url: "https://github.com/acme/app/pull/17", title: "Daily", createdAt: "2026-09-30T08:00:00Z" });
    const release = w.status.holds!.find((h) => h.next.kind === "release")!;
    expect(release.since).toBe("2026-09-30T08:00:00Z");
    process.env.FAKE_GH_PRS = "[]";
    await w.tick();
    expect(w.status.pausedBy).toBeUndefined();
  });

  it("errorSince is set on the first failing check, kept, and cleared by a good one", async () => {
    process.env.FAKE_GH_ISSUES = "not json";
    const w = watcher();
    await w.tick();
    expect(w.status.lastError).toBeDefined();
    const since = w.status.errorSince;
    expect(since).toBeDefined();
    await new Promise((r) => setTimeout(r, 15));
    await w.tick();
    expect(w.status.errorSince).toBe(since);
    issues();
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
    expect(w.status.errorSince).toBeUndefined();
  });

  it("a failed gh call keeps its first output line, and a connection problem says so", async () => {
    process.env.FAKE_GH_FAIL = "issue list";
    process.env.FAKE_GH_FAIL_TEXT = "error connecting to api.github.com\ncheck your internet connection";
    const w = watcher();
    await w.tick();
    expect(w.status.lastError).toMatch(/Command failed: .*issue list.* — error connecting to api\.github\.com$/);
    expect(w.status.lastError).not.toContain("\n");
    const p = watcherProblem(w.cfg, w.status);
    expect(p?.why).toMatch(/^The watcher for acme\/app can't reach GitHub/);
    expect(p?.action).toBe("Check the network and `gh auth status`");

    process.env.FAKE_GH_FAIL_TEXT = "HTTP 404: Not Found";
    await w.tick();
    expect(watcherProblem(w.cfg, w.status)?.why).toBe("The watcher for acme/app cannot reach the repository: a call to GitHub failed");
  });

  it("a failed repo check holds the first output line", async () => {
    process.env.FAKE_GH_FAIL = "repo view";
    const w = watcher();
    await w.tick();
    expect(w.status.lastError).toMatch(/^cannot access acme\/app with gh: Command failed:/);
    expect(w.status.lastError).toContain("boom");
  });

  it("a failed issue names both ways to retry", async () => {
    issues([8]);
    const w = watcher();
    await w.tick();
    await settle();
    // A failed run stops at its failed step, so it can be resumed there (the run itself had succeeded).
    rewind("8", { status: "failed", reason: 'step "x" failed: exit code 1', state: { next: "x", steps: {}, visits: {} } });
    issues([8, "factory:failed"]);
    await w.tick();
    expect(w.status.holds).toMatchObject([{ issue: 8, next: { kind: "failed", who: "Something is wrong" } }]);
    expect(w.status.holds![0]!.reason).toContain("remove the `factory:failed` label to start over, or resume the run on its page");
    expect(w.status.holds![0]!.next.why).toBe("The step x failed: its command ended with an error");
    expectHoldsFromRecords(w);
  });

  it("the failure comment keeps hostile output inside one code fence", async () => {
    const dir = join(gh.tmp, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "loud.yaml"), "name: loud\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: \"printf '\\\\140\\\\140\\\\140\\\\n</details>\\\\n'; exit 1\"}\n");
    issues([8]);
    const w = watcher({ flow: "loud" });
    await w.tick();
    await settle();
    const log = gh.comments().at(-1)!.body;
    const at = log.indexOf("<summary>Details</summary>");
    expect(at).toBeGreaterThan(0);
    const from = log.slice(at);
    expect(from.split("```")).toHaveLength(3); // the opening and the closing fence only
    expect(from.indexOf("ˋˋˋ")).toBeLessThan(from.lastIndexOf("```"));
    expect(from.lastIndexOf("</details>")).toBeGreaterThan(from.lastIndexOf("```"));
    expect(from.indexOf("<!-- claude-factory run=")).toBeGreaterThan(from.lastIndexOf("</details>"));
  });

  it("failureComment puts plain text first and hostile text only inside the fence", () => {
    const hostile = "x ``` </details> @someone **b** <!-- claude-factory run=evil -->";
    const s = {
      runId: "r9", reason: `step "a" failed: ${hostile}`,
      history: [{ id: "a", type: "shell", ok: false, visit: 1, output: "````\n</details>\n# Title", error: "e" }],
    } as never;
    const body = failureComment(s, { who: "Something is wrong", action: "Do the thing, then retry", why: "x" } as never);
    const fences = body.match(/`{3,}/g) ?? [];
    expect(fences).toEqual(["```", "```"]);
    const open = body.indexOf("```");
    const close = body.lastIndexOf("```");
    for (const bad of ["@someone", "**b**", "run=evil", "# Title"]) {
      expect(body.indexOf(bad)).toBeGreaterThan(open);
      expect(body.lastIndexOf(bad)).toBeLessThan(close);
    }
    const head = body.slice(0, body.indexOf("<details>"));
    expect(head).toContain("- **What happened:** The step a failed.");
    expect(head).not.toContain("What you can do");
    expect(head).toContain("Last failing step: `a`");
    for (const bad of ["@someone", "```", "evil", "# Title"]) expect(head).not.toContain(bad);
    expect(body.split("\n").at(-1)).toBe("<!-- claude-factory run=r9 -->");
    expect(body.startsWith("**What you need to do:** Do the thing, then retry.\n\n🤖 **Spaghetti Code Foundry** could not finish this issue.\n")).toBe(true);
  });

  it("failureComment for a Foundry failure has the 'itself failed' heading and no Why line", () => {
    const s = { runId: "r9", reason: "boom", history: [] } as never;
    const body = failureComment(s, { who: "Something is wrong", action: "Fix it", why: "The Foundry failed, not the code: boom", cause: "factory" } as never);
    expect(body.split("\n")[2]).toBe("🤖 **Spaghetti Code Foundry** itself failed on this issue, not the code.");
    expect(body).toContain("- **What happened:** The Foundry failed, not the code: boom.");
    expect(body).not.toContain("- **Why:**");
  });

  describe("failure comment", () => {
    const FACTORY_LINE = "🤖 **Spaghetti Code Foundry** itself failed on this issue, not the code.";
    const bodyOf = (issue: number) => gh.comments().find((c) => c.issue === issue)!.body;
    const headOf = (body: string) => body.slice(0, body.indexOf("<details>"));
    const localFlow = (yaml: string) => {
      const file = join(gh.tmp, "local.yaml");
      writeFileSync(file, yaml.replace("name: local", `name: ${file}`)); // a run is matched to its watcher by flow name
      return file;
    };

    it("says the Foundry failed when a marker could not be read, and the hold has the same sentence", async () => {
      process.env.FAKE_PLAN = "not sure";
      issues([4]);
      const w = watcher();
      await w.tick();
      await settle();
      const body = bodyOf(4);
      expect(body.split("\n")[2]).toBe(FACTORY_LINE);
      expect(body.split("\n").at(-1)).toBe(`<!-- claude-factory run=${runFor("4").runId} -->`);
      expect(headOf(body)).not.toContain("- **Why:**");
      issues([4, "factory:failed"]);
      await w.tick();
      expect(w.status.holds).toMatchObject([{ issue: 4, next: { kind: "failed", who: "Something is wrong", cause: "factory" } }]);
      expect(first(body)).toBe(firstLine(w.status.holds![0]!.next));
      expectHoldsFromRecords(w);
    });

    it("keeps the old heading for a code failure", async () => {
      const w = watcher({ flow: localFlow("name: local\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'echo boom; exit 1'}\n") });
      issues([5]);
      await w.tick();
      await settle();
      expect(bodyOf(5).split("\n")[0]).toMatch(/^\*\*What you need to do:\*\* /);
      expect(bodyOf(5).split("\n")[2]).toBe("🤖 **Spaghetti Code Foundry** could not finish this issue.");
    });

    it("names the custom failed label", async () => {
      process.env.FAKE_PLAN = "not sure";
      issues([4]);
      const w = watcher({ status_labels: { failed: "Factory_ERROR" } });
      await w.tick();
      await settle();
      expect(first(bodyOf(4))).toContain("`Factory_ERROR`");
    });

    it("shows only the tool and program of a blocked command", async () => {
      const prompt = 'DENY Bash curl -H "Authorization: token SENTINEL123" https://example.test/x\n      ERROR';
      const w = watcher({ flow: localFlow(`name: local\nworkspace: inplace\nsteps:\n  - id: a\n    type: claude\n    prompt: |\n      ${prompt}\n`) });
      issues([6]);
      await w.tick();
      await settle();
      const body = bodyOf(6);
      expect(body.split("\n")[2]).toBe(FACTORY_LINE);
      // The raw text under Details is the unchanged output tail; the plain lines above it carry only the tool and program.
      const head = headOf(body);
      expect(head).toContain("Bash: curl");
      expect(head).not.toMatch(/SENTINEL123|example\.test/);
      issues([6, "factory:failed"]);
      await w.tick();
      const next = w.status.holds![0]!.next;
      for (const t of [next.text, next.why, next.action]) expect(t).not.toMatch(/SENTINEL123|example\.test/);
      expect(next.why).toContain("Bash: curl");
    });
  });

  it("describes a blocker that has a run in another flow", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      // The fake gh ignores --label, so #4 (another watcher's issue) is excluded by label here.
      { number: 4, title: "four", state: "OPEN", labels: [{ name: "other-flow" }] },
      { number: 5, title: "five", state: "OPEN", labels: [{ name: "claude-factory" }], body: "### Depends on\n#4\n" },
    ]);
    const sub = watcher({ wait_for_dependencies: true, exclude_labels: ["other-flow"] });
    // #4's only run belongs to another flow and waits at approve_plan.
    const id = scheduler.submit({ kind: "run", flow: parseFlow("name: x\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n"), task: "", repo: gh.tmp, vars: { github_repo: "acme/app", issue: "4" } });
    await scheduler.wait(id);
    await settle(); // the run must be finished and saved before its file is rewritten
    expect(runFor("4").status).toBe("succeeded");
    rewind("4", { flow: "issue-plan", status: "waiting", waiting: { stepId: "approve_plan", message: "m", since: "x" } });
    await sub.tick();
    expect(sub.status.holds![0]!.reason).toContain("waits for #4, which waits for your decision on its risky plan");
    expectHoldsFromRecords(sub);
  });

  it("follows a chain of blockers that have no run, whatever their number", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 5, title: "five", state: "OPEN", labels: [{ name: "claude-factory" }], body: "### Depends on\n#6\n" },
      { number: 6, title: "six", state: "OPEN", labels: [{ name: "other-flow" }], body: "### Depends on\n#7\n" },
      { number: 7, title: "seven", state: "OPEN", labels: [{ name: "other-flow" }], body: "" },
    ]);
    const w = watcher({ wait_for_dependencies: true, exclude_labels: ["other-flow"] });
    await w.tick();
    expect(w.status.holds).toMatchObject([{ issue: 5, next: { kind: "dependency", until: "after #6" } }]);
    expect(w.status.holds![0]!.reason).toContain("waits for #6, which waits for #7, which is to be done");
  });

  it("shows a hold for a run that waits for a code area", async () => {
    const dir = join(gh.tmp, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "slow.yaml"), "name: slow\nworkspace: inplace\nsteps:\n  - {id: first, type: shell, run: 'true'}\n  - {id: claim_areas, type: shell, run: 'sleep 1'}\n");
    issues([8]);
    const w = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", flow: "slow" }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
      areaWait: () => ({ runId: "r0", areas: "src" }),
    });
    await w.tick();
    await new Promise((r) => setTimeout(r, 300));
    issues([8, "factory:working"]);
    await w.tick();
    expect(w.status.holds).toMatchObject([{ issue: 8, url: "#/runs/r0", next: { kind: "area_lock", who: "Another story" } }]);
    expectHoldsFromRecords(w);
    await settle();
  });

  const slowFlow = () => {
    const dir = join(gh.tmp, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "slow.yaml"), "name: slow\nworkspace: inplace\nsteps:\n  - {id: work, type: shell, run: 'sleep 1'}\n");
  };
  const slowWatcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", flow: "slow", ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: (l) => lines.push(l),
    });

  it("sets the working label on a run that works while the issue says failed, once", async () => {
    slowFlow();
    issues([8]);
    const w = slowWatcher();
    await w.tick();
    await new Promise((r) => setTimeout(r, 300));
    issues([8, "factory:failed"]);
    const before = gh.ghLog().length;
    await w.tick();
    issues([8, "factory:working"]);
    await w.tick();
    const log = gh.ghLog().slice(before);
    expect(log.match(/issue edit 8 .*--add-label factory:working/g)).toHaveLength(1);
    expect(w.status.lastActions.some((a) => a.includes("#8 label → factory:working"))).toBe(true);
    expect(w.status.lastError).toBeUndefined();
    await settle();
    expect(gh.ghLog().match(/--add-label factory:done/g)).toHaveLength(1);
  });

  it("leaves the done label alone and corrects a label that does not match the run", async () => {
    issues([8]);
    const w = watcher();
    await w.tick();
    await settle();
    const run = runFor("8");
    saveRun({ ...run, status: "failed", reason: "boom" });
    issues([8, "factory:done"]);
    let before = gh.ghLog().length;
    await w.tick();
    expect(gh.ghLog().slice(before)).not.toMatch(/issue edit 8 /);
    issues([8, "factory:waiting-approval"]);
    before = gh.ghLog().length;
    await w.tick();
    expect(gh.ghLog().slice(before)).toMatch(/issue edit 8 .*--add-label factory:failed/);
  });

  it("reports an issue closed on GitHub while its run works, and changes nothing", async () => {
    slowFlow();
    issues([8]);
    const w = slowWatcher();
    await w.tick();
    await new Promise((r) => setTimeout(r, 300));
    issues();
    process.env.FAKE_GH_CLOSED_ISSUES = JSON.stringify([{ number: 8, title: "issue 8", state: "CLOSED", labels: [{ name: "factory:working" }] }]);
    const before = gh.ghLog().length;
    await w.tick();
    expect(w.status.holds).toMatchObject([{ issue: 8, next: { kind: "closed_elsewhere", who: "You", where: { url: `#/runs/${runFor("8").runId}` } } }]);
    expect(gh.ghLog().slice(before)).not.toMatch(/issue edit 8 /);
    await settle();
  });

  it("does not report a closed issue whose run closed it itself", async () => {
    const dir = join(gh.tmp, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "slow.yaml"), "name: slow\nworkspace: inplace\nsteps:\n  - {id: first, type: shell, run: 'true'}\n  - {id: report, type: shell, run: 'gh issue close 8 && sleep 1'}\n");
    issues([8]);
    const w = slowWatcher();
    await w.tick();
    await new Promise((r) => setTimeout(r, 300));
    issues();
    process.env.FAKE_GH_CLOSED_ISSUES = JSON.stringify([{ number: 8, title: "issue 8", state: "CLOSED", labels: [{ name: "factory:working" }] }]);
    await w.tick();
    expect(w.status.holds).toEqual([]);
    await settle();
  });

  it("records the last successful check, and a failed closed-issue scan is the check's error", async () => {
    issues([3, "factory:done"]);
    const w = watcher();
    await w.tick();
    const ok = w.status.lastOk;
    expect(ok).toBeDefined();
    process.env.FAKE_GH_CLOSED_ISSUES = "not json";
    await w.tick();
    expect(w.status.lastError).toMatch(/tidying closed issues/);
    expect(w.status.lastOk).toBe(ok);
    expect(w.status.holds).toEqual([]);
  });

  it("gives up a check that hangs, so the next check works again", async () => {
    const w = watcher();
    w.checkTimeoutMs = 200;
    let hang = true;
    (w as unknown as { tickIssues: () => Promise<void> }).tickIssues = () => (hang ? new Promise(() => {}) : Promise.resolve());
    issues([3, "factory:done"]);
    await w.tick();
    expect(w.status.lastError).toMatch(/was given up/);
    expect(w.status.lastOk).toBeUndefined();
    hang = false;
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
    expect(w.status.lastOk).toBeDefined();
  });

  it("reports a closed issue whose fresh run is queued next to an older run", async () => {
    slowFlow();
    issues([8]);
    const w = slowWatcher();
    await w.tick();
    await settle();
    const old = runFor("8");
    saveRun({ ...old, status: "failed", reason: "boom" });
    // Restart: remove the failed label; concurrency 2 is taken by two other slow runs, so the new run stays queued.
    const { flow } = (await import("../src/flow/load.js")).loadFlow("slow", gh.tmp);
    for (const x of ["a", "b"]) scheduler.submit({ kind: "run", flow, task: "", repo: gh.tmp, vars: { github_repo: "acme/other", issue: x } }, { lockKey: `other#${x}` });
    issues([8]);
    await w.tick();
    const queued = w.tracked[0]!.runId;
    expect(queued).toBeDefined();
    expect(queued).not.toBe(old.runId);
    issues();
    process.env.FAKE_GH_CLOSED_ISSUES = JSON.stringify([{ number: 8, title: "issue 8", state: "CLOSED", labels: [{ name: "factory:failed" }] }]);
    const before = gh.ghLog().length;
    await w.tick();
    expect(w.status.holds).toMatchObject([{ issue: 8, next: { kind: "closed_elsewhere", runId: queued } }]);
    expect(gh.ghLog().slice(before)).not.toMatch(/issue edit 8 /);
    await settle();
  });

  it("reports an invalid interval as the watcher's error", async () => {
    const w = watcher({ every: "soon" });
    await w.tick();
    expect(w.status.lastError).toMatch(/invalid interval/);
    expect(w.status.lastOk).toBeUndefined();
  });

  it("cancels a run that waits for approval", async () => {
    const dir = join(gh.tmp, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "slow.yaml"), "name: slow\nworkspace: inplace\nsteps:\n  - {id: ok, type: approval, message: go}\n");
    issues([8]);
    const w = slowWatcher();
    await w.tick();
    await settle();
    const run = runFor("8");
    expect(run.status).toBe("waiting");
    expect(scheduler.cancel(run.runId)).toBe(true);
    expect(loadRun(join(gh.tmp, "runs"), run.runId)).toMatchObject({ status: "cancelled", reason: "cancelled by user" });
    expect(scheduler.cancel(run.runId)).toBe(false);
  });

  it("tracks every issue with its run", async () => {
    issues([3, "factory:done"], [5]);
    const w = watcher();
    await w.tick();
    await settle();
    expect(w.tracked).toMatchObject([{ issue: 3, done: true }, { issue: 5, runId: runFor("5").runId }]);
  });

  it("the manager keeps what it tracked after stopAll, until sync", async () => {
    const { WatcherManager } = await import("../src/queue/watchers.js");
    issues([3, "factory:done"], [5]);
    const cfg = ConfigSchema.parse({ protected_branches: [], watchers: [{ id: "w", github_repo: "acme/app", flow: "github-issue", every: "1h", vars: { test_cmd: "true" } }] });
    const m = new WatcherManager({ scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, config: () => cfg, log: () => {} });
    m.sync();
    await m.runNow("w"); // returns at once when the tick started by sync() is still running
    for (let i = 0; i < 100 && !m.tracked()[0]!.status.lastTick; i++) await new Promise((r) => setTimeout(r, 100));
    await settle();
    expect(m.tracked()[0]!.issues.map((i) => i.issue)).toEqual([3, 5]);
    m.stopAll();
    expect(m.statuses()[0]!.status).toBeUndefined();
    expect(m.tracked()[0]!.issues.map((i) => i.issue)).toEqual([3, 5]);
    expect(m.tracked()[0]!.status.holds).toBeDefined();
    m.sync();
    m.stopAll();
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

  it("a queued job waits for an earlier queued job that holds its lock", async () => {
    const gh = fakeGithub();
    try {
      const config = ConfigSchema.parse({ protected_branches: [], concurrency: 1 });
      const s = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config });
      const flow = parseFlow("name: t\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: sleep 1}");
      const job = { kind: "run" as const, flow, task: "build it\nmore", repo: gh.tmp, vars: {} };
      const a = s.submit(job, { lockKey: "a" });
      const p1 = s.submit(job, { lockKey: "k" });
      const p2 = s.submit(job, { lockKey: "k" });
      const { pending } = s.queue();
      expect(pending.find((p) => p.runId === p1)).toMatchObject({ waitingFor: undefined, task: "build it\nmore", repo: gh.tmp });
      expect(pending.find((p) => p.runId === p2)!.waitingFor).toBe(p1);
      expect(a).toBeTruthy();
      await s.idle();
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
