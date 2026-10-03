import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { Names } from "../src/monitor/clean.js";
import type { FindingInput } from "../src/monitor/findings.js";
import type { RateReading } from "../src/github.js";
import { loadFindings } from "../src/monitor/findings.js";
import { Monitor } from "../src/monitor/monitor.js";
import { buildLabelFor, Reporter } from "../src/monitor/report.js";
import { markerFor } from "../src/monitor/story.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub, type FakeIssue } from "./helpers/fake-github.js";

const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 1, 12, 0, 0); // local noon, so +24 hours is the next day
const at = (h: number) => new Date(T0.getTime() + h * HOUR);
const NAMES: Names = { target: "acme/app", users: [], emails: [], repos: [], watchers: [], complete: true };
const TARGET = "acme/app";

describe("bug stories from the monitor", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let file: string;
  let scheduler: Scheduler;
  let found: FindingInput[];
  let report_to: string | undefined;
  let limits: { per_day: number; per_check: number };
  let label: string | undefined;
  let rate: (() => RateReading) | undefined;
  let clock: Date;
  let logLines: string[];

  const fi = (id: string, severity: FindingInput["severity"] = "critical", over: Partial<FindingInput> = {}): FindingInput => ({
    detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity, summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [at(0).toISOString()], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] }, ...over,
  });
  const cfg = () => ConfigSchema.parse({ monitor: { ...(report_to ? { report_to } : {}), report_limits: limits } }).monitor;
  const newReporter = () => new Reporter({ config: cfg, buildLabel: () => label, names: () => NAMES, builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }), rateLimit: () => rate?.(), log: (m) => logLines.push(m) });
  const newMonitor = (reporter = newReporter()) =>
    new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler, watchers: () => [], thresholds: cfg, log: () => {}, file, now: () => clock, reporter, detectors: [{ name: "t", description: "test", run: () => found }],
    });
  let monitor: Monitor;
  const check = async (h: number, m = monitor) => {
    clock = at(h);
    await m.tick();
    return m.status;
  };
  const stored = () => loadFindings(file).findings;
  const calls = () => gh.ghLog().split("\n").filter((l) => /^gh (api|label|issue comment)/.test(l) && !l.startsWith("gh api rate_limit"));
  const issue = (n: number, fp: string, over: Partial<FakeIssue> = {}): FakeIssue => ({
    number: n, state: "open", state_reason: null, title: "t", body: `text\n\n${markerFor(`restart-loop|${fp}`)}`, labels: [{ name: "bug" }],
    html_url: `https://github.com/${TARGET}/issues/${n}`, created_at: at(0).toISOString(), closed_at: null, ...over,
  });
  const close = (n: number, h: number, reason = "completed") => gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? { ...i, state: "closed", state_reason: reason, closed_at: at(h).toISOString() } : i)));
  const reopen = (n: number) => gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? { ...i, state: "open", state_reason: "reopened", closed_at: null } : i)));

  beforeEach(() => {
    gh = fakeGithub();
    file = join(gh.tmp, "monitor-findings.json");
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) });
    found = [fi("a")];
    report_to = TARGET;
    limits = { per_day: 3, per_check: 1 };
    label = "go";
    rate = undefined;
    logLines = [];
    monitor = newMonitor();
  });
  afterEach(() => gh.restore());

  it("does nothing without report_to", async () => {
    report_to = undefined;
    await check(0);
    await check(1);
    expect(gh.ghLog()).toBe("");
    expect(stored()[0]!.report).toBeUndefined();
  });

  it("makes a story at the second check, with the text on stdin and not in the command line", async () => {
    await check(0);
    expect(calls()).toHaveLength(0);
    await check(1);
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: "Runs that step aside are restarted in a loop", labels: ["bug", "go"] });
    expect(made[0]!.body).toContain(markerFor("restart-loop|a"));
    for (const l of gh.ghLog().split("\n").filter((x) => x.startsWith("gh "))) {
      expect(l).not.toContain("Runs that step aside");
      expect(l).not.toContain("## What happened");
    }
    expect(stored()[0]!.report).toMatchObject({ repo: TARGET, issue: 101, seen: 0 });
    expect(stored()[0]!.due).toBeUndefined();
  });

  it("writes only the label bug and says so when no watcher builds stories; picks the issue-gitflow watcher's label", async () => {
    label = undefined;
    await check(0);
    const st = await check(1);
    expect(gh.createdBodies()[0]!.labels).toEqual(["bug"]);
    expect(st.notes?.join(" ")).toContain("No watcher builds bug stories");
    const w = (id: string, flow: string, l: string, over: Record<string, unknown> = {}) => ({ id, enabled: true, source: "issues", github_repo: "Acme/App", flow, label: l, ...over });
    expect(buildLabelFor([w("p", "issue-plan", "plan"), w("b", "issue-gitflow", "build")], TARGET)).toBe("build");
    expect(buildLabelFor([w("p", "issue-plan", "plan"), w("o", "other", "x")], TARGET)).toBe("plan");
    expect(buildLabelFor([w("d", "default", "go", { enabled: false })], TARGET)).toBeUndefined();
    expect(buildLabelFor([w("d", "default", "go", { source: "ci-failures" })], TARGET)).toBeUndefined();
  });

  it("does not make a story for a problem that was seen, missed and seen again (not two checks in a row)", async () => {
    await check(0);
    found = [];
    await check(1);
    found = [fi("a")];
    await check(2);
    expect(gh.createdBodies()).toHaveLength(0);
    await check(3);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("still makes the owed story when GitHub was down for more than 30 days", async () => {
    await check(0);
    process.env.FAKE_GH_FAIL_API = "list";
    await check(1);
    found = [];
    await check(30); // gone
    await check(24 * 45);
    expect(stored()[0]!.due).toBeDefined();
    delete process.env.FAKE_GH_FAIL_API;
    await check(24 * 45 + 1);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("makes no second story; comments at most every 6 hours", async () => {
    await check(0);
    await check(1);
    await check(2);
    await check(6);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(gh.comments()).toHaveLength(0);
    await check(7);
    expect(gh.comments()).toHaveLength(1);
    expect(gh.comments()[0]).toMatchObject({ issue: 101 });
    expect(gh.comments()[0]!.body).toMatch(/^Seen again: \d+ times since 2026-10-01/);
    await check(8);
    await check(12);
    expect(gh.comments()).toHaveLength(1);
    await check(13);
    expect(gh.comments()).toHaveLength(2);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("does not comment twice when the answer of the first comment was lost", async () => {
    await check(0);
    await check(1);
    process.env.FAKE_GH_FAIL = "issue comment";
    await check(7);
    expect(gh.comments()).toHaveLength(0);
    delete process.env.FAKE_GH_FAIL;
    const again = newMonitor(newReporter()); // a new instance, as after a restart
    await check(8, again);
    await check(10, again);
    expect(gh.comments()).toHaveLength(0);
    await check(13, again);
    expect(gh.comments()).toHaveLength(1);
  });

  it("makes an owed story later, also when the problem is gone, after GitHub was down", async () => {
    await check(0);
    process.env.FAKE_GH_FAIL_API = "list";
    const st = await check(1);
    expect(st.lastError).toBeUndefined();
    expect(st.notes?.join(" ")).toContain("1 bug story waits: GitHub did not answer");
    expect(gh.createdBodies()).toHaveLength(0);
    expect(stored()[0]!.due).toBeDefined();
    delete process.env.FAKE_GH_FAIL_API;
    found = [];
    await check(2);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(stored()[0]!.report?.issue).toBe(101);
  });

  it("makes an owed story later when the per-check limit held it back", async () => {
    found = [fi("a"), fi("b", "major")];
    await check(0);
    const st = await check(1);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(st.notes?.join(" ")).toContain("1 bug story waits: at most 1 new bug story per check.");
    found = [];
    await check(2);
    expect(gh.createdBodies()).toHaveLength(2);
  });

  describe("adoption", () => {
    it("an open match: no new story", async () => {
      gh.setBugIssues([issue(40, "a")]);
      await check(0);
      await check(1);
      expect(gh.createdBodies()).toHaveLength(0);
      expect(stored()[0]!.report).toMatchObject({ issue: 40 });
    });

    it("a closed completed match: a successor that links it", async () => {
      gh.setBugIssues([issue(40, "a", { state: "closed", state_reason: "completed", closed_at: at(-48).toISOString() })]);
      await check(0);
      await check(1);
      const made = gh.createdBodies();
      expect(made).toHaveLength(1);
      expect(made[0]!.body).toContain("Came back after the fix");
      expect(made[0]!.body).toContain("#40");
    });

    it("a match closed as not planned: muted, no story", async () => {
      gh.setBugIssues([issue(40, "a", { state: "closed", state_reason: "not_planned", closed_at: at(-48).toISOString() })]);
      await check(0);
      const st = await check(1);
      expect(gh.createdBodies()).toHaveLength(0);
      expect(stored()[0]!.report?.muted).toBe(true);
      expect(st.notes?.join(" ")).toContain("#40");
    });

    it("an older open story wins over a newer closed one", async () => {
      gh.setBugIssues([issue(40, "a"), issue(41, "a", { state: "closed", state_reason: "completed", closed_at: at(-1).toISOString() })]);
      await check(0);
      await check(1);
      expect(gh.createdBodies()).toHaveLength(0);
      expect(stored()[0]!.report).toMatchObject({ issue: 40 });
      expect(stored()[0]!.report?.closedAt).toBeUndefined();
    });

    it("a known story that the list does not show is read with one call and no new story is made", async () => {
      await check(0);
      await check(1);
      process.env.FAKE_GH_BUG_ISSUES = "[]"; // the list shows nothing (older than the newest 100, or its label was removed)
      await check(8);
      expect(gh.createdBodies()).toHaveLength(1);
      expect(gh.ghLog().split("\n").filter((l) => l === "gh api repos/acme/app/issues/101")).toHaveLength(1);
      expect(gh.comments()).toHaveLength(1);
    });

    it("a story that does not exist any more is forgotten and written again", async () => {
      await check(0);
      await check(1);
      process.env.FAKE_GH_BUG_ISSUES = "[]";
      gh.setBugIssues([]);
      await check(8); // read: 404, report dropped; next check: the finding is ripe again
      await check(9);
      expect(gh.createdBodies()).toHaveLength(2);
    });
  });

  describe("coming back", () => {
    const made = async () => {
      await check(0);
      await check(1);
      close(101, 2);
    };

    it("is not a new story while the problem is seen but there is no new evidence", async () => {
      await made();
      await check(8);
      await check(30);
      await check(50);
      expect(gh.createdBodies()).toHaveLength(1);
      expect(stored()[0]!.report?.closedAt).toBeDefined();
    });

    it("needs 24 hours after the close and evidence from after it", async () => {
      found = [fi("a", "critical", { evidence: { counts: { runs: 2 }, times: [at(3).toISOString()], flows: ["issue-gitflow"] } })];
      await made();
      await check(8);
      expect(gh.createdBodies()).toHaveLength(1);
      await check(27);
      const bodies = gh.createdBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]!.body).toContain("Came back after the fix");
      expect(bodies[1]!.body).toContain("#101");
    });

    it("counts a missed check after the close as proof", async () => {
      await made();
      await check(8);
      found = [];
      await check(10);
      found = [fi("a")];
      await check(30);
      expect(gh.createdBodies()).toHaveLength(2);
    });

    it("counts a gone and reopened finding as proof", async () => {
      await made();
      await check(8);
      found = [];
      await check(10);
      await check(35); // not seen for more than 24 hours: gone
      found = [fi("a")];
      await check(40);
      expect(gh.createdBodies()).toHaveLength(2);
    });

    it("a story closed as not planned is muted until it is reopened; then it is commented again", async () => {
      await check(0);
      await check(1);
      close(101, 2, "not_planned");
      await check(8);
      let st = await check(30);
      expect(gh.createdBodies()).toHaveLength(1);
      expect(st.notes?.join(" ")).toContain("#101");
      expect(stored()[0]!.report?.muted).toBe(true);
      reopen(101);
      await check(37);
      st = await check(38);
      expect(stored()[0]!.report?.muted).toBeUndefined();
      expect(gh.comments().length).toBeGreaterThan(0);
      expect(gh.createdBodies()).toHaveLength(1);
    });
  });

  describe("minor findings", () => {
    beforeEach(() => {
      found = [fi("m", "minor")];
    });

    it("make a story on the third different day", async () => {
      await check(0);
      await check(1); // same day
      await check(24);
      expect(gh.createdBodies()).toHaveLength(0);
      await check(48);
      expect(gh.createdBodies()).toHaveLength(1);
    });

    it("come back after 3 days after the close", async () => {
      await check(0);
      await check(24);
      await check(48);
      close(101, 49);
      found = [fi("m", "minor", { evidence: { counts: { runs: 2 }, times: [at(50).toISOString()], flows: ["issue-gitflow"] } })];
      await check(72);
      await check(96);
      expect(gh.createdBodies()).toHaveLength(1);
      await check(120);
      expect(gh.createdBodies()).toHaveLength(2);
    });
  });

  describe("limits", () => {
    it("makes the most severe first, one per check, and says what waits", async () => {
      found = [fi("a", "major"), fi("b", "critical"), fi("c", "major")];
      await check(0);
      const st = await check(1);
      expect(gh.createdBodies()).toHaveLength(1);
      expect(gh.createdBodies()[0]!.body).toContain(markerFor("restart-loop|b"));
      expect(st.notes?.join(" ")).toContain("2 bug stories wait");
      await check(2);
      await check(3);
      expect(gh.createdBodies()).toHaveLength(3);
    });

    it("stops at the day limit and goes on the next day", async () => {
      limits = { per_day: 3, per_check: 3 };
      found = [fi("a"), fi("b"), fi("c"), fi("d")];
      await check(0);
      const st = await check(1);
      expect(gh.createdBodies()).toHaveLength(3);
      expect(st.notes?.join(" ")).toContain("1 bug story waits: at most 3 new bug stories a day.");
      await check(2);
      expect(gh.createdBodies()).toHaveLength(3);
      await check(25);
      expect(gh.createdBodies()).toHaveLength(4);
    });

    it("counts a story adopted today against the day limit", async () => {
      limits = { per_day: 1, per_check: 1 };
      found = [fi("a"), fi("b")];
      gh.setBugIssues([issue(40, "a")]);
      await check(0);
      await check(1);
      expect(gh.createdBodies()).toHaveLength(0);
      expect(stored().find((f) => f.fingerprint.endsWith("|b"))!.due).toBeDefined();
    });
  });

  it("when GitHub is down, loses nothing and shows a note", async () => {
    await check(0);
    process.env.FAKE_GH_FAIL_API = "list";
    const st = await check(1);
    expect(gh.createdBodies()).toHaveLength(0);
    expect(st.lastError).toBeUndefined();
    expect(st.notes?.join(" ")).toContain("GitHub did not answer or refused the call");
    expect(stored()).toHaveLength(1);
    delete process.env.FAKE_GH_FAIL_API;
    await check(2);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("asks nothing while the request limit is used up", async () => {
    rate = () => ({ at: at(1).toISOString(), resources: { core: { limit: 5000, used: 5000, remaining: 0, reset: at(2).getTime() / 1000 } } });
    await check(0);
    const st = await check(1);
    expect(calls()).toHaveLength(0);
    expect(st.notes?.join(" ")).toContain("request limit is used up");
    rate = undefined;
    await check(3);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("records nothing when the create fails after a good list, and makes exactly one story next time", async () => {
    await check(0);
    process.env.FAKE_GH_FAIL_API = "create";
    await check(1);
    expect(stored()[0]!.report).toBeUndefined();
    expect(gh.createdBodies()).toHaveLength(0);
    delete process.env.FAKE_GH_FAIL_API;
    await check(2);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  describe("labels", () => {
    const labelCalls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh label create"));

    it("creates missing labels without --force", async () => {
      await check(0);
      await check(1);
      expect(labelCalls()).toHaveLength(2);
      expect(labelCalls().every((l) => !l.includes("--force"))).toBe(true);
      expect(gh.labels()).toEqual(["bug", "go"]);
    });

    it("accepts labels that exist", async () => {
      gh.setLabels(["bug", "go"]);
      await check(0);
      const st = await check(1);
      expect(st.lastError).toBeUndefined();
      expect(gh.createdBodies()).toHaveLength(1);
    });

    it("creates each label once over two stories", async () => {
      limits = { per_day: 3, per_check: 2 };
      found = [fi("a"), fi("b")];
      await check(0);
      await check(1);
      expect(gh.createdBodies()).toHaveLength(2);
      expect(labelCalls()).toHaveLength(2);
    });

    it("lets the story wait when a label cannot be made", async () => {
      await check(0);
      process.env.FAKE_GH_FAIL = "label create";
      const st = await check(1);
      expect(gh.createdBodies()).toHaveLength(0);
      expect(st.notes?.join(" ")).toContain("GitHub did not answer");
      delete process.env.FAKE_GH_FAIL;
      await check(2);
      expect(gh.createdBodies()).toHaveLength(1);
    });

    it("makes a deleted label again after a failed create", async () => {
      found = [fi("a")];
      await check(0);
      await check(1);
      expect(labelCalls()).toHaveLength(2);
      found = [fi("a"), fi("b")];
      await check(2);
      process.env.FAKE_GH_FAIL_API = "create";
      await check(3);
      delete process.env.FAKE_GH_FAIL_API;
      gh.setLabels([]);
      await check(4);
      expect(labelCalls().length).toBeGreaterThanOrEqual(4);
      expect(gh.createdBodies()).toHaveLength(2);
    });
  });

  it("defers the comment when the budget is used up", async () => {
    await check(0);
    await check(1);
    limits = { per_day: 10, per_check: 3 };
    found = [fi("a"), fi("b"), fi("c"), fi("d")];
    const fresh = newMonitor(newReporter()); // labels are not known yet: 2 label calls
    await check(2, fresh); // b, c and d are seen for the first time
    const before = calls().length;
    await check(8, fresh); // they are owed now, and story 101 is due for a comment
    expect(calls().length - before).toBeLessThanOrEqual(6);
    expect(gh.createdBodies()).toHaveLength(4); // 1 + 3 new
    expect(gh.comments()).toHaveLength(0); // list 1 + labels 2 + creates 3 = 6: no call left
    await check(9, fresh);
    expect(gh.comments()).toHaveLength(1);
  });

  it("ignores a story in another repository when report_to changes", async () => {
    await check(0);
    await check(1);
    report_to = "acme/other";
    process.env.FAKE_GH_BUG_ISSUES = "[]";
    await check(2);
    expect(gh.createdBodies()).toHaveLength(2);
  });

  it("refuses bad settings and has defaults", () => {
    expect(ConfigSchema.safeParse({ monitor: { report_to: "x" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ monitor: { report_limits: { per_check: 4 } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ monitor: { report_to: "acme/app" } }).success).toBe(true);
    const m = ConfigSchema.parse({}).monitor;
    expect(m.report_limits).toEqual({ per_day: 3, per_check: 1 });
    expect(m.report_to).toBeUndefined();
    expect(m.cooldown_minutes).toBe(10);
    expect(ConfigSchema.safeParse({ monitor: { cooldown_minutes: 0 } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ monitor: { cooldown_minutes: -1 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ monitor: { cooldown_minutes: 1.5 } }).success).toBe(false);
  });
});
