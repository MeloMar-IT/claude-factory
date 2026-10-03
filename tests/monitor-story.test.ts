import { describe, expect, it } from "vitest";
import { isBot } from "../src/github.js";
import { DETECTORS } from "../src/monitor/detectors.js";
import type { Finding } from "../src/monitor/findings.js";
import { cleanLines, type Names } from "../src/monitor/clean.js";
import { makeRedactor } from "../src/credentials/redact.js";
import { buildStory, hashIn, markerHash, seenAgainComment } from "../src/monitor/story.js";

const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const steps = { "issue-gitflow": ["claim_areas", "build"], daily: ["go"] };
const RAW = "restart-loop|issue-gitflow|claim_areas|SECRET-FINGERPRINT-PART";

const finding = (over: Partial<Finding> = {}): Finding => ({
  detector: "restart-loop", fingerprint: RAW, severity: "critical", summary: "SECRET-SUMMARY-TEXT", about: "foundry",
  evidence: { counts: { runs: 2, resumes: 12 }, times: ["2026-10-01T12:00:00.000Z"], steps: ["claim_areas"], flows: ["issue-gitflow"] },
  firstSeen: "2026-10-01T12:00:00.000Z", lastSeen: "2026-10-01T13:00:00.000Z", count: 4, gone: false, ...over,
});
const HEADINGS = ["What happened", "Since when and how often", "Effect on work", "Evidence", "What should happen instead", "How to see it again", "Where to look in the code", "Acceptance criteria", "About this story"];

describe("buildStory", () => {
  it("has all headings, two criteria and the marker for every detector", () => {
    for (const d of DETECTORS) {
      const { title, body } = buildStory(finding({ detector: d.name, fingerprint: `${d.name}|x` }), { lines: [], builtinSteps: steps });
      expect(title, d.name).not.toBe("The monitor found a problem of the Foundry");
      for (const h of HEADINGS) expect(body, `${d.name} ${h}`).toContain(`## ${h}`);
      expect(body.match(/- \[ \]/g)).toHaveLength(2);
      expect(body).toContain(`<!-- claude-factory monitor=${markerHash(`${d.name}|x`)} -->`);
      expect(hashIn(body)).toBe(markerHash(`${d.name}|x`));
    }
  });

  it("names the symptom and keeps the raw fingerprint and summary out", () => {
    const { title, body } = buildStory(finding(), { lines: [], builtinSteps: steps });
    expect(title).toBe("Runs that step aside are restarted in a loop");
    expect(body).not.toContain("SECRET-FINGERPRINT-PART");
    expect(body).not.toContain("SECRET-SUMMARY-TEXT");
    expect(body).toContain("Seen in 4 checks");
    expect(body).toContain("issue-gitflow");
    expect(body).toContain("`claim_areas`");
  });

  it("says custom flow and a step for what is not built in; watcher ids never appear", () => {
    const custom = buildStory(finding({ evidence: { flows: ["my-private-flow"], steps: ["my-step"], watchers: ["jane-issues"] } }), { lines: [], builtinSteps: steps }).body;
    expect(custom).toContain("a custom flow");
    expect(custom).toContain("a step");
    for (const bad of ["my-private-flow", "my-step", "jane-issues"]) expect(custom).not.toContain(bad);
    const shadow = buildStory(finding({ evidence: { flows: ["issue-gitflow"], steps: ["own_step"] } }), { lines: [], builtinSteps: steps }).body;
    expect(shadow).toContain("a step");
    expect(shadow).not.toContain("own_step");
  });

  it("leaves out values that are not what they should be", () => {
    const f = finding({
      detector: TOKEN,
      evidence: { flows: [TOKEN], steps: [TOKEN], counts: { [TOKEN]: 3, runs: "many" as unknown as number, bad_time: Number.NaN, ok: 5 }, times: ["not a time", TOKEN] },
      firstSeen: "yesterday",
    });
    const { title, body } = buildStory(f, { lines: [], builtinSteps: steps });
    expect(title + body).not.toContain("ghp_");
    expect(body).not.toContain("many");
    expect(body).not.toContain("yesterday");
    expect(body).toContain("ok: 5");
  });

  it("says when the lines are left out, and when the problem came back", () => {
    expect(buildStory(finding(), { lines: undefined, builtinSteps: steps }).body).toContain("left out");
    const back = buildStory(finding(), { lines: [], previous: 12, builtinSteps: steps }).body;
    expect(back).toContain("Came back after the fix");
    expect(back).toContain("#12");
  });

  it("uses the generic template for an unknown detector and cannot be broken out of a fence", () => {
    const { title, body } = buildStory(finding({ detector: "something-new" }), { lines: ["a ``` b", "c ````` d"], builtinSteps: steps });
    expect(title).toBe("The monitor found a problem of the Foundry");
    const fence = body.split("\n").filter((l) => l.startsWith("````"));
    expect(fence).toHaveLength(2);
    expect(body).not.toMatch(/`{5}/);
    expect(body).not.toMatch(/(^|[^`])`{3}(?!`)/);
  });

  it("writes the seen-again comment, which counts as the Foundry's own", () => {
    const f = finding({ report: { repo: "a/b", issue: 5, url: "u", at: "2026-10-01T12:00:00.000Z", seen: 7 } });
    const c = seenAgainComment(f);
    expect(c).toContain("Seen again: 7 times since 2026-10-01");
    expect(isBot({ body: c })).toBe(true);
  });

  it("proves the cleaning: a private repository, an e-mail address, a path with a user name and a token do not get into a story", async () => {
    const names: Names = { target: "melo/foundry", users: ["Jane Doe"], emails: ["jane@acme.example"], repos: ["acme/secret-app"], watchers: [], complete: true };
    const raw = [`cannot push to acme/secret-app: jane@acme.example denied`, `cannot read /Users/jane/work/file with ${TOKEN}`];
    const lines = await cleanLines(raw, names, { redactor: () => makeRedactor([]) });
    const { title, body } = buildStory(finding({ evidence: { lines: raw } }), { lines, builtinSteps: steps });
    for (const bad of ["secret-app", "acme", "jane", "/Users", "ghp_", TOKEN]) expect(title + body).not.toContain(bad);
    expect(body).toContain("cannot");
  });
});
