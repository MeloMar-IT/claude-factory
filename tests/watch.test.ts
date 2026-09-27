import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFlow } from "../src/flow/load.js";
import { parseInterval, watch } from "../src/watch.js";
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

describe("watch", { timeout: 30_000 }, () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => gh.restore());

  const once = (vars: Record<string, string>) => {
    const lines: string[] = [];
    return watch({
      flow: loadFlow("github-issue", gh.tmp).flow,
      repo: gh.tmp,
      runsDir: join(gh.tmp, "runs"),
      vars: { test_cmd: "test -f feature.txt", ...vars },
      label: "claude-factory",
      intervalMs: 60_000,
      maxPerTick: 1,
      once: true,
      claudeBin,
      log: (l) => lines.push(l),
    }).then(() => lines);
  };

  it("picks the oldest new labelled issue, runs the flow and marks it done", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 9, title: "newer", labels: [{ name: "claude-factory" }] },
      { number: 3, title: "already done", labels: [{ name: "claude-factory" }, { name: "factory:done" }] },
      { number: 5, title: "older", labels: [{ name: "claude-factory" }] },
    ]);
    const lines = await once({ github_repo: "acme/app" });
    const log = gh.ghLog();
    expect(log).toContain("gh label create claude-factory --repo acme/app");
    expect(log).toMatch(/gh issue edit 5 .*--add-label factory:working/);
    expect(log).toMatch(/gh issue edit 5 .*--add-label factory:done/);
    expect(log).not.toMatch(/issue (view|edit) (3|9)\b/);
    expect(lines.join("\n")).toContain("✔ #5 succeeded");
  });

  it("marks unclear tickets as needs-info", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "vague", labels: [{ name: "claude-factory" }] }]);
    process.env.FAKE_PLAN = "What should it do?\nPLAN_STATUS: NEEDS_INFO";
    await once({ github_repo: "acme/app" });
    expect(gh.ghLog()).toMatch(/gh issue edit 4 .*--add-label factory:needs-info/);
  });

  it("requires a real repo", async () => {
    await expect(once({})).rejects.toThrow(/github_repo=owner\/repo/);
  });
});
