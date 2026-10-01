import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

describe("github-auto (triage routes)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => gh.restore());
  const run = (vars: Record<string, string> = {}) =>
    runFlow(loadFlow("github-auto", gh.tmp).flow, {
      task: "", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin,
      vars: { github_repo: "acme/app", issue: "7", test_cmd: "test -f feature.txt", ci_settle_sec: "0", ...vars },
    });
  const ids = (s: Awaited<ReturnType<typeof run>>) => s.history.map((h) => h.id);

  it("SMALL skips planning", async () => {
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(ids(s)).not.toContain("plan");
    expect(ids(s).slice(0, 5)).toEqual(["check_repo", "pull_ticket", "pull_repo", "triage", "implement"]);
  });

  it("FEATURE plans first", async () => {
    process.env.FAKE_TRIAGE = "Bigger.\nROUTE: FEATURE";
    const s = await run();
    expect(ids(s).slice(3, 6)).toEqual(["triage", "plan", "push_plan"]);
  });

  it("SPLIT creates labelled sub-issues and ends", async () => {
    process.env.FAKE_TRIAGE = "Too big.\nSUBTASK: Add model :: Create the User model.\nSUBTASK: Add API :: Expose /users.\nROUTE: SPLIT";
    const s = await run({ auto_subtasks: "yes" });
    expect(s.status).toBe("succeeded");
    expect(ids(s).at(-1)).toBe("split_ticket");
    const log = gh.ghLog();
    expect(log).toContain("created issue: issue create --repo acme/app --title Add model --body Part of #7");
    expect(log).toContain("--label claude-factory");
    expect(log).toContain("🤖 **Spaghetti Code Foundry** split this ticket into smaller ones:");
    expect(log).toContain("They are labelled `claude-factory` and will be picked up automatically.");
    expect(log).toContain(`<!-- claude-factory run=${s.runId} -->`);
    expect(log).toContain("https://github.com/owner/repo/issues/102");
  });

  it("NEEDS_INFO asks the triage questions and stops", async () => {
    process.env.FAKE_TRIAGE = "Unclear.\nWhich endpoint?\nROUTE: NEEDS_INFO";
    const s = await run();
    expect(s.status).toBe("stopped");
    expect(s.state.next).toBe("pull_ticket");
    expect(gh.ghLog()).toContain("Which endpoint?");
    expect(gh.ghLog()).toContain("🤖 **Spaghetti Code Foundry** needs more information");
    expect(gh.ghLog()).not.toContain("ROUTE:");
  });
});

/** A tiny mock of the Jira REST and Linear GraphQL APIs. */
function mockApis() {
  const calls: { method: string; url: string; auth?: string; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/rest/api/3/issue/PROJ-9?")) {
        return res.end(JSON.stringify({
          key: "PROJ-9",
          fields: {
            summary: "Add feature.txt",
            status: { name: "To Do" },
            description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Please add feature.txt" }] }] },
            comment: { comments: [{ author: { displayName: "Ann" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "plain text is fine" }] }] } }] },
          },
        }));
      }
      if (req.url === "/rest/api/3/issue/PROJ-9/comment") return res.end(JSON.stringify({ id: "c1" }));
      if (req.url === "/graphql") {
        if (body.query.includes("commentCreate")) return res.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
        if (body.query.includes("title")) {
          return res.end(JSON.stringify({ data: { issue: { identifier: "ENG-9", title: "Add feature.txt", description: "Please add feature.txt", url: "https://linear.app/x/ENG-9", state: { name: "Todo" }, comments: { nodes: [{ body: "thanks", user: { name: "Bo" } }] } } } }));
        }
        return res.end(JSON.stringify({ data: { issue: { id: "uuid-9" } } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return { server, calls };
}

describe("jira-ticket and linear-ticket flows", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let api: ReturnType<typeof mockApis>;
  let repo: string;
  beforeEach(async () => {
    gh = fakeGithub();
    api = mockApis();
    await new Promise<void>((ok) => api.server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    Object.assign(process.env, {
      JIRA_BASE_URL: base, JIRA_EMAIL: "me@x", JIRA_API_TOKEN: "tok",
      LINEAR_API_URL: `${base}/graphql`, LINEAR_API_KEY: "lin_key",
    });
    // A local clone of the remote to work in.
    repo = join(gh.tmp, "work");
    execFileSync("git", ["clone", "-q", gh.remote, repo]);
  });
  afterEach(() => {
    api.server.close();
    gh.restore();
  });

  it("jira: reads the ticket, comments plan and result as ADF, pushes the branch", async () => {
    const s = await runFlow(loadFlow("jira-ticket", repo).flow, {
      task: "", repo, runsDir: join(gh.tmp, "runs"), claudeBin, vars: { ticket: "PROJ-9", test_cmd: "test -f feature.txt" },
    });
    expect(s.reason).toBeUndefined();
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.output).toContain("# PROJ-9: Add feature.txt");
    expect(s.history[0]!.output).toContain("--- comment by Ann:\nplain text is fine");
    const comments = api.calls.filter((c) => c.method === "POST");
    expect(comments).toHaveLength(2);
    expect(comments[0]!.auth).toBe(`Basic ${Buffer.from("me@x:tok").toString("base64")}`);
    const text = (c: (typeof comments)[0]) => c.body.body.content.map((p: any) => p.content.map((t: any) => t.text).join("")).join("\n");
    expect(text(comments[0]!)).toContain("🤖 Spaghetti Code Foundry plan:");
    expect(text(comments[0]!)).not.toContain("claude-factory plan");
    expect(text(comments[1]!)).toContain("✅ Spaghetti Code Foundry finished: branch ");
    expect(text(comments[1]!)).not.toContain("claude-factory finished");
    expect(text(comments[1]!)).toContain("added feature.txt");
    expect(gh.remoteGit("branch", "--list")).toMatch(/factory\//);
  });

  it("linear: reads the ticket and comments via GraphQL", async () => {
    const s = await runFlow(loadFlow("linear-ticket", repo).flow, {
      task: "", repo, runsDir: join(gh.tmp, "runs"), claudeBin, vars: { ticket: "ENG-9", test_cmd: "test -f feature.txt" },
    });
    expect(s.reason).toBeUndefined();
    expect(s.history[0]!.output).toContain("# ENG-9: Add feature.txt");
    const mutations = api.calls.filter((c) => c.body?.query?.includes("commentCreate"));
    expect(mutations).toHaveLength(2);
    expect(mutations[0]!.body.variables.issueId).toBe("uuid-9");
    expect(mutations[0]!.auth).toBe("lin_key");
    expect(mutations[0]!.body.variables.body).toContain("🤖 Spaghetti Code Foundry plan:");
    expect(mutations[1]!.body.variables.body).toMatch(/^✅ Spaghetti Code Foundry finished: branch `[^`]+`\n/);
    expect(mutations[1]!.body.variables.body).toContain("added feature.txt");
  });

  it("rejects a malicious ticket key", async () => {
    const s = await runFlow(loadFlow("jira-ticket", repo).flow, {
      task: "", repo, runsDir: join(gh.tmp, "runs"), claudeBin, vars: { ticket: "X-1/../../admin" },
    });
    expect(s.status).toBe("failed");
    expect(api.calls).toHaveLength(0);
  });
});

