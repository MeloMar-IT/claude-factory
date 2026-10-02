import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

describe("watcher run owner", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let home: string;
  let savedHome: string | undefined;
  let admin: { id: string };
  let ann: { id: string };
  const runsDir = () => join(gh.tmp, "runs");
  const cfg = (concurrency: number) => ({ ...ConfigSchema.parse({ protected_branches: [] }), concurrency });
  const start = (over: Record<string, unknown>, concurrency: number) => {
    const scheduler = new Scheduler({ runsDir: runsDir(), config: () => cfg(concurrency), claudeBin });
    const w = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "true" }, ...over, flow: oldFlowFor(over) }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
    return { scheduler, w };
  };
  const queuedOwners = (s: Scheduler) => s.queue().pending.map((p) => s.ownerOf(p.runId));

  beforeEach(async () => {
    gh = fakeGithub();
    savedHome = process.env.FACTORY_HOME;
    home = mkdtempSync(join(tmpdir(), "watch-owner-"));
    process.env.FACTORY_HOME = home;
    admin = await createUser({ name: "Admin", email: "admin@example.com", password: "test-password-12345", role: "admin" });
    ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345", role: "user" });
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "four", labels: [{ name: "claude-factory" }] }]);
  });
  afterEach(() => {
    gh.restore();
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("starts an issue run for the owner e-mail's account, written to run.json and known while queued", async () => {
    const queued = start({ owner: "ann@example.com" }, 0);
    await queued.w.tick();
    expect(queuedOwners(queued.scheduler)).toEqual([ann.id]);
    const live = start({ owner: " ANN@example.com " }, 2);
    await live.w.tick();
    await live.scheduler.idle();
    const run = live.scheduler.list()[0]!;
    expect(run.owner).toBe(ann.id);
    expect(JSON.parse(readFileSync(join(run.runDir, "run.json"), "utf8")).owner).toBe(ann.id);
  });

  it("gives the run to the first admin without an owner, and with an e-mail of no account", async () => {
    for (const over of [{}, { owner: "nobody@example.com" }]) {
      const { scheduler, w } = start(over, 0);
      await w.tick();
      expect(queuedOwners(scheduler)).toEqual([admin.id]);
    }
  });

  it("uses the owner for ci-failures, schedule, precheck and pr-feedback runs", async () => {
    process.env.FAKE_GH_RUNS = JSON.stringify([{ databaseId: 7, workflowName: "CI", status: "completed", conclusion: "failure", headSha: "abc7def0", url: "https://ci/7" }]);
    const ci = start({ source: "ci-failures", owner: "ann@example.com" }, 0);
    await ci.w.tick();
    expect(queuedOwners(ci.scheduler)).toEqual([ann.id]);

    const chore = start({ source: "schedule", every: "1h", task: "Update deps", owner: "ann@example.com" }, 0);
    await chore.w.tick();
    expect(queuedOwners(chore.scheduler)).toEqual([ann.id]);

    const pre = start({ precheck_flow: "epic-questions", owner: "ann@example.com" }, 0);
    await pre.w.tick();
    expect(pre.scheduler.queue().pending.map((p) => p.lockKey)).toEqual(["acme/app#precheck:w"]);
    expect(queuedOwners(pre.scheduler)).toEqual([ann.id]);

    execFileSync("git", ["-C", gh.remote, "branch", "factory/pr-17", "main"]);
    process.env.FAKE_GH_PRS = JSON.stringify([{ number: 17, headRefName: "factory/x" }]);
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({
      comments: [{ author: { login: "alice" }, body: "please rename x", createdAt: new Date(Date.now() - 60_000).toISOString() }],
      reviews: [],
      commits: [{ committedDate: new Date(Date.now() - 3_600_000).toISOString() }],
    });
    const pr = start({ source: "pr-feedback", owner: "ann@example.com" }, 0);
    await pr.w.tick();
    expect(queuedOwners(pr.scheduler)).toEqual([ann.id]);
  });

  it("leaves the owner of a run alone when the watcher resumes it", async () => {
    const { scheduler } = start({ owner: "ann@example.com" }, 2);
    const flow = parseFlow("name: x\nworkspace: inplace\nsteps:\n  - {id: a, type: approval, message: ok}\n");
    const id = scheduler.submit({ kind: "run", flow, task: "", repo: gh.tmp, vars: {} }, { owner: admin.id });
    await scheduler.wait(id);
    expect(scheduler.ownerOf(id)).toBe(admin.id);
    const resumer = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", owner: "ann@example.com", flow: "github-issue" }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
    (resumer as unknown as { resume: (i: number, r: string, why: string, d?: unknown) => void }).resume(4, id, "approved", { approved: true, by: "x" });
    await scheduler.idle();
    expect(scheduler.ownerOf(id)).toBe(admin.id);
    expect(JSON.parse(readFileSync(join(runsDir(), id, "run.json"), "utf8")).owner).toBe(admin.id);
  });
});
