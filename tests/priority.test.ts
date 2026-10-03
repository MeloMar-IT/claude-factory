import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema, type Config } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type Job } from "../src/queue/scheduler.js";
import { goesFirst, Watcher } from "../src/queue/watcher.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const PLAIN = parseFlow(`name: plain
workspace: empty
steps:
  - {id: a, type: shell, run: "true"}
`);
const SLOW = parseFlow(`name: slow
workspace: empty
steps:
  - {id: a, type: shell, run: "sleep 1"}
`);

describe("goesFirst", () => {
  const issue = (...names: string[]) => ({ labels: names.map((name) => ({ name })) });
  it("matches a priority label without case, and nothing else", () => {
    expect(goesFirst(issue("Bug"), ["bug"])).toBe(true);
    expect(goesFirst(issue(" BUG "), ["bug"])).toBe(true);
    expect(goesFirst(issue("bugfix"), ["bug"])).toBe(false);
    expect(goesFirst(issue("bug"), [])).toBe(false);
  });
  it("is on by default and can be changed", () => {
    expect(WatcherSchema.parse({ id: "w", github_repo: "a/b" }).priority_labels).toEqual(["bug"]);
    expect(goesFirst(issue("Urgent"), ["urgent"])).toBe(true);
    expect(goesFirst(issue("bug"), ["urgent"])).toBe(false);
  });
});

describe("scheduler priority", () => {
  let tmp: string;
  let concurrency = 0;
  const cfg = (): Config => ({ ...ConfigSchema.parse({}), concurrency });
  const mk = (queueFile?: string) => new Scheduler({ runsDir: join(tmp, "runs"), config: cfg, queueFile });
  const job = (flow = PLAIN): Job => ({ kind: "run", flow, task: "t", repo: tmp, vars: {} });
  const order = (s: Scheduler) => s.queue().pending.map((p) => p.source);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-prio-"));
    mkdirSync(join(tmp, "runs"));
    concurrency = 0;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("puts priority jobs in front, the oldest story first", () => {
    const s = mk();
    s.submit(job(), { source: "A" });
    s.submit(job(), { source: "B" });
    s.submit(job(), { source: "C", priority: true });
    s.submit(job(), { source: "D", priority: true });
    expect(order(s)).toEqual(["C", "D", "A", "B"]);
    s.submit(job(), { source: "E", priority: true, storyAt: "2000-01-01T00:00:00Z" });
    s.submit(job(), { source: "F", priority: true, storyAt: "2999-01-01T00:00:00Z" });
    expect(order(s)).toEqual(["E", "C", "D", "F", "A", "B"]);
    const q = s.queue().pending;
    expect(q.filter((p) => p.priority).map((p) => p.source)).toEqual(["E", "C", "D", "F"]);
    expect(q.filter((p) => p.behindPriority).map((p) => p.source)).toEqual(["A", "B"]);
  });

  it("does not hold others back for a priority job that waits for a busy lock", () => {
    concurrency = 1;
    const s = mk();
    s.submit(job(SLOW), { source: "run", lockKey: "k" });
    s.submit(job(), { source: "P", priority: true, lockKey: "k" });
    s.submit(job(), { source: "N" });
    expect(s.queue().pending.find((p) => p.source === "N")!.behindPriority).toBeUndefined();
    s.cancel(s.queue().active[0]!.runId);
  });

  it("moves a queued job in and out of the priority block", () => {
    const s = mk();
    s.submit(job(), { source: "A" });
    const b = s.submit(job(), { source: "B" });
    s.submit(job(), { source: "C", priority: true });
    expect(s.setPriority(b, true, "2999-01-01T00:00:00Z")).toBe(true);
    expect(order(s)).toEqual(["C", "B", "A"]);
    expect(s.setPriority(b, true, "2999-01-01T00:00:00Z")).toBe(false);
    expect(s.setPriority(b, false)).toBe(true);
    expect(order(s)).toEqual(["C", "A", "B"]);
    expect(s.queue().pending.find((p) => p.source === "B")!.priority).toBeUndefined();
    expect(s.setPriority("nope", true)).toBe(false);
  });

  it("keeps order and fields after a restart", () => {
    const file = join(tmp, "queue.json");
    const s = mk(file);
    s.submit(job(), { source: "A" });
    s.submit(job(), { source: "C", priority: true, storyAt: "2026-01-01T00:00:00Z" });
    const again = mk(file);
    expect(order(again)).toEqual(["C", "A"]);
    expect(again.queue().pending[0]!.priority).toBe(true);
  });

  it("gives a priority job the free slot first and never stops running work", async () => {
    concurrency = 1;
    const s = mk();
    const a = s.submit(job(SLOW), { source: "A" });
    const b = s.submit(job(), { source: "B" });
    const c = s.submit(job(), { source: "C", priority: true });
    expect(s.isActive(a)).toBe(true);
    expect(order(s)).toEqual(["C", "B"]);
    await s.idle();
    expect(s.get(a)!.status).toBe("succeeded");
    expect(Date.parse(s.get(c)!.startedAt)).toBeLessThanOrEqual(Date.parse(s.get(b)!.startedAt));
  });
});

describe("watcher priority", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let concurrency = 0;
  const cfg = (): Config => ({ ...ConfigSchema.parse({ protected_branches: [] }), concurrency });
  const watcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, ...over, flow: oldFlowFor(over) }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
    });
  const issues = (...list: [number, string[]?, string?][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, extra, createdAt]) => ({
      number, title: `issue ${number}`, createdAt: createdAt ?? `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
      labels: [{ name: "claude-factory" }, ...(extra ?? []).map((name) => ({ name }))],
    })));
  };

  beforeEach(() => {
    gh = fakeGithub();
    concurrency = 0;
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: cfg, claudeBin });
  });
  afterEach(() => gh.restore());

  it("starts a bug story before older ones and past max_per_tick", async () => {
    issues([3], [5, ["Bug"]], [9]);
    const w = watcher({ max_per_tick: 1 });
    await w.tick();
    const pending = scheduler.queue().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.issue).toBe("5");
    expect(pending[0]!.priority).toBe(true);
    const hold = w.status.holds!.find((h) => h.issue === 3)!;
    expect(hold.next.kind).toBe("bug_first");
    expect(hold.reason).toContain("waits: a bug story goes first");
    expect(w.tracked.find((t) => t.issue === 5)!.priority).toBe(true);
    expect(w.tracked.find((t) => t.issue === 3)!.priority).toBeUndefined();
  });

  it("does not limit bug stories by max_per_tick", async () => {
    issues([4, ["bug"]], [6, ["bug"]], [7]);
    const w = watcher({ max_per_tick: 1 });
    await w.tick();
    expect(scheduler.queue().pending.map((p) => p.issue)).toEqual(["4", "6"]);
    expect(w.status.holds!.find((h) => h.issue === 7)!.next.kind).toBe("bug_first");
  });

  it("treats the label as a normal one when priority_labels is empty or different", async () => {
    issues([3], [5, ["bug"]]);
    const w = watcher({ priority_labels: [] });
    await w.tick();
    expect(scheduler.queue().pending.map((p) => p.issue)).toEqual(["3"]);
    expect(w.tracked.some((t) => t.priority)).toBe(false);
  });

  it("puts a story that got the label in front, and back when the label is gone", async () => {
    issues([3], [5]);
    const w = watcher({ max_per_tick: 2 });
    await w.tick();
    expect(scheduler.queue().pending.map((p) => p.issue)).toEqual(["3", "5"]);
    issues([3], [5, ["bug"]]);
    const queued = scheduler.queue().pending.find((p) => p.issue === "5")!;
    // The issues are queued, so the check only reconciles them.
    await w.tick();
    expect(scheduler.queue().pending[0]!.runId).toBe(queued.runId);
    expect(scheduler.queue().pending[0]!.priority).toBe(true);
    issues([3], [5]);
    await w.tick();
    expect(scheduler.queue().pending.map((p) => p.issue)).toEqual(["3", "5"]);
    expect(scheduler.queue().pending.some((p) => p.priority)).toBe(false);
  });

  it("orders bug stories of different repositories by the age of the issue", async () => {
    issues([8, ["bug"], "2026-02-01T00:00:00Z"]);
    await watcher({ id: "a" }).tick();
    issues([2, ["bug"], "2026-01-01T00:00:00Z"]);
    await watcher({ id: "b", github_repo: "acme/other" }).tick();
    expect(scheduler.queue().pending.map((p) => p.issue)).toEqual(["2", "8"]);
  });

  it("orders bug stories by the age of the issue, not the number", async () => {
    concurrency = 1;
    issues([3, ["bug"], "2026-03-01T00:00:00Z"], [5, ["bug"], "2026-01-01T00:00:00Z"]);
    await watcher({ max_per_tick: 1 }).tick();
    await scheduler.idle();
    const started = (n: string) => Date.parse(scheduler.list().find((r) => r.vars.issue === n)!.startedAt);
    expect(started("5")).toBeLessThanOrEqual(started("3"));
    expect(scheduler.list().map((r) => r.vars.issue).sort()).toEqual(["3", "5"]);
  });

  it("checks bug stories for questions on their own, first", async () => {
    issues([3], [5, ["bug"]], [7]);
    const w = watcher({ precheck_flow: "epic-questions", max_per_tick: 3 });
    await w.tick();
    const pending = scheduler.queue().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.priority).toBe(true);
    expect(w.status.holds!.filter((h) => h.next.kind === "bug_first").map((h) => h.issue).sort()).toEqual([3, 7]);
  });

  describe("code area", () => {
    const AREA = "waiting for run holder-1 (src/shared)";
    const labels = (n: number) => (n === 6 ? ["bug"] : ["normal"]);
    const runOf = (n: string) => scheduler.list().find((r) => r.vars.issue === n)!.runId;
    /** Runs #5 and #6 to the end, then sets them back to "stepped aside for holder-1". */
    const steppedAside = async () => {
      concurrency = 2;
      issues([5, labels(5)], [6, labels(6)]);
      await watcher({ id: "seed", max_per_tick: 5 }).tick();
      await scheduler.idle();
      await new Promise((r) => setTimeout(r, 300));
      for (const n of ["5", "6"]) {
        const s = loadRun(join(gh.tmp, "runs"), runOf(n))!;
        Object.assign(s, { status: "stopped", reason: 'stopped at step "wait_for_area"', finishedAt: undefined });
        s.history.push({ ...s.history.at(-1)!, id: "claim_areas", output: AREA });
        saveRun(s);
      }
      concurrency = 0;
      issues([5, ["factory:working", ...labels(5)]], [6, ["factory:working", ...labels(6)]]);
    };

    it("gives a bug story the area first", async () => {
      await steppedAside();
      const w = watcher({ max_per_tick: 5 });
      await w.tick();
      expect(scheduler.queue().pending).toHaveLength(1);
      expect(scheduler.queue().pending[0]!.runId).toBe(runOf("6"));
      expect(scheduler.queue().pending[0]!.priority).toBe(true);
      expect(w.status.holds!.find((h) => h.issue === 5)!.next.kind).toBe("bug_first");
    });

    it("does so across two watchers of one repository", async () => {
      await steppedAside();
      const normal = watcher({ id: "n", max_per_tick: 5, exclude_labels: ["bug"] });
      const bug = watcher({ id: "b", max_per_tick: 5, exclude_labels: ["normal"] });
      const peers = () => [normal, bug].map((x) => ({ watcher: x.cfg, status: x.status, issues: x.tracked }));
      for (const x of [normal, bug]) (x as unknown as { d: { peers: typeof peers } }).d.peers = peers;
      await bug.tick();
      await normal.tick();
      expect(scheduler.queue().pending).toHaveLength(1);
      expect(scheduler.queue().pending[0]!.priority).toBe(true);
      expect(normal.status.holds!.find((h) => h.issue === 5)!.next.kind).toBe("bug_first");
    });
  });

  it("a job queued from the run page follows the label too", async () => {
    issues([3], [5]);
    const vars = { github_repo: "acme/app", issue: "5" };
    scheduler.submit({ kind: "run", flow: PLAIN, task: "", repo: gh.tmp, vars }, { source: "ui resume", lockKey: "acme/app#5", priority: true });
    scheduler.submit({ kind: "run", flow: PLAIN, task: "", repo: gh.tmp, vars: { ...vars, issue: "3" } }, { source: "ui resume", lockKey: "acme/app#3" });
    const w = watcher({ max_per_tick: 2 });
    await w.tick(); // #5 has no bug label: its job goes back
    expect(scheduler.queue().pending.some((p) => p.priority)).toBe(false);
    issues([3], [5, ["bug"]]);
    await w.tick();
    expect(scheduler.queue().pending[0]!.issue).toBe("5");
    expect(scheduler.queue().pending[0]!.priority).toBe(true);
  });

  it("a bug story still waits for its dependency", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "four", state: "OPEN", createdAt: "2026-01-04T00:00:00Z", labels: [{ name: "claude-factory" }], body: "" },
      { number: 5, title: "five", state: "OPEN", createdAt: "2026-01-05T00:00:00Z", labels: [{ name: "claude-factory" }, { name: "bug" }], body: "### Depends on\n#4" },
    ]);
    const w = watcher({ max_per_tick: 2 });
    await w.tick();
    expect(w.status.holds!.find((h) => h.issue === 5)!.next.kind).toBe("dependency");
    expect(scheduler.queue().pending.map((p) => p.issue)).toEqual(["4"]);
  });

  it("a bug story waits for the daily budget", async () => {
    issues([5, ["bug"]]);
    const w = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", flow: oldFlowFor() }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {}, dailyBudget: () => 0,
    });
    await w.tick();
    expect(w.status.holds!.find((h) => h.issue === 5)!.next.kind).toBe("daily_budget");
    expect(scheduler.queue().pending).toHaveLength(0);
  });
});
