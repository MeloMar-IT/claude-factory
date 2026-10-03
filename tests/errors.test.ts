import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorLine, explainError, type ErrorAbout } from "../src/errors.js";

type Row = [string, string, ErrorAbout, string, boolean?];
const WHY_GENERAL = "the error is not one the Foundry can explain";

const CONNECTION = ["The watcher can't reach GitHub", "watcher", "GitHub did not answer or did not let it in"] as const;

describe("errorLine", () => {
  it("keeps the first output line of a failed command", () => {
    expect(errorLine("Command failed: gh x\nboom\nmore")).toBe("Command failed: gh x — boom");
    expect(errorLine("Command failed: gh x")).toBe("Command failed: gh x");
    expect(errorLine("one\ntwo")).toBe("one");
    expect(errorLine(undefined)).toBe("");
    expect(errorLine("x".repeat(400))).toHaveLength(300);
  });
});

const rows: Row[] = [
  ['step "run_tests" failed: exit code 1', "The step run_tests failed", "run", "its command ended with an error"],
  ['step "x" failed: exit code null', "The step x failed", "run", "its command ended with an error"],
  ['step "plan" failed: timed out', "The step plan failed", "run", "it ran longer than its time limit"],
  ['step "plan" failed: claude exited with code 1 and no result. boom\nline 2', "The step plan failed", "run", "the agent stopped without a result"],
  ['step "review" failed: codex exited with code 2. oops', "The step review failed", "run", "the agent stopped with an error"],
  ['step "plan" failed: claude result: error_max_turns', "The step plan failed", "run", "the agent used all its turns"],
  ['step "plan" failed: claude result: error_max_budget_usd', "The step plan failed", "run", "the agent used up the budget of the step", true],
  ['step "plan" failed: claude result: error_during_execution', "The step plan failed", "run", "the agent hit an error while it worked"],
  ['step "plan" failed: claude result: weird-sub.type! <b>', "The step plan failed", "run", "the agent ended with an error"],
  ['step "fix_tests" exceeded max_visits (3)', "The step fix_tests failed", "run", "it used all its attempts"],
  ['step "fix_tests" exceeded max_visits (1)', "The step fix_tests failed", "run", "it used all its attempts"],
  ["run budget of $2 reached", "The run reached its budget", "run", "it used the amount the flow allows for one run", true],
  ['step "approve" failed: rejected', "The step approve failed", "run", "a person rejected it"],
  ['step "review" failed: codex CLI not found — install it with: npm i -g @openai/codex', "The step review failed", "run", "Codex is not installed on this computer"],
  ['step "review" failed: codex exited with code 1. 401 Unauthorized — run `codex login`', "The step review failed", "run", "Codex is not logged in"],
  ["cannot access acme/app with gh: Command failed: gh repo view acme/app --json nameWithOwner", ...CONNECTION],
  ["Command failed: gh issue list — error connecting to api.github.com", ...CONNECTION],
  ['Command failed: gh issue list — Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host', ...CONNECTION],
  ["Command failed: gh issue list — HTTP 502: Bad Gateway (https://api.github.com/graphql)", ...CONNECTION],
  ["getaddrinfo ENOTFOUND api.github.com", ...CONNECTION],
  ["connect ECONNREFUSED 127.0.0.1:443", ...CONNECTION],
  ["tidying closed issues: Command failed: gh issue list — net/http: TLS handshake timeout", ...CONNECTION],
  ["Command failed: gh issue list — HTTP 404: Not Found", "The watcher cannot reach the repository", "watcher", "a call to GitHub failed"],
  ["Command failed: gh issue list --repo acme/app", "The watcher cannot reach the repository", "watcher", "a call to GitHub failed"],
  ["Command failed: gh issue list --repo acme/app — GraphQL: API rate limit already exceeded for user ID 1.", "GitHub's request limit is used up", "watcher", "the Foundry asked GitHub too much in the last hour"],
  ["Command failed: gh issue list --repo acme/app", "The run failed", "run", WHY_GENERAL],
  ["tidying closed issues: Command failed: gh issue list", "The watcher cannot reach the repository", "watcher", "a call to GitHub failed"],
  ["the check took longer than 600s and was given up", "The watcher did not finish its check", "watcher", "it took too long and was given up"],
  ['invalid interval "soon" (use e.g. 30s, 5m, 1h, 7d)', "The watcher cannot start", "watcher", "its check interval is not a valid time"],
  ["interval must be at least 10s", "The watcher cannot start", "watcher", "its check interval is outside what is allowed"],
  ["internal error: x is not a function", "The run failed", "run", "the Foundry hit an error of its own"],
  ["boom", "The run failed", "run", WHY_GENERAL],
  ["boom", "The watcher has an error", "watcher", WHY_GENERAL],
];

describe("explainError", () => {
  it.each(rows)("%s (%s)", (raw, what, about, why, startOver) => {
    const e = explainError(raw, about);
    expect(e.what).toBe(what);
    expect(e.why).toBe(why);
    expect(e.startOver).toBe(startOver ?? false);
    expect(e.detail).toBe(raw.trim());
  });

  it("empty input gives the no-reason text, not the general one", () => {
    for (const raw of ["", "  ", undefined]) {
      expect(explainError(raw).why).toBe("no reason was saved");
      expect(explainError(raw).what).toBe("The run failed");
      expect(explainError(raw, "watcher")).toMatchObject({ what: "The watcher has an error", why: "no reason was saved" });
    }
    expect(explainError('step "x" failed')).toMatchObject({ what: "The step x failed", why: "no reason was saved" });
  });

  it("names the innermost step of a sub-flow", () => {
    expect(explainError('step "build" failed: sub-flow issue-build failed: step "build/run_tests" failed: exit code 2').what).toBe("The step build/run_tests failed");
    const e = explainError('step "build" failed: sub-flow issue-build failed: step "build/fix" exceeded max_visits (3)');
    expect(e).toMatchObject({ what: "The step build/fix failed", why: "it used all its attempts" });
  });

  it("recognizes a Codex login failure stored without the exit-code prefix", () => {
    for (const raw of ["Not logged in — run `codex login`", 'step "review" failed: 401 Unauthorized — run `codex login`']) {
      expect(explainError(raw).why).toBe("Codex is not logged in");
    }
    expect(explainError('step "a" failed: claude result: error_max_turns 401').why).toBe("the agent used all its turns");
    expect(explainError("cannot access acme/app with gh: HTTP 401 Unauthorized", "watcher").why).not.toContain("Codex");
    expect(explainError('step "a" failed: API Error: 401 Unauthorized').why).not.toContain("Codex");
  });

  it("unwraps sub-flows whatever their name", () => {
    for (const name of ["Child flow", "a: b (c)", "x failed y"]) {
      const e = explainError(`step "build" failed: sub-flow ${name} failed: step "build/t" failed: exit code 2`);
      expect(e).toMatchObject({ what: "The step build/t failed", why: "its command ended with an error" });
    }
    expect(explainError('step "b" failed: sub-flow Child flow failed: step "b/t" failed: timed out').why).toBe("it ran longer than its time limit");
  });

  it("follows the text rules for every sample", () => {
    for (const [raw, , about] of rows) {
      const e = explainError(raw, about);
      for (const part of [e.what, e.why, e.todo]) {
        expect(part).not.toMatch(/[.!?]\s|\n|\$|"/);
        expect(part).not.toMatch(/[.!?:;,]$/);
        expect(part.toLowerCase()).not.toMatch(/precheck|hold|area lock|jump_only|split risk/);
        const bare = part.replace(/[\w./-]*(?:run_tests|fix_tests|build\/)[\w./-]*/g, "");
        expect(bare).not.toMatch(/\w_\w/);
        expect(bare).not.toContain("exit code");
      }
      expect(e.what.length + e.why.length).toBeLessThanOrEqual(110);
      expect(e.todo.length).toBeLessThanOrEqual(90);
      expect(e.todo).toMatch(/^[A-Z]/);
    }
  });

  it("the Troubleshooting section of the guide has every message and advice", () => {
    const guide = readFileSync("docs/USER_GUIDE.md", "utf8");
    const section = guide.slice(guide.indexOf("## 10. Troubleshooting"));
    const all = [...rows.map(([raw, , about]) => explainError(raw, about)), explainError(undefined), explainError("x", "watcher")];
    for (const e of all) {
      expect(section, e.todo).toContain(e.todo);
      expect(section, e.why).toContain(e.why);
    }
  });

  it("keeps untrusted text out of the three parts", () => {
    const raw = 'step "a" failed: @someone <b>x</b> [l](http://x)';
    const e = explainError(raw);
    for (const part of [e.what, e.why, e.todo]) expect(part).not.toMatch(/someone|<b>|\[l\]|http/);
    expect(e.detail).toBe(raw);
  });
});

describe("explainError for a user", () => {
  const user = (raw: string) => explainError(raw, "run", true);
  const MONEY = /\$|budget|Codex|claude|Settings/i;

  it.each([
    ['step "plan" failed: claude result: error_max_budget_usd', "The step plan failed", "the administrator's limit was reached"],
    ["run budget of $2 reached", "The run stopped", "the administrator's limit was reached"],
    ['step "review" failed: codex CLI not found — install it with: npm i -g @openai/codex', "The step review failed", "an AI tool of the Foundry is not set up"],
    ['step "review" failed: 401 Unauthorized — run `codex login`', "The step review failed", "the Foundry is signed out of an AI account"],
    ["boom", "The run failed", "the error is not one the Foundry can explain"],
  ])("%s", (raw, what, why) => {
    const e = user(raw);
    expect(e.what).toBe(what);
    expect(e.why).toBe(why);
    expect(e.todo).toBe("Ask the administrator");
    for (const part of [e.what, e.why, e.todo]) {
      expect(part).not.toMatch(MONEY);
      expect(part).not.toMatch(/[.!?]\s|\n|\$|"/);
    }
  });

  it("marks a limit, only for a user", () => {
    expect(user("run budget of $2 reached")).toMatchObject({ limit: true, startOver: true });
    expect(explainError("run budget of $2 reached").limit).toBeUndefined();
    expect(user("exit code 1").limit).toBeUndefined();
  });

  it("sends a user to the log, not to output they cannot read", () => {
    expect(explainError("exit code 1").todo).toBe("Look at the output of the step and fix the cause");
    expect(user("exit code 1").todo).toBe("Look at the log on the run page");
  });

  it("leaves the other rows as they are", () => {
    for (const raw of ['step "x" failed: rejected', "internal error: x"]) {
      expect(user(raw)).toEqual(explainError(raw));
    }
  });
});
