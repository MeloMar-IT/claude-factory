import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditEntrySchema, auditPath } from "../src/auth/audit.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// Every action a signed-in person takes in the web interface writes one line to audit.jsonl (#95).

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const WALKFLOW = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const PLAIN = `name: plain
workspace: empty
steps:
  - {id: say, type: shell, run: "echo hi"}
`;

const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});
afterEach(() => kc.fail());

interface Srv {
  base: string;
  tmp: string;
  repo: string;
  logs: string[];
  ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  close: () => void;
}

describe("audit log: actions in the web interface", () => {
  const open: Srv[] = [];
  afterAll(() => {
    for (const s of open) s.close();
  });

  async function boot(): Promise<Srv> {
    const tmp = mkdtempSync(join(tmpdir(), "audit-actions-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    process.env.FACTORY_HOME = join(tmp, "home");
    const logs: string[] = [];
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({ repo, runsDir: join(tmp, "runs"), port, claudeBin, watchers: false, log: (m) => logs.push(m), accountSweepMs: 3_600_000 });
        const s: Srv = { tmp, repo, logs, base: `http://127.0.0.1:${port}`, ctx: started.ctx, close: () => { started.close(); rmSync(tmp, { recursive: true, force: true }); } };
        open.push(s);
        return s;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      }
    }
  }

  const call = async (s: Srv, who: TestSession, method: string, path: string, body?: unknown) => {
    const r = await fetch(s.base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  const all = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : []);
  const events = () => all().filter((l) => "result" in l && l.action !== "sign-in");
  /** The event lines a callback adds. */
  const added = async (fn: () => Promise<unknown>) => {
    const n = events().length;
    await fn();
    return events().slice(n);
  };

  async function world() {
    const s = await boot();
    const admin = await signInAs(s.base);
    const ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    const bob = await signInAs(s.base, { name: "Bob", email: "bob@example.com", role: "user" });
    expect((await call(s, admin, "PUT", "/api/flows/walk", { yaml: WALKFLOW, scope: "repo" })).status).toBe(200);
    const walk = async (who: TestSession) => {
      const r = await call(s, who, "POST", "/api/runs", { flow: "walk", task: "t" });
      expect(r.status).toBe(201);
      const id = r.json().runId as string;
      expect((await s.ctx.scheduler.wait(id))?.status).toBe("waiting");
      return id;
    };
    return { s, admin, ann, bob, walk };
  }

  it("runs: start, approve, reject, cancel and resume", async () => {
    const { s, admin, ann, bob, walk } = await world();
    let id = "";
    const start = await added(async () => void (id = await walk(ann)));
    expect(start).toEqual([expect.objectContaining({ action: "run-start", target: id, by: ann.user.id, result: "ok" })]);
    const ok = await added(async () => expect((await call(s, ann, "POST", `/api/runs/${id}/approve`, { note: "fine" })).status).toBe(202));
    expect(ok).toEqual([expect.objectContaining({ action: "run-approve", target: id, by: ann.user.id })]);
    await s.ctx.scheduler.wait(id);
    const second = await walk(ann);
    expect(await added(async () => void (await call(s, ann, "POST", `/api/runs/${second}/reject`, { note: "no" })))).toEqual([expect.objectContaining({ action: "run-reject", target: second })]);
    await s.ctx.scheduler.wait(second);
    const third = await walk(ann);
    expect(await added(async () => void (await call(s, ann, "POST", `/api/runs/${third}/resume`, {})))).toEqual([expect.objectContaining({ action: "run-resume", target: third })]);
    await s.ctx.scheduler.wait(third);
    // an admin acts on a user's run: by is the admin
    const fourth = await walk(ann);
    expect(await added(async () => void (await call(s, admin, "POST", `/api/runs/${fourth}/approve`, {})))).toEqual([expect.objectContaining({ action: "run-approve", by: admin.user.id })]);
    await s.ctx.scheduler.wait(fourth);
    // cancel: a line only when something was cancelled
    const fifth = await walk(ann);
    const cancel = await added(async () => void (await call(s, ann, "POST", `/api/runs/${fifth}/cancel`, {})));
    const cancelled = events().some((l) => l.action === "run-cancel");
    expect(cancel.length).toBe(cancelled ? 1 : 0);
    // refused calls
    const sixth = await walk(ann);
    const refused = await added(async () => {
      expect((await call(s, bob, "POST", `/api/runs/${sixth}/approve`, {})).status).toBe(404);
      expect((await call(s, ann, "POST", `/api/runs/${second}/approve`, {})).status).toBe(409);
      expect((await call(s, ann, "POST", "/api/runs/nope/approve", {})).status).toBe(404);
      expect((await call(s, ann, "POST", "/api/runs", { flow: "walk", yaml: PLAIN })).status).toBe(403);
      const noCsrf = await fetch(s.base + "/api/runs", { method: "POST", headers: { cookie: ann.cookie, "content-type": "application/json" }, body: JSON.stringify({ flow: "walk" }) });
      expect(noCsrf.status).toBe(403);
    });
    expect(refused).toEqual([]);
  });

  it("credentials: add and remove, with the id and type but never the name", async () => {
    const { s, ann, bob } = await world();
    const secret = fakeToken("Ab1");
    let id = "";
    const add = await added(async () => {
      const r = await call(s, ann, "POST", "/api/credentials", { type: "token", name: "my-secret-name", secret });
      expect(r.status).toBe(201);
      id = r.json().id;
    });
    expect(add).toEqual([expect.objectContaining({ action: "credential-add", target: id, detail: "token", by: ann.user.id })]);
    const none = await added(async () => {
      expect((await call(s, ann, "POST", "/api/credentials", { type: "token", name: "my-secret-name", secret })).status).toBe(409);
      expect((await call(s, ann, "POST", "/api/credentials", { type: "nope", name: "x", secret })).status).toBe(400);
      expect((await call(s, ann, "DELETE", "/api/credentials/33333333-3333-4333-8333-333333333333")).status).toBe(404);
      expect((await call(s, bob, "DELETE", `/api/credentials/${id}`)).status).toBe(404);
    });
    expect(none).toEqual([]);
    const del = await added(async () => expect((await call(s, ann, "DELETE", `/api/credentials/${id}`)).status).toBe(200));
    expect(del).toEqual([expect.objectContaining({ action: "credential-remove", target: id, detail: "token" })]);
    expect(readFileSync(auditPath(), "utf8")).not.toContain("my-secret-name");
  });

  it("repositories: add, change, remove, and the admin settings and transfer", async () => {
    const { s, admin, ann, bob } = await world();
    const token = "github_pat_" + fakeToken("Rq2").slice(4);
    let id = "";
    const add = await added(async () => {
      const r = await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/app", method: "github-token", token });
      expect(r.status).toBe(201);
      id = r.json().id;
    });
    expect(add).toEqual([expect.objectContaining({ action: "repo-add", target: id, detail: "https://github.com/acme/app", by: ann.user.id })]);
    expect(await added(async () => {
      expect((await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/app" })).status).toBe(409);
      expect((await call(s, ann, "POST", "/api/repos", { url: "not a url" })).status).toBe(400);
      expect((await call(s, ann, "DELETE", "/api/repos/33333333-3333-4333-8333-333333333333")).status).toBe(404);
      expect((await call(s, bob, "DELETE", `/api/repos/${id}`)).status).toBe(404);
    })).toEqual([]);
    expect(await added(async () => expect((await call(s, ann, "PUT", `/api/repos/${id}/auth`, { token: "github_pat_" + fakeToken("Nn3").slice(4) })).status).toBe(200))).toEqual([expect.objectContaining({ action: "repo-change", target: id })]);
    expect(await added(async () => expect((await call(s, ann, "PUT", `/api/repos/${id}/auth`, { method: "github-token" })).status).toBe(200))).toEqual([]);
    // admin settings
    const body = { testCommand: "npm test", mainBranch: "main" };
    expect(await added(async () => expect((await call(s, admin, "PUT", `/api/admin/repos/${id}/settings`, body)).status).toBe(200))).toEqual([
      expect.objectContaining({ action: "repo-change", target: id, by: admin.user.id, detail: "settings: mainBranch, testCommand" }),
    ]);
    expect(await added(async () => expect((await call(s, admin, "PUT", `/api/admin/repos/${id}/settings`, body)).status).toBe(200))).toEqual([]);
    expect(await added(async () => {
      expect((await call(s, admin, "PUT", `/api/admin/repos/${id}/settings`, { mainBranch: "a..b" })).status).toBe(400);
      expect((await call(s, admin, "PUT", "/api/admin/repos/33333333-3333-4333-8333-333333333333/settings", body)).status).toBe(404);
    })).toEqual([]);
    expect(await added(async () => expect((await call(s, admin, "PUT", `/api/admin/repos/${id}/settings`, {})).status).toBe(200))).toEqual([expect.objectContaining({ detail: "settings: mainBranch, testCommand" })]);
    // transfer
    expect(await added(async () => expect((await call(s, admin, "POST", `/api/admin/repos/${id}/transfer`, { email: "bob@example.com" })).status).toBe(200))).toEqual([
      expect.objectContaining({ action: "repo-transfer", target: id, detail: bob.user.id }),
    ]);
    expect(await added(async () => {
      expect((await call(s, admin, "POST", `/api/admin/repos/${id}/transfer`, { email: "bob@example.com" })).status).toBe(200);
      expect((await call(s, admin, "POST", `/api/admin/repos/${id}/transfer`, { email: "nobody@example.com" })).status).toBe(404);
    })).toEqual([]);
    // remove, by id and by name
    expect(await added(async () => expect((await call(s, bob, "DELETE", `/api/repos/${id}`)).status).toBe(200))).toEqual([expect.objectContaining({ action: "repo-remove", target: id, detail: "https://github.com/acme/app" })]);
    const r2 = await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/web" });
    expect(await added(async () => expect((await call(s, ann, "DELETE", "/api/repos/acme/web")).status).toBe(200))).toEqual([expect.objectContaining({ action: "repo-remove", target: r2.json().id, detail: "https://github.com/acme/web" })]);
  });

  it("a removed repository with an old key left is logged once, and the retry writes none", async () => {
    const { s, ann } = await world();
    const r = await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/app", method: "github-token", token: "github_pat_" + fakeToken("Ok4").slice(4) });
    kc.fail("delete");
    const lines = await added(async () => expect((await call(s, ann, "DELETE", `/api/repos/${r.json().id}`)).status).toBe(500));
    expect(lines.map((l) => l.action)).toEqual(["repo-remove"]);
    kc.fail();
    expect(await added(async () => expect((await call(s, ann, "DELETE", `/api/repos/${r.json().id}`)).status).toBe(404))).toEqual([]);
  });

  it("flows: a line only for a published flow saved with a new version", async () => {
    const { s, admin, ann } = await world();
    const walk = WALKFLOW.replace("name: walk", "name: pub");
    expect(await added(async () => expect((await call(s, admin, "PUT", "/api/flows/pub", { yaml: walk, scope: "repo" })).status).toBe(200))).toEqual([
      expect.objectContaining({ action: "flow-publish", target: "pub", detail: "1", by: admin.user.id }),
    ]);
    expect(await added(async () => expect((await call(s, admin, "PUT", "/api/flows/pub", { yaml: walk, scope: "repo" })).status).toBe(200))).toEqual([]);
    expect(await added(async () => expect((await call(s, admin, "PUT", "/api/flows/pub", { yaml: walk.replace("echo hi", "echo ho"), scope: "repo" })).status).toBe(200))).toEqual([
      expect.objectContaining({ target: "pub", detail: "2" }),
    ]);
    expect(await added(async () => {
      expect((await call(s, admin, "PUT", "/api/flows/plain", { yaml: PLAIN, scope: "repo" })).status).toBe(200);
      expect((await call(s, admin, "PUT", "/api/flows/pub", { yaml: "name: [", scope: "repo" })).status).toBe(400);
      expect((await call(s, ann, "PUT", "/api/flows/pub", { yaml: walk, scope: "repo" })).status).toBe(403);
    })).toEqual([]);
  });

  it("settings: names of the changed top-level settings, never a value", async () => {
    const { s, admin } = await world();
    const body = { concurrency: 3, notify: { macos: false, command: "echo SECRET-CMD", slack_webhook: "https://example.invalid/SECRET-HOOK" } };
    expect(await added(async () => expect((await call(s, admin, "PUT", "/api/config", body)).status).toBe(200))).toEqual([
      expect.objectContaining({ action: "settings-change", target: "config.yaml", detail: "concurrency, notify", by: admin.user.id }),
    ]);
    expect(await added(async () => expect((await call(s, admin, "PUT", "/api/config", body)).status).toBe(200))).toEqual([]);
    expect(await added(async () => expect((await call(s, admin, "PUT", "/api/config", { concurrency: 0 })).status).toBe(400))).toEqual([]);
    expect(readFileSync(auditPath(), "utf8")).not.toContain("SECRET");
  });

  it("failed calls write no line", async () => {
    const { s, admin, ann } = await world();
    const submit = vi.spyOn(s.ctx.scheduler, "submit").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await added(async () => expect((await call(s, ann, "POST", "/api/runs", { flow: "walk", task: "t" })).status).toBe(500))).toEqual([]);
    submit.mockRestore();
    kc.fail("add");
    expect(await added(async () => {
      expect((await call(s, ann, "POST", "/api/credentials", { type: "token", name: "k", secret: fakeToken("Fa1") })).status).toBe(500);
      expect((await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/app", method: "github-token", token: "github_pat_" + fakeToken("Fa2").slice(4) })).status).toBe(500);
    })).toEqual([]);
    kc.fail();
    const r = await call(s, admin, "POST", "/api/repos", { url: "https://github.com/acme/web" });
    writeFileSync(join(s.tmp, "home", "repos.json"), "not json");
    expect(await added(async () => {
      expect((await call(s, admin, "PUT", `/api/repos/${r.json().id}/auth`, { method: "none" })).status).toBe(500);
      expect((await call(s, admin, "DELETE", `/api/repos/${r.json().id}`)).status).toBe(500);
      expect((await call(s, admin, "PUT", `/api/admin/repos/${r.json().id}/settings`, { mainBranch: "main" })).status).toBe(500);
      expect((await call(s, admin, "POST", `/api/admin/repos/${r.json().id}/transfer`, { email: "ann@example.com" })).status).toBe(500);
    })).toEqual([]);
  });

  it("a line that cannot be written does not fail or undo the action", async () => {
    const { s, admin, ann } = await world();
    rmSync(auditPath(), { force: true });
    mkdirSync(auditPath());
    const run = await call(s, ann, "POST", "/api/runs", { flow: "walk", task: "t" });
    const cred = await call(s, ann, "POST", "/api/credentials", { type: "token", name: "k", secret: fakeToken("Bs1") });
    const repo = await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/app" });
    const flow = await call(s, admin, "PUT", "/api/flows/pub", { yaml: WALKFLOW.replace("name: walk", "name: pub"), scope: "repo" });
    const cfg = await call(s, admin, "PUT", "/api/config", { concurrency: 4 });
    expect([run.status, cred.status, repo.status, flow.status, cfg.status]).toEqual([201, 201, 201, 200, 200]);
    expect((await call(s, ann, "GET", "/api/repos")).json()).toHaveLength(1);
    expect((await call(s, admin, "GET", "/api/config")).json().concurrency).toBe(4);
    for (const a of ["run-start", "credential-add", "repo-add", "flow-publish", "settings-change"]) expect(s.logs).toContain(`audit: audit.jsonl cannot-write (${a})`);
    expect(s.logs.join("\n")).not.toContain(s.tmp);
  });

  it("no line holds a token, password, note, task, command or setting value", async () => {
    const { s, admin, ann, walk } = await world();
    const secret = fakeToken("Zq7");
    const hook = `https://example.invalid/${secret}`;
    const id = await (async () => {
      const r = await call(s, ann, "POST", "/api/runs", { flow: "walk", task: `task ${secret}` });
      expect(r.status).toBe(201);
      await s.ctx.scheduler.wait(r.json().runId);
      return r.json().runId as string;
    })();
    expect((await call(s, ann, "POST", `/api/runs/${id}/approve`, { note: `note ${secret}` })).status).toBe(202);
    await s.ctx.scheduler.wait(id);
    expect((await call(s, ann, "POST", "/api/credentials", { type: "token", name: secret, secret })).status).toBe(201);
    const repo = await call(s, ann, "POST", "/api/repos", { url: "https://github.com/acme/app", method: "github-token", token: "github_pat_" + secret.slice(4) });
    expect(repo.status).toBe(201);
    expect((await call(s, admin, "PUT", `/api/admin/repos/${repo.json().id}/settings`, { testCommand: `echo ${secret}` })).status).toBe(200);
    expect((await call(s, admin, "PUT", "/api/config", { notify: { command: `echo ${secret}`, slack_webhook: hook } })).status).toBe(200);
    void walk;
    const text = readFileSync(auditPath(), "utf8");
    for (const bad of [secret, secret.slice(4), "echo", ann.token, admin.token, "test-password-12345"]) expect(text).not.toContain(bad);
    const keys = new Set(["time", "by", "action", "result", "target", "detail"]);
    for (const l of text.split("\n").filter(Boolean)) {
      const line = JSON.parse(l);
      expect(AuditEntrySchema.safeParse(line).success).toBe(true);
      if ("result" in line && line.action !== "sign-in") expect(Object.keys(line).every((k) => keys.has(k))).toBe(true);
    }
    expect(events().length).toBeGreaterThanOrEqual(6);
  });
});
