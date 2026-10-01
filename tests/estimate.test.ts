import { describe, expect, it } from "vitest";
import { buildHistory, runProgress, runTiming, withWaitLeft } from "../src/estimate.js";
import type { RunSummary } from "../src/engine/state.js";
import { nextStep } from "../src/next-step.js";

const MIN = 60_000;
const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * MIN).toISOString();

const sh = (id: string, extra: object = {}) => ({ id, type: "shell", run: "true", ...extra });
const flowDef = (ids: string[] = ["a", "b", "c"]) => ({ name: "f", steps: ids.map((id) => sh(id)) });
const rec = (id: string, min: number, extra: object = {}) => ({ id, type: "shell", ok: true, visit: 1, output: "", startedAt: ago(0), durationMs: min * MIN, logFile: "", ...extra });

const run = (over: Record<string, unknown> = {}) =>
  ({
    runId: "r1", flow: "f", task: "t", status: "succeeded", startedAt: ago(100), finishedAt: ago(50),
    vars: { github_repo: "acme/app" }, repo: "/tmp/x", history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} },
    runDir: "/tmp/none", flowDef: flowDef(), ...over,
  }) as unknown as RunSummary;

const done = (b: number, over: Record<string, unknown> = {}) => run({ history: [rec("a", 5), rec("b", b), rec("c", 10)], ...over });
const five = () => [10, 10, 15, 25, 25].map((b, i) => done(b, { runId: `h${i}` }));
const running = (next: string, startedMin: number | undefined, over: Record<string, unknown> = {}) =>
  run({
    status: "running", state: { next, steps: {}, visits: {} }, stepStartedAt: startedMin === undefined ? undefined : ago(startedMin),
    history: next === "b" ? [rec("a", 5)] : [], ...over,
  });

describe("runTiming", () => {
  const h = buildHistory(five());

  it("estimates from history", () => {
    const t = runTiming(running("b", 5), h, NOW)!;
    expect(t.usualTotalMs).toEqual([25 * MIN, 40 * MIN]);
    expect(t.leftMs).toBe(20 * MIN);
    expect(t.estimate).toBe("Estimate: about 20 min left (usually 25–40 min in total)");
    expect(t.progress).toBe("Step 2 of 3");
    expect(t.slow).toBeUndefined();
  });

  it("flags a slow step gently", () => {
    const t = runTiming(running("b", 50), h, NOW)!;
    expect(t.slow).toBe(true);
    expect(t.note).toBe("Taking longer than usual");
    expect(t.leftMs).toBe(10 * MIN);
    expect(runTiming(running("b", 44), h, NOW)!.slow).toBeUndefined();
  });

  it("has a 2 minute floor", () => {
    const fast = buildHistory([1, 2, 3].map((i) => run({ runId: `q${i}`, history: [rec("a", 0.1), rec("b", 1 / 6), rec("c", 0.1)] })));
    expect(runTiming(running("b", 1), fast, NOW)!.slow).toBeUndefined();
  });

  it("without a step time: not slow, left from the start", () => {
    const t = runTiming(running("b", undefined), h, NOW)!;
    expect(t.slow).toBeUndefined();
    expect(t.leftMs).toBe(25 * MIN);
  });

  it("survives bad step times", () => {
    for (const at of ["nonsense", new Date(NOW.getTime() + 60 * MIN).toISOString()]) {
      const t = runTiming(running("b", 0, { stepStartedAt: at }), h, NOW)!;
      expect(t.slow).toBeUndefined();
      expect(Number.isFinite(t.leftMs)).toBe(true);
      expect(JSON.stringify(t)).not.toContain("null");
    }
  });

  it("gives progress only for waiting or stopped runs", () => {
    for (const status of ["waiting", "stopped"]) {
      const t = runTiming(running("b", 5, { status }), h, NOW)!;
      expect(Object.keys(t).sort()).toEqual(["of", "progress", "step", "stepId"]);
    }
  });
});

describe("loops", () => {
  const loopDef = flowDef(["build", "review", "fix"]);
  const loopRun = (i: number) => run({ runId: `l${i}`, flowDef: loopDef, history: [rec("build", 5), rec("review", 2), rec("fix", 4), rec("review", 2)] });
  const h = buildHistory([1, 2, 3].map(loopRun));
  const live = (next: string, hist: string[]) =>
    run({ status: "running", flowDef: loopDef, state: { next, steps: {}, visits: {} }, history: hist.map((id) => rec(id, 1)) });

  it("uses the visit the run is on", () => {
    expect(runTiming(live("review", ["build", "review", "fix"]), h, NOW)!.leftMs).toBe(2 * MIN);
    expect(runTiming(live("fix", ["build", "review"]), h, NOW)!.leftMs).toBe(6 * MIN);
  });

  it("has no time left on a visit without samples", () => {
    const t = runTiming(live("review", ["build", "review", "fix", "review"]), h, NOW)!;
    expect(t.leftMs).toBeUndefined();
    expect(t.estimate).toMatch(/^Estimate: usually .* in total$/);
  });

  it("has one sample per run and visit", () => {
    const [x] = [...h.values()];
    expect(x!.ms["review#1"]).toEqual([2 * MIN, 2 * MIN, 2 * MIN]);
    expect(x!.ms["review#2"]).toHaveLength(3);
  });

  it("flags a slow first visit against that visit's median", () => {
    const t = runTiming(run({ status: "running", flowDef: loopDef, state: { next: "review", steps: {}, visits: {} }, history: [rec("build", 1)], stepStartedAt: ago(7) }), h, NOW)!;
    expect(t.slow).toBe(true); // 7 min > 3 × 2 min
  });
});

describe("which runs count", () => {
  const current = running("b", 5);
  it("needs three runs", () => {
    const t = runTiming(current, buildHistory(five().slice(0, 2)), NOW)!;
    expect(t.progress).toBe("Step 2 of 3");
    expect(t.estimate).toBeUndefined();
    const one = buildHistory([run({ history: [rec("a", 5), rec("b", 5), rec("b", 5), rec("b", 5), rec("c", 5)] })]);
    const t1 = runTiming(current, one, NOW)!;
    expect(t1.slow).toBeUndefined();
    expect(t1.estimate).toBeUndefined();
  });

  it("ignores runs that did not succeed", () => {
    const runs = ["failed", "stopped", "running"].flatMap((status) => five().map((r) => ({ ...r, status }) as RunSummary));
    expect(buildHistory(runs).size).toBe(0);
  });

  it("keeps repository, flow and steps apart", () => {
    const other = (over: Record<string, unknown>) => buildHistory(five().map((r) => ({ ...r, ...over }) as RunSummary));
    for (const o of [{ vars: { github_repo: "acme/other" } }, { flow: "g" }, { flowDef: flowDef(["a", "b", "c", "d"]) }]) {
      expect(runTiming(current, other(o), NOW)!.estimate).toBeUndefined();
    }
  });

  it("keys a local run by its repo", () => {
    const local = (r: RunSummary) => ({ ...r, vars: {}, repo: "/work/app" }) as RunSummary;
    const t = runTiming(local(current), buildHistory(five().map(local)), NOW)!;
    expect(t.estimate).toBeDefined();
  });

  it("treats owner/repo as no repository", () => {
    const at = (repo: string) => (r: RunSummary) => ({ ...r, vars: { github_repo: "owner/repo" }, repo }) as RunSummary;
    const cur = at("/work/one")(current);
    expect(runTiming(cur, buildHistory(five().map(at("/work/two"))), NOW)!.estimate).toBeUndefined();
    expect(runTiming(cur, buildHistory(five().map(at("/work/one"))), NOW)!.estimate).toBeDefined();
  });

  it("counts a parallel target that also runs as a normal step", () => {
    const def = { name: "f", steps: [sh("x"), { id: "p", type: "parallel", steps: ["x", "y"] }, sh("y")] };
    const hist = [rec("x", 1), rec("x", 5), rec("y", 5), rec("p", 5), rec("y", 1)];
    const [h] = [...buildHistory([1, 2, 3].map((i) => run({ runId: `n${i}`, flowDef: def, history: hist }))).values()];
    expect(h!.totals).toEqual([7 * MIN, 7 * MIN, 7 * MIN]); // x (1), p (5), y (1): the two children are left out
    expect(h!.ms["x#1"]).toHaveLength(3);
  });

  it("ignores children, parent records and limited records", () => {
    const def = { name: "f", steps: [sh("a"), { id: "p", type: "parallel", steps: ["x", "y"] }, sh("x"), sh("y")] };
    const hist = [rec("a", 1), rec("x", 1), rec("y", 1), rec("p", 1), rec("c", 99, { parent: "sub" }), rec("a", 99, { limited: true })];
    const [x] = [...buildHistory([1, 2, 3].map((i) => run({ runId: `p${i}`, flowDef: def, history: hist }))).values()];
    expect(x!.totals).toEqual([2 * MIN, 2 * MIN, 2 * MIN]);
  });
});

describe("broken data", () => {
  it("leaves out runs with bad durations", () => {
    for (const bad of [null, -5, "x"]) {
      const runs = [...five(), done(10, { runId: "bad", history: [rec("a", 5), rec("b", 1, { durationMs: bad }), rec("c", 5)] })];
      const [x] = [...buildHistory(runs).values()];
      expect(x!.totals).toHaveLength(5);
    }
  });

  it("does not throw on bare runs", () => {
    const bare = { runId: "x", flow: "f", status: "succeeded" } as unknown as RunSummary;
    expect(buildHistory([bare]).size).toBe(0);
    expect(runTiming({ ...bare, status: "running" } as RunSummary, buildHistory([]), NOW)).toBeUndefined();
  });
});

describe("runProgress", () => {
  const withJump = flowDef(["a", "b", "c"]);
  (withJump.steps[0] as Record<string, unknown>).jump_only = true;

  it("counts every step of the flow", () => {
    expect(runProgress(running("c", 1))!.progress).toBe("Step 3 of 3");
  });

  it("starts at the first step that is not jump_only", () => {
    expect(runProgress(running("a", 1, { state: { next: null, steps: {}, visits: {} }, history: [] }))!.progress).toBe("Step 1 of 3");
    expect(runProgress(run({ status: "running", flowDef: withJump, state: { next: null, steps: {}, visits: {} } }))!.progress).toBe("Step 2 of 3");
  });

  it("has none when it makes no sense", () => {
    expect(runProgress(run())).toBeUndefined();
    expect(runProgress(running("zzz", 1))).toBeUndefined();
    expect(runProgress(run({ status: "failed", history: [rec("a", 1)] }))).toBeUndefined();
    expect(runProgress({ runId: "x", status: "running", state: { next: "a" } } as unknown as RunSummary)).toBeUndefined();
  });
});

describe("texts", () => {
  const est = (lo: number, hi: number) => {
    const mk = (m: number) => run({ history: [rec("a", m)], flowDef: flowDef(["a"]) });
    const h = buildHistory([mk(lo), mk(lo), mk(hi), mk(hi), mk(hi)]);
    return runTiming(run({ status: "running", flowDef: flowDef(["a"]), state: { next: "a", steps: {}, visits: {} } }), h, NOW)!.estimate;
  };

  it("words the usual time", () => {
    expect(est(30, 30)).toContain("usually about 30 min");
    expect(est(50, 95)).toContain("usually 50 min – 1.5 h");
    expect(est(0.2, 0.2)).toContain("about 1 min");
  });

  it("adds the time left to a wait", () => {
    const dep = nextStep("dependency", { repo: "acme/app" }, { blockers: [{ issue: 88 }] });
    expect(withWaitLeft(dep, 20 * MIN).until).toBe("after #88 (about 20 min left)");
    expect(dep.until).toBe("after #88");
    const one = nextStep("one_at_a_time", { repo: "acme/app" }, { blockingRun: "r1" });
    expect(withWaitLeft(one, 20 * MIN).until).toBe("after that run (about 20 min left)");
    expect(withWaitLeft(dep, undefined)).toBe(dep);
    const plain = nextStep("queued", { repo: "acme/app" });
    expect(withWaitLeft(plain, MIN)).toBe(plain);
  });

  it("marks the run a record waits for", () => {
    const base = { repo: "acme/app" };
    expect(nextStep("one_at_a_time", base, { blockingRun: "r1" }).afterRun).toBe("r1");
    expect(nextStep("area_lock", base, { areaWait: { runId: "r2", areas: "src" } }).afterRun).toBe("r2");
    for (const k of ["queued", "dependency"] as const) expect("afterRun" in nextStep(k, base)).toBe(false);
  });
});
