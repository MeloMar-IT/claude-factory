import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { listEvalReports, loadSuite, runEval } from "../src/evals.js";
import { claudeBin } from "./helpers/fake-github.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-eval-test-"));
  mkdirSync(join(tmp, "fixture"));
  writeFileSync(join(tmp, "fixture", "README.md"), "fixture\n");
  mkdirSync(join(tmp, ".claude-factory", "flows"), { recursive: true });
  writeFileSync(join(tmp, ".claude-factory", "flows", "one.yaml"), `
name: one
workspace: worktree
steps:
  - {id: do, type: claude, prompt: "{{task}}"}
`);
  writeFileSync(join(tmp, "suite.yaml"), `
name: t
flows: [one]
models: [haiku, opus]
cases:
  - {name: writes, repo: fixture, task: "WRITE ok.txt yes", check: "test -f ok.txt"}
  - {name: forgets, repo: fixture, task: "SAY nothing", check: "test -f ok.txt"}
  - {name: no-check, repo: fixture, task: "SAY done"}
`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("evals", () => {
  it("validates suites", () => {
    writeFileSync(join(tmp, "bad.yaml"), "name: t\nflows: []\ncases: []\n");
    expect(() => loadSuite(join(tmp, "bad.yaml"))).toThrow(/invalid suite/);
  });

  it("runs every flow × model × case, checks results and saves a report", async () => {
    const lines: string[] = [];
    const { report, file } = await runEval({
      suitePath: join(tmp, "suite.yaml"),
      runsDir: join(tmp, "runs"),
      config: ConfigSchema.parse({ protected_branches: [], concurrency: 3 }),
      claudeBin,
      log: (l) => lines.push(l),
    });
    expect(report.results).toHaveLength(6);
    expect(report.summary.map((s) => s.variant).sort()).toEqual(["one@haiku", "one@opus"]);
    for (const s of report.summary) {
      expect(s.runs).toBe(3);
      expect(s.passRate).toBeCloseTo(2 / 3, 2); // "forgets" fails its check
      expect(s.avgCostUsd).toBeCloseTo(0.01);
    }
    const forgets = report.results.find((r) => r.case === "forgets")!;
    expect(forgets.status).toBe("succeeded");
    expect(forgets.passed).toBe(false);
    expect(file).toMatch(/evals\/t-.*\.json$/);
    expect(listEvalReports()[0]!.suite).toBe("t");
    expect(lines[0]).toContain("2 variant(s) × 3 case(s) × 1 = 6 runs");
  });
});
