import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { cleanLine, errorKind } from "../src/errors.js";
import type { RateReading } from "../src/github.js";
import { join } from "node:path";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { DETECTORS, runDetectors, type DetectorInput } from "../src/monitor/detectors.js";
import type { FindingInput } from "../src/monitor/findings.js";
import { fakeGithub } from "./helpers/fake-github.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const config = ConfigSchema.parse({}).monitor;

let n = 0;
const run = (over: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: `20261001-1200${String(++n).padStart(2, "0")}-abcd`, flow: "issue-gitflow", task: "t", status: "failed", startedAt: ago(10 * MIN), finishedAt: ago(5 * MIN),
    vars: { github_repo: "acme/app" }, history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} }, runDir: "/tmp/none", ...over,
  }) as unknown as RunSummary;
const rec = (over: Partial<StepRecord> = {}): StepRecord =>
  ({ id: "build", type: "shell", visit: 1, ok: false, output: "", startedAt: ago(MIN), durationMs: 1, logFile: "x", ...over }) as StepRecord;
/** A run that was resumed `count` times, `gap` ms apart, the newest at `last` ms ago. */
const resumed = (count: number, gap: number, from: string | string[] = "claim_areas", over: Partial<RunSummary> = {}) =>
  run({ status: "stopped", resumeLog: Array.from({ length: count }, (_, i) => ({ at: ago((count - 1 - i) * gap), from: Array.isArray(from) ? from[i % from.length]! : from })), ...over });
const failed = (error: string, over: Partial<RunSummary> = {}, step = "build") =>
  run({ reason: `step "${step}" failed: ${error}`, history: [rec({ id: step, error })], ...over });

const input = (over: Partial<DetectorInput> = {}): DetectorInput => ({ now: NOW, asleep: false, config, runs: [], watchers: [], log: [], queue: { pending: [], active: [], concurrency: 2 }, monitorId: "mon", ...over });
const find = (name: string, over: Partial<DetectorInput> = {}): FindingInput[] => DETECTORS.find((d) => d.name === name)!.run(input(over));
const withConfig = (patch: Record<string, unknown>) => ConfigSchema.parse({ monitor: patch }).monitor;

describe("restart loop", () => {
  it("finds stepped-aside runs restarted every 25 seconds", () => {
    const f = find("restart-loop", { runs: [resumed(24, 25 * SEC)] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", fingerprint: "restart-loop|issue-gitflow|claim_areas", about: "foundry" });
    expect(f[0]!.summary).toContain("24 times in 10 minutes");
    expect(JSON.stringify(f[0])).not.toMatch(/20261001-/); // no run id
  });

  it("is not found at the threshold or when spread out", () => {
    expect(find("restart-loop", { runs: [resumed(5, 25 * SEC)] })).toEqual([]);
    expect(find("restart-loop", { runs: [resumed(6, 5 * MIN)] })).toEqual([]);
    expect(find("restart-loop", { runs: [resumed(6, 25 * SEC)] })).toHaveLength(1);
  });

  it("uses the threshold of the config", () => {
    expect(find("restart-loop", { runs: [resumed(6, 25 * SEC)], config: withConfig({ restart_loop: { resumes: 6 } }) })).toEqual([]);
  });

  it("gives the same fingerprint for a second run in the loop, another one for another step or flow", () => {
    const one = find("restart-loop", { runs: [resumed(8, 25 * SEC)] })[0]!;
    const two = find("restart-loop", { runs: [resumed(8, 25 * SEC), resumed(9, 20 * SEC)] });
    expect(two).toHaveLength(1);
    expect(two[0]!.fingerprint).toBe(one.fingerprint);
    expect(two[0]!.evidence.counts!.runs).toBe(2);
    expect(find("restart-loop", { runs: [resumed(8, 25 * SEC, "other")] })[0]!.fingerprint).not.toBe(one.fingerprint);
    expect(find("restart-loop", { runs: [resumed(8, 25 * SEC, "claim_areas", { flow: "other-flow" })] })[0]!.fingerprint).not.toBe(one.fingerprint);
  });

  it("keeps one fingerprint when a run takes turns between two steps", () => {
    const a = find("restart-loop", { runs: [resumed(8, 25 * SEC, ["a", "b"])] });
    const b = find("restart-loop", { runs: [resumed(9, 25 * SEC, ["a", "b"])] });
    expect(a).toHaveLength(1);
    expect(a[0]!.fingerprint).toBe("restart-loop|issue-gitflow|a+b");
    expect(b[0]!.fingerprint).toBe(a[0]!.fingerprint);
  });
});

describe("watcher error and watcher silent (with a real watcher)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => gh.restore());

  const watcher = (id = "w") =>
    new Watcher(WatcherSchema.parse({ id, github_repo: "acme/app", flow: "issue-gitflow" }), { scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }), runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {} });
  const ticks = async (w: Watcher, count: number) => { for (let i = 0; i < count; i++) await w.tick(); };
  const entry = (w: Watcher) => ({ cfg: w.cfg, status: w.status });

  it("finds a check that failed more than 3 times in a row, and not 3 times", async () => {
    process.env.FAKE_GH_FAIL = "issue list";
    const w = watcher();
    await ticks(w, 3);
    expect(find("watcher-error", { watchers: [entry(w)] })).toEqual([]);
    await ticks(w, 1);
    const f = find("watcher-error", { watchers: [entry(w)] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "major", evidence: { watchers: ["w"], counts: { failed_checks: 4 } } });
    delete process.env.FAKE_GH_FAIL;
    await w.tick();
    expect(find("watcher-error", { watchers: [entry(w)] })).toEqual([]);
  });

  it("groups watchers with the same kind of error, and tells another kind apart", async () => {
    process.env.FAKE_GH_FAIL = "issue list";
    const a = watcher("a");
    const b = watcher("b");
    await ticks(a, 4);
    await ticks(b, 4);
    const both = find("watcher-error", { watchers: [entry(a), entry(b)] });
    expect(both).toHaveLength(1);
    expect(both[0]!.evidence.watchers).toEqual(["a", "b"]);
    process.env.FAKE_GH_FAIL = "repo view";
    const c = watcher("c");
    await ticks(c, 4);
    const other = find("watcher-error", { watchers: [entry(c)] });
    expect(other[0]!.fingerprint).not.toBe(both[0]!.fingerprint);
  });

  it("leaves a request-limit error to the github-limit detector", async () => {
    process.env.FAKE_GH_FAIL = "issue list";
    process.env.FAKE_GH_FAIL_TEXT = "API rate limit exceeded";
    const w = watcher();
    await ticks(w, 4);
    expect(find("watcher-error", { watchers: [entry(w)] })).toEqual([]);
    expect(find("github-limit", { watchers: [entry(w)] })[0]).toMatchObject({ fingerprint: "github-limit|core", severity: "critical" });
  });

  it("finds a silent watcher after 5 intervals, not before, and not after a sleep", () => {
    const cfg = WatcherSchema.parse({ id: "w", github_repo: "acme/app", every: "5m" });
    const status = { id: "w", lastActions: [], lastTick: NOW.toISOString() };
    const at = (min: number) => new Date(NOW.getTime() + min * MIN);
    expect(find("watcher-silent", { now: at(26), watchers: [{ cfg, status }] })).toHaveLength(1);
    expect(find("watcher-silent", { now: at(24), watchers: [{ cfg, status }] })).toEqual([]);
    expect(find("watcher-silent", { now: at(26), asleep: true, watchers: [{ cfg, status }] })).toEqual([]);
    expect(find("watcher-silent", { now: at(26), watchers: [{ cfg: { ...cfg, enabled: false }, status }] })).toEqual([]);
  });

  it("gives each silent watcher its own finding, which stays when another one works again", () => {
    const mk = (id: string) => WatcherSchema.parse({ id, github_repo: "acme/app", every: "5m" });
    const old = { lastActions: [], lastTick: NOW.toISOString() };
    const now = new Date(NOW.getTime() + 30 * MIN);
    const both = find("watcher-silent", { now, watchers: [{ cfg: mk("a"), status: { id: "a", ...old } }, { cfg: mk("b"), status: { id: "b", ...old } }] });
    expect(both.map((f) => f.fingerprint).sort()).toEqual(["watcher-silent|a", "watcher-silent|b"]);
    const healed = find("watcher-silent", { now, watchers: [{ cfg: mk("a"), status: { id: "a", ...old } }, { cfg: mk("b"), status: { id: "b", lastActions: [], lastTick: now.toISOString() } }] });
    expect(healed.map((f) => f.fingerprint)).toEqual(["watcher-silent|a"]);
  });
});

describe("github limit", () => {
  const reading = (core: Partial<{ used: number; remaining: number; reset: number }>, at = NOW.toISOString(), key = "core"): RateReading => ({
    at, resources: { [key]: { limit: 5000, used: 4100, remaining: 900, reset: NOW.getTime() / 1000 + 1800, ...core } },
  });
  const line = (text: string, at = NOW) => ({ at: at.toISOString(), text });

  it("reads the stored numbers: over 80% is major, under is nothing, none left is critical", () => {
    expect(find("github-limit", { rate: reading({ used: 4100 }) })[0]).toMatchObject({ severity: "major", fingerprint: "github-limit|core" });
    expect(find("github-limit", { rate: reading({ used: 3900, remaining: 1100 }) })).toEqual([]);
    expect(find("github-limit", { rate: reading({ used: 5000, remaining: 0 }) })[0]!.severity).toBe("critical");
    expect(find("github-limit", { rate: reading({ used: 3900, remaining: 1100 }), config: withConfig({ github_limit: { percent: 70 } }) })).toHaveLength(1);
  });

  it("tells core and graphql apart, and the same one again is the same", () => {
    const core = find("github-limit", { rate: reading({}) })[0]!;
    const graphql = find("github-limit", { rate: reading({}, NOW.toISOString(), "graphql") })[0]!;
    expect(graphql.fingerprint).toBe("github-limit|graphql");
    expect(find("github-limit", { rate: reading({}) })[0]!.fingerprint).toBe(core.fingerprint);
  });

  it("reads every resource, also another identity's, and ignores an old watcher error", () => {
    expect(find("github-limit", { rate: reading({}, NOW.toISOString(), "search") })[0]!.fingerprint).toBe("github-limit|search");
    expect(find("github-limit", { rate: reading({}, NOW.toISOString(), "bot:core") })[0]!.fingerprint).toBe("github-limit|bot:core");
    const cfg = WatcherSchema.parse({ id: "w", github_repo: "acme/app", every: "1d" });
    const status = (lastTick: string) => ({ id: "w", lastActions: [], lastError: "API rate limit exceeded", lastTick });
    expect(find("github-limit", { watchers: [{ cfg, status: status(ago(10 * MIN)) }] })).toHaveLength(1);
    expect(find("github-limit", { watchers: [{ cfg, status: status(ago(3 * HOUR)) }] })).toEqual([]);
  });

  it("merges repeated hits: counts, times, steps and lines", () => {
    const f = find("github-limit", {
      rate: reading({ used: 5000, remaining: 0 }),
      log: [line("API rate limit exceeded for user 1"), line("API rate limit exceeded for user 2", new Date(NOW.getTime() - MIN))],
      runs: [failed("exit code 1", { history: [rec({ id: "push", error: "exit code 1", output: "API rate limit exceeded" })] })],
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.evidence.counts!.hits).toBe(3);
    expect(f[0]!.evidence.steps).toContain("push");
    expect(f[0]!.evidence.times!.length).toBeGreaterThan(1);
  });

  it("ignores a reading that is older than an hour or past its reset", () => {
    expect(find("github-limit", { rate: reading({}, ago(61 * MIN)) })).toEqual([]);
    expect(find("github-limit", { rate: reading({ reset: NOW.getTime() / 1000 - 1 }) })).toEqual([]);
  });

  it("finds the limit in a log line, but not the monitor's own lines or old lines", () => {
    expect(find("github-limit", { log: [line("gh: API rate limit exceeded for user")] })[0]).toMatchObject({ severity: "critical", fingerprint: "github-limit|core" });
    expect(find("github-limit", { log: [line("You have exceeded a secondary rate limit")] })[0]!.fingerprint).toBe("github-limit|secondary");
    expect(find("github-limit", { log: [line("GraphQL: API rate limit already exceeded")] })[0]!.fingerprint).toBe("github-limit|graphql");
    expect(find("github-limit", { log: [line("[mon] new finding (critical) github-limit: API rate limit exceeded")] })).toEqual([]);
    expect(find("github-limit", { log: [line("API rate limit exceeded", new Date(NOW.getTime() - 2 * HOUR))] })).toEqual([]);
  });

  it("finds it in a failed run: shell output, step error; not an agent's quote or an old run", () => {
    const shell = failed("exit code 1", { history: [rec({ error: "exit code 1", output: "x\nHTTP 403: API rate limit exceeded\n" })] });
    expect(find("github-limit", { runs: [shell] })[0]).toMatchObject({ severity: "critical", fingerprint: "github-limit|core" });
    const secondary = failed("exit code 1", { history: [rec({ error: "exit code 1", output: "You have exceeded a secondary rate limit" })] });
    expect(find("github-limit", { runs: [secondary] })[0]!.fingerprint).toBe("github-limit|secondary");
    const agentError = failed("claude result: API rate limit exceeded", { history: [rec({ type: "claude", error: "claude result: API rate limit exceeded" })] });
    expect(find("github-limit", { runs: [agentError] })).toHaveLength(1);
    const quote = failed("exit code 1", { reason: undefined, history: [rec({ type: "claude", error: "claude exited with code 1", output: "the docs say: API rate limit exceeded" })] });
    expect(find("github-limit", { runs: [quote] })).toEqual([]);
    expect(find("github-limit", { runs: [{ ...shell, finishedAt: ago(2 * HOUR) } as RunSummary] })).toEqual([]);
  });
});

describe("unexplained failure", () => {
  const pass = (over: Partial<RunSummary> = {}, error = "output did not match pass_if /ok/") => failed(error, over);

  it("finds an error no rule explains, as a minor problem of the project", () => {
    const f = find("unexplained-failure", { runs: [pass()] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "minor", about: "project", repo: "acme/app", detector: "unexplained-failure" });
    expect(f[0]!.evidence).toMatchObject({ steps: ["build"], flows: ["issue-gitflow"], repos: ["acme/app"] });
  });

  it("does not find what a rule explains", () => {
    for (const error of ["exit code 3", "timed out after 60s", "internal error: boom"]) expect(find("unexplained-failure", { runs: [failed(error)] })).toEqual([]);
    const auth = failed("exit code 1", { history: [rec({ error: "exit code 1", output: "fatal: Authentication failed for 'https://github.com/a/b'" })] });
    expect(find("unexplained-failure", { runs: [auth] })).toEqual([]);
  });

  it("counts runs against the threshold", () => {
    const two = withConfig({ unexplained_failure: { runs: 2 } });
    expect(find("unexplained-failure", { runs: [pass()], config: two })).toEqual([]);
    const f = find("unexplained-failure", { runs: [pass(), pass()], config: two });
    expect(f).toHaveLength(1);
    expect(f[0]!.fingerprint).toBe(find("unexplained-failure", { runs: [pass()] })[0]!.fingerprint);
  });

  it("gives another fingerprint for another step, error or repository, and ignores a failure note", () => {
    const base = find("unexplained-failure", { runs: [pass()] })[0]!.fingerprint;
    const fp = (r: RunSummary) => find("unexplained-failure", { runs: [r] })[0]!.fingerprint;
    expect(fp(failed("output did not match pass_if /ok/", {}, "test"))).not.toBe(base);
    expect(fp(pass({}, "output did not match pass_if /other/"))).not.toBe(base);
    expect(fp(pass({ vars: { github_repo: "acme/other" } }))).not.toBe(base);
    expect(fp(pass({ failureNote: { kind: "code", why: "tests fail", by: "claude:anthropic:haiku" } }))).toBe(base);
    expect(fp(pass({ vars: { github_repo: "owner/repo" } }))).not.toContain("owner/repo");
  });

  it("ignores a run that ended long ago", () => {
    expect(find("unexplained-failure", { runs: [pass({ finishedAt: ago(48 * HOUR) })] })).toEqual([]);
  });
});

describe("cleanLine and errorKind", () => {
  it("removes run ids, folders, tokens and long numbers, and keeps short codes", () => {
    const out = cleanLine("run 20261001-120001-abcd in /Users/me/.claude-factory/runs/x token ghp_abcdefghijklmnop pid 123456 exit code 1");
    expect(out).toBe("run <run> in <path> token <token> pid <n> exit code 1");
    for (const [a, b] of [
      ["failed at 12:34", "failed at 03:05:09"],
      ["failed at 2026-10-01T12:34:56+02:00", "failed at 2026-11-05T01:02:03-05:00"],
      ["failed on 2026-10-01 12:34:56", "failed on 2026-11-05 01:02:03"],
      ["reset on 10/01/2026", "reset on 11/5/2026"],
    ]) expect(cleanLine(a!)).toBe(cleanLine(b!));
    expect(errorKind("cannot access acme/app: HTTP 500 at /tmp/x/y")).toBe(errorKind("cannot access acme/app: HTTP 500 at /var/z/w"));
  });
});

describe("runDetectors", () => {
  it("turns a crash into a finding and still runs the next detector; hides paths", () => {
    const out = runDetectors(
      [
        { name: "boom", description: "", run: () => { throw new Error("cannot read /Users/me/secret/file"); } },
        { name: "ok", description: "", run: () => [{ detector: "ok", fingerprint: "ok|1", severity: "minor", summary: "s", evidence: {}, about: "foundry" }] },
      ],
      input(),
    );
    expect(out.map((f) => f.fingerprint)).toEqual(["detector-failed|boom", "ok|1"]);
    expect(out[0]!.summary).toBe("Detector boom failed, so its problems are not checked.");
    expect(JSON.stringify(out[0])).not.toContain("/Users/me");
  });
});

describe("self-update", () => {
  const sha = "a".repeat(40);
  const failed = (over: Record<string, unknown> = {}) => ({ commit: sha, stage: "test", at: "2026-10-01T11:00:00.000Z", lines: ["1 failed"], ...over });
  const check = (state: Record<string, unknown>, broken = false) => find("self-update", { update: { state: state as never, broken } });

  it("finds nothing without a failed update", () => {
    expect(find("self-update")).toEqual([]);
    expect(check({})).toEqual([]);
    expect(check({ updated: { from: sha, to: sha, at: "x" } })).toEqual([]);
  });

  it("is major when the old version keeps running", () => {
    const [f] = check({ failed: failed() });
    expect(f).toMatchObject({
      severity: "major", fingerprint: "self-update|test", about: "foundry",
      summary: "The update to aaaaaaa failed at test; the old version keeps running.",
      evidence: { counts: { failed: 1 }, times: ["2026-10-01T11:00:00.000Z"], steps: ["test"], lines: ["1 failed"] },
    });
  });

  it("is critical when the new version did not start healthy", () => {
    const [f] = check({ failed: failed({ stage: "start", back: "b".repeat(40), backOk: true }) });
    expect(f).toMatchObject({ severity: "critical", fingerprint: "self-update|start", summary: "The update to aaaaaaa did not start healthy; the Foundry went back to the version before it." });
  });

  it("is critical when it could not go back, and when the record is broken", () => {
    const [f] = check({ failed: failed({ stage: "start", backOk: false }) });
    expect(f).toMatchObject({ severity: "critical", summary: "The update to aaaaaaa failed and the Foundry could not go back to the version before it; the checkout must be repaired by hand." });
    const [b] = check({}, true);
    expect(b).toMatchObject({ severity: "critical", fingerprint: "self-update|state", summary: "The self-update record could not be read; self-update is stopped until a person checks the checkout." });
  });
});
