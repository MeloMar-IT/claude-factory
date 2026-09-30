import { describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { computeStats, supersededRuns } from "../src/stats.js";

const run = (runId: string, status: string, startedAt: string, vars: Record<string, string> = {}) =>
  ({ runId, status, startedAt, flow: "f", vars, history: [], totalCostUsd: 0 }) as unknown as RunSummary;

describe("needs a human", () => {
  it("doesn't count stopped or waiting runs that a newer run on the same issue replaced", () => {
    const runs = [
      run("old-plan", "stopped", "2026-09-29T10:00:00Z", { github_repo: "a/b", issue: "79" }),
      run("built", "succeeded", "2026-09-30T08:00:00Z", { github_repo: "a/b", issue: "79" }),
      run("asks", "stopped", "2026-09-30T09:00:00Z", { github_repo: "a/b", issue: "80" }),
      run("approve", "waiting", "2026-09-30T09:00:00Z", { github_repo: "a/b", issue: "81" }),
      run("local", "stopped", "2026-09-28T09:00:00Z"),
    ];
    expect([...supersededRuns(runs)]).toEqual(["old-plan"]);
    const t = computeStats(runs, 30, new Date("2026-09-30T12:00:00Z")).totals;
    expect(t.stopped).toBe(2); // #80 and the local run, not the replaced #79 plan run
    expect(t.waiting).toBe(1);
  });
});
