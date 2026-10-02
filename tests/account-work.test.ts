import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userCommand, type UserIo } from "../src/auth/cli.js";
import { authLockHeld } from "../src/auth/store.js";
import { createUser, getUser, setStatus, takeStopWork, usersPath, deleteUser } from "../src/auth/users.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, queuerOf, type Job, type RunEvent } from "../src/queue/scheduler.js";
import { accountActive, accountSweeper } from "../src/server/account-work.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD, signInAs, type TestSession } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const PW = "test-password-12345";

const GATED = `name: gated
workspace: empty
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const PLAIN = `name: plain
workspace: empty
steps:
  - {id: a, type: shell, run: "true"}
`;
const SLOWFLOW = `name: slow
workspace: empty
one_per_repo: true
publish:
  enabled: true
steps:
  - {id: a, type: shell, run: "sleep 2"}
`;
const WALKFLOW = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;

const savedHome = process.env.FACTORY_HOME;
const savedNotify = process.env.FACTORY_NO_NOTIFY;
let kc: FakeKeychain;
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return fn();
};

// ---- scheduler and sweeper, no HTTP -------------------------------------------------------------------

describe("account work in the scheduler and the sweeper", () => {
  let tmp: string;
  let repo: string;
  let runsDir: string;
  let queueFile: string;
  const stopped = (): Config => ({ ...ConfigSchema.parse({}), concurrency: 0 });
  const run = (flow = PLAIN): Job => ({ kind: "run", flow: parseFlow(flow), task: "t", repo, vars: {} });
  const runJson = (id: string) => JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));
  /** A run that waits for approval, made by the engine. */
  const waiting = async (owner: string | undefined, runId: string) => {
    const s = await runFlow(parseFlow(GATED), { task: "t", repo, runsDir, claudeBin, runId, owner });
    expect(s.status).toBe("waiting");
    return runId;
  };
  const idsOf = (s: Scheduler) => s.queue().pending.map((p) => p.runId);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "account-work-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    runsDir = join(tmp, "runs");
    queueFile = join(tmp, "queue.json");
    process.env.FACTORY_HOME = join(tmp, "home");
  });
  afterEach(() => {
    if (savedNotify === undefined) delete process.env.FACTORY_NO_NOTIFY;
    else process.env.FACTORY_NO_NOTIFY = savedNotify;
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("saves queuedBy in queue.json and keeps it after a restart", () => {
    const a = new Scheduler({ runsDir, queueFile, config: stopped });
    const id = a.submit(run(), { source: "ui", owner: "ann", queuedBy: "adm" });
    expect(JSON.parse(readFileSync(queueFile, "utf8"))[0].queuedBy).toBe("adm");
    const b = new Scheduler({ runsDir, queueFile, config: stopped });
    expect(b.isQueued(id)).toBe(true);
    expect(b.cancelAccount("adm")).toEqual({ queued: 1, running: 0, waiting: 0 });
  });

  it("cancelAccount drops only the jobs the account queued, persists, and a second call gives zeros", () => {
    const s = new Scheduler({ runsDir, queueFile, config: stopped });
    s.submit(run(), { source: "ui", owner: "ann", queuedBy: "ann" });
    s.submit(run(), { source: "ui", owner: "ann", queuedBy: "ann" });
    const bobs = s.submit(run(), { source: "ui", owner: "bob", queuedBy: "bob" });
    const bare = s.submit(run());
    expect(s.cancelAccount("ann")).toEqual({ queued: 2, running: 0, waiting: 0 });
    expect(idsOf(s)).toEqual([bobs, bare]);
    expect(JSON.parse(readFileSync(queueFile, "utf8"))).toHaveLength(2);
    expect(s.cancelAccount("ann")).toEqual({ queued: 0, running: 0, waiting: 0 });
  });

  it("a dropped approve job leaves the run waiting", async () => {
    const id = await waiting("ann", "20260101-000000-aaaa");
    const s = new Scheduler({ runsDir, queueFile, config: stopped });
    s.submit({ kind: "resume", runId: id, decision: { approved: true, by: "ui" } }, { source: "ui approve", queuedBy: "ann" });
    expect(s.cancelAccount("ann")).toEqual({ queued: 1, running: 0, waiting: 0 });
    expect(runJson(id).status).toBe("waiting");
  });

  it("stopWork cancels waiting runs of the account and drops jobs for them; others are kept", async () => {
    const mine = await waiting("ann", "20260101-000000-aaaa");
    const bobs = await waiting("bob", "20260101-000000-bbbb");
    const none = await waiting(undefined, "20260101-000000-cccc");
    const odd = await waiting("ann", "20260101-000000-dddd");
    writeFileSync(join(runsDir, odd, "run.json"), JSON.stringify({ ...runJson(odd), runId: "other-id" }));
    const broken = "20260101-000000-eeee";
    mkdirSync(join(runsDir, broken));
    writeFileSync(join(runsDir, broken, "run.json"), "{ nope");
    const s = new Scheduler({ runsDir, queueFile, config: stopped });
    s.submit({ kind: "resume", runId: mine, decision: { approved: true, by: "ui" } }, { source: "ui approve", queuedBy: "adm" });
    expect(s.cancelAccount("ann", { stopWork: true })).toEqual({ queued: 1, running: 0, waiting: 1 });
    expect(idsOf(s)).toEqual([]);
    expect(runJson(mine).status).toBe("cancelled");
    expect(runJson(bobs).status).toBe("waiting");
    expect(runJson(none).status).toBe("waiting");
    expect(runJson(odd).status).toBe("waiting");
  });

  it("enforceAccounts: blocked, deleted, and nothing for an active account", () => {
    const s = new Scheduler({ runsDir, queueFile, config: stopped });
    s.submit(run(), { source: "ui", owner: "ann", queuedBy: "ann" });
    s.submit(run(), { source: "ui", owner: "gone", queuedBy: "gone" });
    s.submit(run(), { source: "ui", owner: "bob", queuedBy: "bob" });
    const r = s.enforceAccounts([{ id: "ann", blocked: true }, { id: "bob", blocked: false }]);
    expect(r).toEqual([
      { accountId: "ann", why: "blocked", queued: 1, running: 0, waiting: 0 },
      { accountId: "gone", why: "deleted", queued: 1, running: 0, waiting: 0 },
    ]);
    expect(s.queue().pending).toHaveLength(1);
    expect(s.enforceAccounts([{ id: "bob", blocked: false }])).toEqual([]);
  });

  it("an old entry without queuedBy counts as queued by its owner; a watcher entry does not", () => {
    const base = { runId: "x", job: run(), enqueuedAt: "2026-01-01T00:00:00.000Z" };
    expect(queuerOf({ ...base, source: "ui", owner: "ann" })).toBe("ann");
    expect(queuerOf({ ...base, source: "watcher w issue #1", owner: "ann" })).toBeUndefined();
    expect(queuerOf({ ...base, job: { kind: "resume", runId: "x" }, source: "ui", owner: "ann" })).toBeUndefined();
  });

  it("the pump holds jobs of inactive accounts, also when the check throws, and not without the option", async () => {
    const cfg = ConfigSchema.parse({});
    writeFileSync(queueFile, JSON.stringify([
      { runId: "20260101-000000-hold", job: run(), source: "ui", owner: "ann", queuedBy: "ann", enqueuedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "20260101-000000-free", job: run(), enqueuedAt: "2026-01-01T00:00:00.000Z" },
    ]));
    const held = new Scheduler({ runsDir, queueFile, config: () => cfg, accountActive: () => false });
    await held.wait("20260101-000000-free");
    await until(() => !held.isActive("20260101-000000-free"));
    expect(existsSync(join(runsDir, "20260101-000000-free"))).toBe(true);
    expect(held.isQueued("20260101-000000-hold")).toBe(true);
    expect(existsSync(join(runsDir, "20260101-000000-hold"))).toBe(false);

    const throwing = new Scheduler({ runsDir, queueFile, config: () => cfg, accountActive: () => { throw new Error("x"); } });
    await new Promise((r) => setTimeout(r, 100));
    expect(throwing.isQueued("20260101-000000-hold")).toBe(true);

    const plain = new Scheduler({ runsDir, queueFile, config: () => cfg });
    await plain.wait("20260101-000000-hold");
    await plain.idle();
    expect(runJson("20260101-000000-hold").status).toBe("succeeded");
  });

  it("cancels a run that waits while its notify command still runs", async () => {
    delete process.env.FACTORY_NO_NOTIFY;
    const cfg: Config = { ...ConfigSchema.parse({}), notify: { macos: false, command: "sleep 1", on: ["waiting"] } as Config["notify"] };
    const s = new Scheduler({ runsDir, config: () => cfg, claudeBin });
    const id = s.submit(run(GATED), { source: "ui", owner: "ann", queuedBy: "ann" });
    const events: RunEvent[] = [];
    s.subscribe(id, (e) => events.push(e));
    expect(await until(() => s.get(id)?.status === "waiting" && s.isActive(id))).toBe(true);
    expect(s.cancelAccount("ann", { stopWork: true })).toEqual({ queued: 0, running: 0, waiting: 1 });
    expect(s.get(id)?.status).toBe("cancelled");
    expect(runJson(id).status).toBe("cancelled");
    expect(events.some((e) => e.type === "update" && e.summary.status === "cancelled")).toBe(true);
    expect(s.cancelAccount("ann", { stopWork: true })).toEqual({ queued: 0, running: 0, waiting: 0 });
    await s.wait(id);
    expect(runJson(id).status).toBe("cancelled");
  });

  it("does not abort or count a finished run whose notify command still runs", async () => {
    delete process.env.FACTORY_NO_NOTIFY;
    const cfg: Config = { ...ConfigSchema.parse({}), notify: { macos: false, command: "sleep 1", on: ["succeeded"] } as Config["notify"] };
    const s = new Scheduler({ runsDir, config: () => cfg, claudeBin });
    const id = s.submit(run(PLAIN), { source: "ui", owner: "ann", queuedBy: "ann" });
    expect(await until(() => s.get(id)?.status === "succeeded" && s.isActive(id))).toBe(true);
    expect(s.cancelAccount("ann", { stopWork: true })).toEqual({ queued: 0, running: 0, waiting: 0 });
    await s.wait(id);
    expect(runJson(id).status).toBe("succeeded");
  });

  describe("sweeper", () => {
    let ann: string;
    let adm: string;
    beforeEach(async () => {
      adm = (await createUser({ name: "Adm", email: "adm@example.com", password: PW, role: "admin" })).id;
      ann = (await createUser({ name: "Ann", email: "ann@example.com", password: PW })).id;
    });

    it("takeStopWork acts under the lock, then removes the request", async () => {
      await setStatus(ann, "blocked", { stopWork: true });
      const request = getUser(ann)!.stopWork;
      let seen: string | undefined;
      let held = false;
      expect(takeStopWork(ann, (r) => { seen = r; held = authLockHeld(); })).toBe(true);
      expect(seen).toBe(request);
      expect(held).toBe(true);
      expect(getUser(ann)!.stopWork).toBeUndefined();
      expect(takeStopWork(ann, () => { throw new Error("no"); })).toBe(false);
    });

    it("takeStopWork does nothing for an unblocked or unknown account, and keeps the request when act throws", async () => {
      const calls: string[] = [];
      expect(takeStopWork(ann, (r) => calls.push(r))).toBe(false);
      expect(takeStopWork("00000000-0000-4000-8000-000000000000", (r) => calls.push(r))).toBe(false);
      await setStatus(ann, "blocked", { stopWork: true });
      await setStatus(ann, "active");
      expect(takeStopWork(ann, (r) => calls.push(r))).toBe(false);
      await setStatus(ann, "blocked", { stopWork: true });
      expect(() => takeStopWork(ann, () => { throw new Error("no"); })).toThrow("no");
      expect(getUser(ann)!.stopWork).toBeDefined();
      expect(calls).toEqual([]);
    });

    it("a stop-work request is handled once; later waiting runs stay", async () => {
      const first = await waiting(ann, "20260101-000000-aaaa");
      const s = new Scheduler({ runsDir, config: stopped });
      const logs: string[] = [];
      const sweep = accountSweeper(s, (m) => logs.push(m));
      await setStatus(ann, "blocked", { stopWork: true });
      sweep();
      expect(runJson(first).status).toBe("cancelled");
      expect(getUser(ann)!.stopWork).toBeUndefined();
      expect(logs).toEqual([`account ${ann} stop-work: cancelled 0 queued, 0 running, 1 waiting`]);
      const later = await waiting(ann, "20260101-000000-bbbb");
      sweep();
      sweep();
      expect(runJson(later).status).toBe("waiting");
    });

    it("an unblock before the sweep leaves the run waiting and logs nothing", async () => {
      const id = await waiting(ann, "20260101-000000-aaaa");
      const s = new Scheduler({ runsDir, config: stopped });
      const logs: string[] = [];
      await setStatus(ann, "blocked", { stopWork: true });
      await setStatus(ann, "active");
      accountSweeper(s, (m) => logs.push(m))();
      expect(runJson(id).status).toBe("waiting");
      expect(logs).toEqual([]);
    });

    it("a request that cannot be removed cancels once and logs the problem once, without a path", async () => {
      const id = await waiting(ann, "20260101-000000-aaaa");
      const s = new Scheduler({ runsDir, config: stopped });
      const logs: string[] = [];
      const sweep = accountSweeper(s, (m) => logs.push(m));
      await setStatus(ann, "blocked", { stopWork: true });
      mkdirSync(`${usersPath()}.tmp`);
      sweep();
      expect(runJson(id).status).toBe("cancelled");
      const later = await waiting(ann, "20260101-000000-bbbb");
      sweep();
      sweep();
      expect(runJson(later).status).toBe("waiting");
      const problems = logs.filter((l) => l.startsWith("!"));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("users.json");
      expect(problems[0]).not.toContain(tmp);
      rmSync(`${usersPath()}.tmp`, { recursive: true });
      sweep();
      expect(getUser(ann)!.stopWork).toBeUndefined();
      expect(runJson(later).status).toBe("waiting");
    });

    it("a restart before the removal handles the request again, once", async () => {
      const id = await waiting(ann, "20260101-000000-aaaa");
      await setStatus(ann, "blocked", { stopWork: true });
      mkdirSync(`${usersPath()}.tmp`);
      accountSweeper(new Scheduler({ runsDir, config: stopped }), () => {})();
      rmSync(`${usersPath()}.tmp`, { recursive: true });
      expect(getUser(ann)!.stopWork).toBeDefined();
      const again = await waiting(ann, "20260101-000000-bbbb");
      accountSweeper(new Scheduler({ runsDir, config: stopped }), () => {})();
      expect(runJson(id).status).toBe("cancelled");
      expect(runJson(again).status).toBe("cancelled");
      expect(getUser(ann)!.stopWork).toBeUndefined();
    });

    it("an unreadable users.json holds the jobs and is logged once", async () => {
      const s = new Scheduler({ runsDir, queueFile, config: () => ConfigSchema.parse({}), accountActive });
      const logs: string[] = [];
      const sweep = accountSweeper(s, (m) => logs.push(m));
      rmSync(usersPath());
      mkdirSync(usersPath());
      const id = s.submit(run(), { source: "ui", owner: ann, queuedBy: ann });
      sweep();
      sweep();
      await new Promise((r) => setTimeout(r, 100));
      expect(s.isQueued(id)).toBe(true);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("users.json");
      expect(logs[0]).not.toContain(tmp);
      expect(accountActive(ann)).toBe(false);
    });

    it("a deleted account's queued job is dropped and logged as deleted", async () => {
      const s = new Scheduler({ runsDir, queueFile, config: stopped });
      const logs: string[] = [];
      const id = s.submit(run(), { source: "ui", owner: ann, queuedBy: ann });
      deleteUser(ann);
      accountSweeper(s, (m) => logs.push(m))();
      expect(s.isQueued(id)).toBe(false);
      expect(logs).toEqual([`account ${ann} deleted: cancelled 1 queued, 0 running, 0 waiting`]);
      expect(adm).toBeDefined();
    });
  });
});

// ---- a running server ---------------------------------------------------------------------------------

interface Srv {
  base: string;
  tmp: string;
  home: string;
  runsDir: string;
  repo: string;
  logs: string[];
  ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  close: () => void;
}

describe("a running server", () => {
  const open: Srv[] = [];
  afterAll(() => {
    for (const s of open) s.close();
  });

  function prepare() {
    const tmp = mkdtempSync(join(tmpdir(), "acct-srv-"));
    const home = join(tmp, "home");
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    process.env.FACTORY_HOME = home;
    return { tmp, home, repo, runsDir: join(tmp, "runs") };
  }

  async function boot(p: ReturnType<typeof prepare>, extra: Partial<ServerOptions> = {}): Promise<Srv> {
    const logs: string[] = [];
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({ repo: p.repo, runsDir: p.runsDir, port, claudeBin, watchers: false, log: (m) => logs.push(m), accountSweepMs: 50, ...extra });
        const s: Srv = { ...p, logs, base: `http://127.0.0.1:${port}`, ctx: started.ctx, close: () => { started.close(); rmSync(p.tmp, { recursive: true, force: true }); } };
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
    return { status: r.status, json: () => JSON.parse(text) };
  };
  const runJson = (s: Srv, id: string) => JSON.parse(readFileSync(join(s.runsDir, id, "run.json"), "utf8"));
  const userCmd = async (sub: string, email: string, values: Record<string, unknown> = {}) => {
    const io: UserIo = { isTTY: false, ask: async () => "", askHidden: async () => "", readStdinLine: async () => undefined, out: () => {} };
    expect(await userCommand({ positionals: [sub, email], values }, io)).toBe(0);
  };

  /** A server with an admin, Ann, Bob and the two flows. */
  async function world(extra: Partial<ServerOptions> = {}) {
    const s = await boot(prepare(), extra);
    const admin = await signInAs(s.base);
    const ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    const bob = await signInAs(s.base, { name: "Bob", email: "bob@example.com", role: "user" });
    for (const [name, yaml] of [["walk", WALKFLOW], ["slow", SLOWFLOW]]) {
      expect((await call(s, admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
    }
    const start = async (who: TestSession, flow: string) => {
      const r = await call(s, who, "POST", "/api/runs", { flow, task: flow });
      expect(r.status).toBe(201);
      return r.json().runId as string;
    };
    const walk = async (who: TestSession) => {
      const id = await start(who, "walk");
      expect((await s.ctx.scheduler.wait(id))?.status).toBe("waiting");
      return id;
    };
    return { s, admin, ann, bob, start, walk };
  }

  it("a plain block drops the queued job, lets the running one finish and leaves the waiting one", async () => {
    const { s, ann, walk, start } = await world();
    const waitingId = await walk(ann);
    const active = await start(ann, "slow");
    const queued = await start(ann, "slow");
    expect(await until(() => s.ctx.scheduler.isActive(active))).toBe(true);
    await userCmd("block", "ann@example.com");
    expect(await until(() => !s.ctx.scheduler.isQueued(queued), 3000)).toBe(true);
    expect(existsSync(join(s.runsDir, queued))).toBe(false);
    await s.ctx.scheduler.wait(active);
    expect(runJson(s, active).status).toBe("succeeded");
    expect(runJson(s, waitingId).status).toBe("waiting");
    const line = s.logs.find((l) => l.includes("blocked: cancelled"));
    expect(line).toBe(`account ${ann.user.id} blocked: cancelled 1 queued, 0 running, 0 waiting`);
    expect(s.logs.join("\n")).not.toMatch(/ann@example\.com|Ann/);
  });

  it("an admin can still approve and reject a blocked account's runs", async () => {
    const { s, admin, ann, walk } = await world();
    const a = await walk(ann);
    const b = await walk(ann);
    await userCmd("block", "ann@example.com");
    expect((await call(s, admin, "POST", `/api/runs/${a}/approve`, {})).status).toBe(202);
    expect((await s.ctx.scheduler.wait(a))?.status).toBe("succeeded");
    expect((await call(s, admin, "POST", `/api/runs/${b}/reject`, {})).status).toBe(202);
    await s.ctx.scheduler.idle();
    expect(runJson(s, b).status).not.toBe("waiting");
  });

  it("--stop-work cancels running and waiting runs, keeps the workspace and spares others", async () => {
    const { s, ann, bob, walk, start } = await world();
    const bobsWaiting = await walk(bob);
    const waitingId = await walk(ann);
    const active = await start(ann, "slow");
    const queued = await start(ann, "slow");
    expect(await until(() => s.ctx.scheduler.isActive(active))).toBe(true);
    const workdir = runJson(s, waitingId).workdir as string | undefined;
    await userCmd("block", "ann@example.com", { "stop-work": true });
    expect(await until(() => s.logs.some((l) => l.includes("stop-work")), 3000)).toBe(true);
    expect(s.logs.find((l) => l.includes("stop-work"))).toBe(`account ${ann.user.id} stop-work: cancelled 1 queued, 1 running, 1 waiting`);
    await s.ctx.scheduler.wait(active);
    expect(runJson(s, active).status).toBe("cancelled");
    expect(existsSync(join(s.runsDir, queued))).toBe(false);
    expect(runJson(s, waitingId).status).toBe("cancelled");
    if (workdir) expect(existsSync(workdir)).toBe(true);
    expect(runJson(s, bobsWaiting).status).toBe("waiting");
    expect(getUser(ann.user.id)!.stopWork).toBeUndefined();
  });

  it("an admin's resume after a stop-work reaches waiting and stays", async () => {
    const { s, admin, ann, walk } = await world();
    const id = await walk(ann);
    await userCmd("block", "ann@example.com", { "stop-work": true });
    expect(await until(() => runJson(s, id).status === "cancelled", 3000)).toBe(true);
    expect((await call(s, admin, "POST", `/api/runs/${id}/resume`, {})).status).toBe(202);
    expect((await s.ctx.scheduler.wait(id))?.status).toBe("waiting");
    await new Promise((r) => setTimeout(r, 300));
    expect(runJson(s, id).status).toBe("waiting");
    expect((await call(s, admin, "POST", `/api/runs/${id}/approve`, {})).status).toBe(202);
    expect((await s.ctx.scheduler.wait(id))?.status).toBe("succeeded");
  });

  it("a block made while the server was down is enforced before any job starts", async () => {
    const p = prepare();
    mkdirSync(p.home, { recursive: true });
    const ann = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD });
    await createUser({ name: "Adm", email: "adm@example.com", password: TEST_PASSWORD, role: "admin" });
    const job = (runId: string, extra: Record<string, unknown>) => ({ runId, job: { kind: "run", flow: parseFlow(PLAIN), task: "", repo: p.repo, vars: {} }, enqueuedAt: new Date().toISOString(), ...extra });
    writeFileSync(join(p.home, "queue.json"), JSON.stringify([
      job("20260101-000000-ann1", { source: "ui", owner: ann.id, queuedBy: ann.id }),
      job("20260101-000000-free", {}),
    ]));
    await setStatus(ann.id, "blocked");
    const s = await boot(p);
    await s.ctx.scheduler.wait("20260101-000000-free");
    await s.ctx.scheduler.idle();
    expect(existsSync(join(s.runsDir, "20260101-000000-ann1"))).toBe(false);
    expect(runJson(s, "20260101-000000-free").status).toBe("succeeded");
    expect(s.logs).toContain(`account ${ann.id} blocked: cancelled 1 queued, 0 running, 0 waiting`);
  });

  it("an unblock removes the request and restarts nothing", async () => {
    const p = prepare();
    mkdirSync(p.home, { recursive: true });
    const ann = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "admin" });
    await createUser({ name: "Adm", email: "adm@example.com", password: TEST_PASSWORD, role: "admin" });
    await setStatus(ann.id, "blocked", { stopWork: true });
    await setStatus(ann.id, "active");
    const s = await boot(p);
    expect(getUser(ann.id)!.stopWork).toBeUndefined();
    expect(s.logs.filter((l) => l.includes("stop-work"))).toEqual([]);
  });
});
