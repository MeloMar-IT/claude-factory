import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULES, findRule, permissionTable, ruleKey } from "../src/server/permissions.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let repo: string;
let runsDir: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let cy: TestSession;
const logs: string[] = [];

const WALK = `name: walk
workspace: empty
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const QUICK = (name: string, extra = "", workspace = "empty") => `name: ${name}\nworkspace: ${workspace}\n${extra}steps:\n  - {id: a, type: shell, run: "true"}\n`;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "perm-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  ({ close, ctx } = await startServer({
    repo,
    runsDir,
    port,
    claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
    watchers: false,
    log: (m) => void logs.push(m),
  }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  cy = await signInAs(base, { name: "Cy", email: "cy@example.com", role: "user" });
  expect((await call(ann, "POST", "/api/repos", { name: "acme/app" })).status).toBe(201);
  expect((await call(bob, "POST", "/api/repos", { name: "other/thing" })).status).toBe(201);
  expect((await call(admin, "PUT", "/api/flows/walk", { yaml: WALK, scope: "repo" })).status).toBe(200);
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const json = () => JSON.parse(text);
  return { status: r.status, text, json, error: () => (JSON.parse(text) as { error?: string }).error };
}

/** The status of a stream call; the stream is closed as soon as the headers are there. */
async function streamStatus(who: TestSession, path: string) {
  const ctl = new AbortController();
  const r = await fetch(base + path, { headers: who.headers(), signal: ctl.signal });
  const status = r.status;
  const type = r.headers.get("content-type") ?? "";
  const text = status === 200 ? "" : await r.text();
  ctl.abort();
  return { status, type, text };
}

/** Starts the walk flow as `who` and waits until it waits for approval. */
async function waitingRun(who: TestSession): Promise<string> {
  const r = await call(who, "POST", "/api/runs", { flow: "walk", task: "walk" });
  expect(r.status).toBe(201);
  const { runId } = r.json() as { runId: string };
  const s = await ctx.scheduler.wait(runId);
  expect(s?.status).toBe("waiting");
  return runId;
}

const runJson = (id: string) => JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

interface Example {
  path: string;
  body?: unknown;
  user: number;
  admin: number;
}
const no = (path: string, admin: number, body?: unknown): Example => ({ path, body, user: 403, admin });
const EXAMPLES: Record<string, Example> = {
  "GET info": no("info", 200),
  "GET config": no("config", 200),
  "PUT config": no("config", 400, { concurrency: 0 }),
  "GET watchers": no("watchers", 200),
  "POST watchers/:id/tick": no("watchers/x/tick", 400, {}),
  "POST clean": no("clean", 200, {}),
  "GET providers": no("providers", 200),
  "POST providers/test": no("providers/test", 400, {}),
  "GET evals": no("evals", 200),
  "GET stats": no("stats", 200),
  "GET flows": { path: "flows", user: 200, admin: 200 },
  "GET flows/:name": no("flows/walk", 200),
  "PUT flows/:name": no("flows/walk", 400, {}),
  "DELETE flows/:name": no("flows/nope", 404),
  "GET blocks": no("blocks", 200),
  "PUT blocks/:id": no("blocks/x", 400, {}),
  "DELETE blocks/:id": no("blocks/nope", 404),
  "POST validate": no("validate", 200, {}),
  "POST generate": no("generate", 400, {}),
  "GET queue": no("queue", 200),
  "GET runs": { path: "runs", user: 200, admin: 200 },
  "POST runs": { path: "runs", body: {}, user: 400, admin: 400 },
  "GET runs/:id": { path: "runs/nope", user: 403, admin: 404 },
  "POST runs/:id/cancel": { path: "runs/nope/cancel", body: {}, user: 403, admin: 200 },
  "POST runs/:id/resume": { path: "runs/nope/resume", body: {}, user: 403, admin: 404 },
  "POST runs/:id/approve": { path: "runs/nope/approve", body: {}, user: 403, admin: 404 },
  "POST runs/:id/reject": { path: "runs/nope/reject", body: {}, user: 403, admin: 404 },
  "GET runs/:id/events": { path: "runs/nope/events", user: 403, admin: 200 },
  "GET runs/:id/diff": { path: "runs/nope/diff", user: 403, admin: 404 },
  "GET runs/:id/transcript/:n": { path: "runs/nope/transcript/0", user: 403, admin: 404 },
  "GET next": no("next", 200),
  "GET health": no("health", 200),
  "GET board": no("board", 200),
  "GET since": no("since", 400),
  "GET your-turn": no("your-turn", 200),
  "POST your-turn/dismiss": no("your-turn/dismiss", 400, {}),
  "POST your-turn/restore": no("your-turn/restore", 200, {}),
  "GET credentials": { path: "credentials", user: 200, admin: 200 },
  "POST credentials": { path: "credentials", body: {}, user: 400, admin: 400 },
  "DELETE credentials/:id": { path: `credentials/${UNKNOWN}`, user: 404, admin: 404 },
  "GET repos": { path: "repos", user: 200, admin: 200 },
  "POST repos": { path: "repos", body: {}, user: 400, admin: 400 },
  "DELETE repos/:owner/:name": { path: "repos/nope/nope", user: 404, admin: 404 },
};

describe("the table", () => {
  it("has unique rule keys", () => {
    const keys = RULES.map(ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("finds a rule only for the exact method and number of segments", () => {
    expect(findRule("GET", ["info"])?.path).toBe("info");
    expect(findRule("GET", ["info", "extra"])).toBeUndefined();
    expect(findRule("POST", ["flows"])).toBeUndefined();
    expect(findRule("GET", [])).toBeUndefined();
    expect(findRule("GET", ["runs", "a", "b"])).toBeUndefined();
    expect(findRule("GET", ["runs", "a", "diff"])?.path).toBe("runs/:id/diff");
    expect(findRule("DELETE", ["repos", "a", "b"])?.path).toBe("repos/:owner/:name");
    expect(findRule("DELETE", ["repos", "a"])).toBeUndefined();
  });

  it("has an example for every rule and a rule for every example", () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(RULES.map(ruleKey).sort());
  });

  it("names every route group of the source in a rule (or session and setup)", () => {
    const dir = resolve("src/server");
    const groups = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/seg\[0\]\s*(?:===|!==)\s*"([^"]+)"/g)) groups.add(m[1]!);
    }
    expect(groups.size).toBeGreaterThan(10);
    const known = new Set([...RULES.map((r) => r.path.split("/")[0]!), "session", "setup"]);
    expect([...groups].filter((g) => !known.has(g))).toEqual([]);
  });
});

describe("the guide", () => {
  it("contains the generated table", () => {
    expect(readFileSync("docs/USER_GUIDE.md", "utf8")).toContain(permissionTable());
  });
});

describe("the walk", () => {
  it("answers every rule as the table says, to both roles", async () => {
    for (const rule of RULES) {
      const key = ruleKey(rule);
      const ex = EXAMPLES[key]!;
      const url = `/api/${ex.path}`;
      const ask = async (who: TestSession) => {
        if (rule.path.endsWith("/events")) return streamStatus(who, url).then((r) => ({ status: r.status, text: r.text, error: () => (r.text ? (JSON.parse(r.text) as { error?: string }).error : undefined) }));
        const r = await call(who, rule.method, url, ex.body);
        return { status: r.status, text: r.text, error: r.error };
      };
      const u = await ask(ann);
      expect(u.status, `user ${key}`).toBe(ex.user);
      if (rule.user === "no") expect(JSON.parse(u.text), `user ${key}`).toEqual({ error: "not allowed for your role" });
      const a = await ask(admin);
      expect(a.status, `admin ${key}`).toBe(ex.admin);
      if (a.text) {
        expect(a.error(), `admin ${key}`).not.toBe("not allowed for your role");
        expect(a.error(), `admin ${key}`).not.toBe("not found");
      }
    }
    expect(kc.items()).toEqual({});
  });

  it("answers 404 to a call without a rule, for both roles", async () => {
    for (const who of [ann, admin]) {
      for (const path of ["/api/nope", "/api/info/extra"]) {
        const r = await call(who, "GET", path);
        expect(r.status).toBe(404);
        expect(r.json()).toEqual({ error: "not found" });
      }
    }
    expect((await call(admin, "POST", "/api/flows", {})).status).toBe(404);
    expect((await call(admin, "GET", "/api/blocks/x")).status).toBe(404);
  });

  it("checks the CSRF token before the role", async () => {
    const r = await fetch(base + "/api/config", { method: "PUT", headers: { cookie: ann.cookie, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "bad CSRF token" });
  });

  it("gives a user an empty list of credentials", async () => {
    const r = await call(cy, "GET", "/api/credentials");
    expect(r.status).toBe(200);
    expect(r.json()).toEqual([]);
  });
});

describe("own runs", () => {
  let foreign: string;
  let noOwner: string;
  let broken: string;
  beforeAll(async () => {
    foreign = await waitingRun(admin);
    noOwner = "noowner-run";
    mkdirSync(join(runsDir, noOwner));
    const { owner: _o, ...rest } = runJson(foreign);
    writeFileSync(join(runsDir, noOwner, "run.json"), JSON.stringify({ ...rest, runId: noOwner, runDir: join(runsDir, noOwner) }));
    broken = "broken-run";
    mkdirSync(join(runsDir, broken));
    writeFileSync(join(runsDir, broken, "run.json"), "{ not json");
  });

  const OWN: Record<string, number> = {
    "GET runs/:id": 200,
    "POST runs/:id/cancel": 200,
    "POST runs/:id/resume": 202,
    "POST runs/:id/approve": 202,
    "POST runs/:id/reject": 202,
    "GET runs/:id/events": 200,
    "GET runs/:id/diff": 200,
    "GET runs/:id/transcript/:n": 200,
  };
  const own = RULES.filter((r) => r.user === "own");

  it("covers every own rule", () => {
    expect(Object.keys(OWN).sort()).toEqual(own.map(ruleKey).sort());
  });

  const pathFor = (rule: (typeof own)[number], id: string) => `/api/${rule.path.replace(":id", id).replace(":n", "0")}`;
  const send = (who: TestSession, rule: (typeof own)[number], id: string) =>
    rule.path.endsWith("/events")
      ? streamStatus(who, pathFor(rule, id)).then((r) => ({ status: r.status, text: r.text }))
      : call(who, rule.method, pathFor(rule, id), rule.method === "POST" ? {} : undefined);

  it.each(own.map((r) => [ruleKey(r), r] as const))("%s: the owner may, nobody else", async (key, rule) => {
    const mine = await waitingRun(ann);
    const r = await send(ann, rule, mine);
    expect(r.status).toBe(OWN[key]);
    for (const id of [foreign, "unknown-run", noOwner, broken]) {
      const x = await send(ann, rule, id);
      expect(x.status, `${key} ${id}`).toBe(403);
      expect(JSON.parse(x.text), `${key} ${id}`).toEqual({ error: "not your run" });
    }
    await ctx.scheduler.idle();
  });

  it("an admin may use every call on any run", async () => {
    expect((await call(admin, "GET", `/api/runs/${runJson(noOwner).runId}`)).status).toBe(200);
  });

  it("lets the user answer a run with a note, and the note reaches the run", async () => {
    const mine = await waitingRun(ann);
    const r = await call(ann, "POST", `/api/runs/${mine}/approve`, { note: "yes, use B" });
    expect(r.status).toBe(202);
    await ctx.scheduler.idle();
    expect(runJson(mine).history.map((h: { output: string }) => h.output).join("\n")).toContain("approved by ui: yes, use B");
  });
});

describe("starting a run as a user", () => {
  const folderConfig = join(repo ?? "", ".claude-factory", "config.yaml");
  const start = (who: TestSession, body: unknown) => call(who, "POST", "/api/runs", body);
  const saveFlow = async (name: string, yaml: string) => expect((await call(admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
  const confFile = () => join(repo, ".claude-factory", "config.yaml");

  beforeAll(async () => {
    await saveFlow("withrepo", QUICK("withrepo", "vars:\n  github_repo: owner/repo\n"));
    await saveFlow("plain", QUICK("plain"));
    await saveFlow("wt", QUICK("wt", "", "worktree"));
    expect(folderConfig).toContain("config.yaml");
  });

  it("refuses what only an admin may do", async () => {
    const yaml = await start(ann, { yaml: QUICK("x"), task: "t" });
    expect(yaml.status).toBe(403);
    expect(yaml.error()).toBe("only an admin can run a flow that is not saved");
    const folder = await start(ann, { flow: "plain", repo: tmp });
    expect(folder.status).toBe(403);
    expect(folder.error()).toBe("only an admin can choose the folder");
  });

  it("refuses yaml and repo before looking at other bad input", async () => {
    const bad = { "bad.key": "x" };
    expect((await start(ann, { yaml: QUICK("x"), vars: bad, task: 5 })).status).toBe(403);
    expect((await start(ann, { repo: tmp, vars: bad, task: 5 })).status).toBe(403);
    expect((await start(ann, { flow: "plain", vars: bad })).status).toBe(400);
  });

  it("refuses a path with 400 and an unknown flow with 404", async () => {
    const file = join(tmp, "x.yaml");
    writeFileSync(file, QUICK("x"));
    expect((await start(ann, { flow: file })).status).toBe(400);
    expect((await start(ann, { flow: "../x" })).status).toBe(400);
    expect((await start(ann, { flow: "nothing-like-it" })).status).toBe(404);
  });

  it("accepts a flow default that is one of the user's repositories", async () => {
    await saveFlow("owned", QUICK("owned", "vars:\n  github_repo: acme/app\n"));
    expect((await start(ann, { flow: "owned" })).status).toBe(201);
    expect((await start(bob, { flow: "owned" })).status).toBe(403);
  });

  it("wants one of the user's repositories in github_repo", async () => {
    const set = 'set the var "github_repo" to one of your repositories';
    for (const body of [{ flow: "withrepo" }, { flow: "withrepo", vars: { github_repo: "" } }]) {
      const r = await start(ann, body);
      expect([r.status, r.error()]).toEqual([403, set]);
    }
    for (const gh of ["nobody/none", "other/thing", "OWNER/REPO"]) {
      const r = await start(ann, { flow: "withrepo", vars: { github_repo: gh } });
      expect(r.status, gh).toBe(403);
    }
    expect((await start(ann, { flow: "withrepo", vars: { github_repo: "nobody/none" } })).error()).toBe('"nobody/none" is not one of your repositories');
  });

  it("starts with the repository in another case, saves the owner and the source", async () => {
    const r = await start(ann, { flow: "withrepo", task: "t", vars: { github_repo: "ACME/App" } });
    expect(r.status).toBe(201);
    const { runId } = r.json() as { runId: string };
    await ctx.scheduler.wait(runId);
    const run = runJson(runId);
    expect(run).toMatchObject({ owner: ann.user.id, source: "ui", vars: { github_repo: "ACME/App" } });
  });

  it("runs a flow without github_repo in the server's folder, with the folder's variables", async () => {
    mkdirSync(join(repo, ".claude-factory"), { recursive: true });
    writeFileSync(confFile(), "vars:\n  test_cmd: 'true'\n");
    try {
      const r = await start(ann, { flow: "wt", task: "t" });
      expect(r.status).toBe(201);
      const { runId } = r.json() as { runId: string };
      await ctx.scheduler.wait(runId);
      const run = runJson(runId);
      expect(run.repo).toBe(repo);
      expect(run.vars.test_cmd).toBe("true");
      expect(run.owner).toBe(ann.user.id);

      writeFileSync(confFile(), "vars:\n  github_repo: other/repo\n");
      const none = await start(ann, { flow: "wt" });
      expect([none.status, none.error()]).toEqual([403, 'set the var "github_repo" to one of your repositories']);
      const given = await start(ann, { flow: "wt", vars: { github_repo: "acme/app" } });
      expect(given.status).toBe(201);
      const id = (given.json() as { runId: string }).runId;
      await ctx.scheduler.wait(id);
      expect(runJson(id).vars.github_repo).toBe("acme/app");
    } finally {
      rmSync(confFile(), { force: true });
    }
  });

  it("checks every flow of the user's list in the same way", async () => {
    const list = (await call(ann, "GET", "/api/flows")).json() as { name: string }[];
    expect(list.map((f) => f.name)).toEqual(expect.arrayContaining(["walk", "plain", "wt", "withrepo"]));
    for (const { name } of list) {
      const r = await start(ann, { flow: name, vars: { github_repo: "nobody/none" } });
      expect([name, r.status, r.error()]).toEqual([name, 403, '"nobody/none" is not one of your repositories']);
    }
    expect((await start(ann, { flow: "unlisted-name", vars: { github_repo: "nobody/none" } })).status).toBe(404);
  });

  it("lets an admin start an inline flow in a folder of their choice", async () => {
    const r = await start(admin, { yaml: QUICK("inline", "", "inplace"), repo: tmp, task: "t" });
    expect(r.status).toBe(201);
    const { runId } = r.json() as { runId: string };
    await ctx.scheduler.wait(runId);
    expect(runJson(runId)).toMatchObject({ owner: admin.user.id, repo: tmp, source: "ui" });
  });
});

describe("lists", () => {
  it("shows a user their own runs and an admin all of them", async () => {
    const mine = await waitingRun(ann);
    const his = await waitingRun(bob);
    const ids = async (who: TestSession) => {
      const r = await call(who, "GET", "/api/runs");
      expect(r.status, r.text).toBe(200);
      return (r.json() as { runId: string }[]).map((x) => x.runId);
    };
    const a = await ids(ann);
    expect(a).toContain(mine);
    expect(a).not.toContain(his);
    for (const id of a) expect(runJson(id).owner).toBe(ann.user.id);
    const all = await ids(admin);
    expect(all).toEqual(expect.arrayContaining([mine, his]));
    expect(all.length).toBeGreaterThan(a.length);
  });

  it("gives a user only name and description of the published flows", async () => {
    const dir = join(repo, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.yaml"), "name: [");
    writeFileSync(join(dir, "my flow.yaml"), QUICK("x"));
    writeFileSync(join(dir, "a.b.yaml"), QUICK("x"));
    try {
      const list = (await call(ann, "GET", "/api/flows")).json() as Record<string, unknown>[];
      for (const f of list) expect(Object.keys(f).sort()).toEqual(["description", "name"]);
      const names = list.map((f) => f.name);
      expect(names).toContain("walk");
      for (const hidden of ["bad", "my flow", "a.b"]) expect(names).not.toContain(hidden);
      expect(list.find((f) => f.name === "walk")).toEqual({ name: "walk", description: "" });
      const adminList = (await call(admin, "GET", "/api/flows")).json() as Record<string, unknown>[];
      expect(adminList.map((f) => f.name)).toEqual(expect.arrayContaining(["bad", "my flow", "a.b"]));
      expect(adminList.find((f) => f.name === "walk")).toMatchObject({ scope: "repo" });
      expect(adminList.every((f) => "path" in f && "scope" in f)).toBe(true);
    } finally {
      for (const f of ["bad.yaml", "my flow.yaml", "a.b.yaml"]) rmSync(join(dir, f), { force: true });
    }
  });
});

describe("repositories over HTTP", () => {
  it("adds, refuses and removes", async () => {
    expect((await call(ann, "POST", "/api/repos", { name: "acme/extra" })).status).toBe(201);
    expect((await call(ann, "POST", "/api/repos", { name: "acme/extra" })).status).toBe(409);
    for (const name of ["owner/repo", "Owner/Repo", "a/..", "nope"]) expect((await call(ann, "POST", "/api/repos", { name })).status, name).toBe(400);
    expect((await call(ann, "GET", "/api/repos")).json()).toEqual(["acme/app", "acme/extra"]);
    expect((await call(cy, "GET", "/api/repos")).json()).toEqual([]);
    expect((await call(ann, "DELETE", "/api/repos/acme/extra")).status).toBe(200);
    const again = await call(ann, "DELETE", "/api/repos/acme/extra");
    expect([again.status, again.error()]).toEqual([404, "no such repository"]);
  });

  it("answers an unreadable repos.json with plain text and logs no path", async () => {
    const file = join(tmp, "home", "repos.json");
    const aside = `${file}.aside`;
    renameSync(file, aside);
    mkdirSync(file);
    logs.length = 0;
    try {
      const list = await call(ann, "GET", "/api/repos");
      expect([list.status, list.error()]).toEqual([500, "the repository list is not working; see the server log"]);
      const run = await call(ann, "POST", "/api/runs", { flow: "plain", vars: { github_repo: "acme/app" } });
      expect([run.status, run.error()]).toEqual([500, "the repository list is not working; see the server log"]);
      expect(logs).toContain("repos: repos.json unreadable");
      expect(logs.join("\n")).not.toContain(tmp);
      expect(list.text + run.text).not.toContain(tmp);
    } finally {
      rmSync(file, { recursive: true });
      renameSync(aside, file);
    }
    expect((await call(ann, "GET", "/api/repos")).status).toBe(200);
  });
});
