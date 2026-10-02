import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { userCommand, type UserIo } from "../src/auth/cli.js";
import { createUser } from "../src/auth/users.js";
import { parseFlow } from "../src/flow/load.js";
import { RULES, ruleKey } from "../src/server/permissions.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD, signInAs, type TestSession } from "./helpers/session.js";

/* A server for each describe on its own data folder: FACTORY_HOME is set while it runs. */
interface Srv {
  base: string;
  tmp: string;
  home: string;
  runsDir: string;
  repo: string;
  ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  close: () => void;
}

const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
const open: Srv[] = [];

beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  for (const s of open) s.close();
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

const WALK = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const SLOW = `name: slow
workspace: empty
one_per_repo: true
publish:
  enabled: true
steps:
  - {id: a, type: shell, run: "sleep 2"}
`;

/** Home and repo are made first, so the caller can put files in them before the server starts. */
function prepare() {
  const tmp = mkdtempSync(join(tmpdir(), "run-own-"));
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
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const started = await startServer({ repo: p.repo, runsDir: p.runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {}, ...extra });
      const s: Srv = {
        ...p,
        base: `http://127.0.0.1:${port}`,
        ctx: started.ctx,
        close: () => {
          started.close();
          rmSync(p.tmp, { recursive: true, force: true });
        },
      };
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

/** A stream call: the status, the type and what arrives in the first moments (the stream is then closed). */
async function stream(s: Srv, who: TestSession, path: string, ms = 300) {
  const ctl = new AbortController();
  const r = await fetch(s.base + path, { headers: who.headers(), signal: ctl.signal });
  let text = "";
  if (r.status !== 200) text = await r.text();
  else {
    const reader = r.body!.getReader();
    const end = Date.now() + ms;
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      while (Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {
      // aborted
    }
    clearTimeout(timer);
  }
  ctl.abort();
  return { status: r.status, type: r.headers.get("content-type") ?? "", text };
}

const runJson = (s: Srv, id: string) => JSON.parse(readFileSync(join(s.runsDir, id, "run.json"), "utf8"));
const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return fn();
};
const saveFlow = async (s: Srv, admin: TestSession, name: string, yaml: string) => expect((await call(s, admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
const writeRun = (s: Srv, id: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(s.runsDir, id), { recursive: true });
  writeFileSync(join(s.runsDir, id, "run.json"), JSON.stringify({
    runId: id, flow: "old", task: "", vars: {}, repo: s.repo, status: "succeeded", runDir: join(s.runsDir, id),
    startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...extra,
  }));
};
const ownerRows = (ls: { runId: string; ownerName?: string }[]) => Object.fromEntries(ls.map((r) => [r.runId, r.ownerName]));

describe("runs of other accounts", () => {
  let s: Srv;
  let admin: TestSession;
  let ann: TestSession;
  let bob: TestSession;
  const startRun = async (who: TestSession, flow = "walk") => {
    const r = await call(s, who, "POST", "/api/runs", { flow, task: flow });
    expect(r.status).toBe(201);
    return r.json().runId as string;
  };
  const waitingRun = async (who: TestSession) => {
    const id = await startRun(who);
    expect((await s.ctx.scheduler.wait(id))?.status).toBe("waiting");
    return id;
  };

  beforeAll(async () => {
    s = await boot(prepare());
    admin = await signInAs(s.base);
    ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    bob = await signInAs(s.base, { name: "Bob", email: "bob@example.com", role: "user" });
    await saveFlow(s, admin, "walk", WALK);
    await saveFlow(s, admin, "slow", SLOW);
  });
  afterEach(() => {
    for (const q of [...s.ctx.scheduler.queue().pending, ...s.ctx.scheduler.queue().active]) s.ctx.scheduler.cancel(q.runId);
  });

  const own = RULES.filter((r) => r.path.startsWith("runs/:id"));
  const pathFor = (rule: (typeof own)[number], id: string) => `/api/${rule.path.replace(":id", id).replace(":n", "0")}`;
  const ask = async (who: TestSession, rule: (typeof own)[number], id: string) => {
    if (rule.path.endsWith("/events")) return stream(s, who, pathFor(rule, id), 100);
    const r = await call(s, who, rule.method, pathFor(rule, id), rule.method === "POST" ? {} : undefined);
    return { status: r.status, type: "application/json", text: r.text };
  };

  it("answers 404 to another account on every run route, like for an unknown run, and changes nothing", async () => {
    const annRun = await waitingRun(ann);
    const noOwner = "noowner-run";
    writeRun(s, noOwner, { status: "waiting" });
    const { owner: _o, ...bare } = runJson(s, noOwner);
    writeFileSync(join(s.runsDir, noOwner, "run.json"), JSON.stringify(bare));
    const broken = "broken-run";
    mkdirSync(join(s.runsDir, broken));
    writeFileSync(join(s.runsDir, broken, "run.json"), "{ not json");
    const before = readFileSync(join(s.runsDir, annRun, "run.json"), "utf8");
    expect(own.length).toBeGreaterThanOrEqual(8);
    for (const rule of own) {
      const key = ruleKey(rule);
      const unknown = await ask(bob, rule, "unknown-run");
      expect(unknown.status, key).toBe(404);
      const answers = await Promise.all([annRun, noOwner, broken].map((id) => ask(bob, rule, id)));
      for (const a of answers) {
        expect(a.status, key).toBe(404);
        expect(a.text, key).toBe(unknown.text);
        expect(a.type, key).toContain("application/json");
      }
    }
    expect(readFileSync(join(s.runsDir, annRun, "run.json"), "utf8")).toBe(before);
    expect(runJson(s, annRun).status).toBe("waiting");
  });

  it("lets the owner and the admin through", async () => {
    for (const rule of own) {
      const mine = await waitingRun(ann);
      const r = await ask(ann, rule, mine);
      expect(r.status, ruleKey(rule)).toBeLessThan(300);
      await s.ctx.scheduler.idle();
    }
    const id = await waitingRun(ann);
    expect((await call(s, admin, "GET", `/api/runs/${id}`)).status).toBe(200);
  });

  it("does not let another account retry a run", async () => {
    const id = await waitingRun(ann);
    const before = readFileSync(join(s.runsDir, id, "run.json"), "utf8");
    const r = await call(s, bob, "POST", `/api/runs/${id}/resume`, { from: "say" });
    expect(r.status).toBe(404);
    expect(s.ctx.scheduler.isQueued(id) || s.ctx.scheduler.isActive(id)).toBe(false);
    expect(readFileSync(join(s.runsDir, id, "run.json"), "utf8")).toBe(before);
  });

  it("lists only the account's own runs", async () => {
    const id = await waitingRun(ann);
    const ids = async (who: TestSession) => (await call(s, who, "GET", "/api/runs")).json().map((r: { runId: string }) => r.runId);
    expect(await ids(ann)).toContain(id);
    expect(await ids(bob)).not.toContain(id);
  });

  it("shows a user their own queue and how many runs are ahead, and nothing of the others", async () => {
    const a1 = await startRun(ann, "slow");
    const b1 = await startRun(bob, "slow");
    const a2 = await startRun(ann, "slow");
    expect(s.ctx.scheduler.isActive(a1)).toBe(true);

    const annQ = await call(s, ann, "GET", "/api/queue");
    expect(annQ.text).not.toContain(b1);
    const aq = annQ.json();
    expect(aq.pending.map((p: { runId: string }) => p.runId)).toEqual([a2]);
    expect(aq.pending[0].ahead).toBe(1);
    expect(aq.active.map((a: { runId: string }) => a.runId)).toEqual([a1]);

    const bobQ = await call(s, bob, "GET", "/api/queue");
    expect(bobQ.text).not.toContain(a1);
    expect(bobQ.text).not.toContain(a2);
    const bq = bobQ.json();
    expect(bq.pending.map((p: { runId: string }) => p.runId)).toEqual([b1]);
    expect(bq.pending[0].ahead).toBe(0);
    expect(bq.pending[0].next.afterRun).toBeUndefined();
    expect(bq.pending[0].next.where.url).toBe("#/runs");
    expect(bq.active).toEqual([]);

    const adminQ = (await call(s, admin, "GET", "/api/queue")).json();
    expect(adminQ.pending.map((p: { runId: string }) => p.runId)).toEqual([b1, a2]);
    expect(adminQ.pending[0].next.where.url).toBe(`#/runs/${a1}`);

    const cy = await signInAs(s.base, { name: "Cy", email: "cy@example.com", role: "user" });
    expect((await call(s, cy, "GET", "/api/queue")).json()).toEqual({ pending: [], active: [], concurrency: s.ctx.config().concurrency });

    // Bob's run starts once Ann's first one is gone: its page and its stream do not name Ann's runs.
    s.ctx.scheduler.cancel(a1);
    expect(await until(() => s.ctx.scheduler.isActive(b1))).toBe(true);
    const detail = await call(s, bob, "GET", `/api/runs/${b1}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain(a1);
    expect(detail.text).not.toContain(a2);
    const ev = await stream(s, bob, `/api/runs/${b1}/events`);
    expect(ev.status).toBe(200);
    expect(ev.text).not.toContain(a1);
    expect(ev.text).not.toContain(a2);
  });

  it("does not show a user the id of another account's run in a code-area wait", async () => {
    const bobRun = await waitingRun(bob);
    const id = "20260101-000000-area";
    writeRun(s, id, {
      owner: ann.user.id, status: "waiting", waiting: { stepId: "g", message: "m", since: "2026-01-01T00:00:00.000Z" },
      history: [{ id: "claim_areas", type: "shell", visit: 1, ok: true, output: `waiting for run ${bobRun} (src)`, startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logFile: join(s.runsDir, id, "logs", "0.log") }],
    });
    for (const path of ["/api/runs", `/api/runs/${id}`]) {
      const own = await call(s, ann, "GET", path);
      expect(own.status).toBe(200);
      expect(own.text, path).not.toContain(bobRun);
      expect(own.text, path).toContain("waiting for another run");
    }
    const ev = await stream(s, ann, `/api/runs/${id}/events`);
    expect(ev.text).not.toContain(bobRun);
    expect((await call(s, admin, "GET", `/api/runs/${id}`)).text).toContain(bobRun);
  });

  it("does not give a user another account's run through a run.json that claims its id", async () => {
    const bobRun = await waitingRun(bob);
    const forged = "20260101-000000-forg";
    writeRun(s, forged, { ...runJson(s, bobRun), runId: bobRun });
    // the forged file says it belongs to Ann, but its runId is Bob's
    const file = join(s.runsDir, forged, "run.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), owner: ann.user.id }));
    for (const who of [ann, bob]) {
      const ids = (await call(s, who, "GET", "/api/runs")).json().map((r: { runId: string }) => r.runId);
      expect(ids.filter((i: string) => i === bobRun)).toHaveLength(who === bob ? 1 : 0);
    }
  });

  it("gives an admin every run with its owner, and a filter", async () => {
    const annRun = await waitingRun(ann);
    const bobRun = await waitingRun(bob);
    const adminRun = await waitingRun(admin);
    writeRun(s, "20200101-000000-ghost", { owner: "11111111-1111-4111-8111-111111111111" });
    const list = (await call(s, admin, "GET", "/api/runs")).json();
    const rows = ownerRows(list);
    expect(rows[annRun]).toBe("Ann");
    expect(rows[bobRun]).toBe("Bob");
    expect(rows[adminRun]).toBe("Test Admin");
    expect(rows["20200101-000000-ghost"]).toBe("deleted account");

    const only = (await call(s, admin, "GET", `/api/runs?owner=${ann.user.id}`)).json();
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r: { owner: string }) => r.owner === ann.user.id)).toBe(true);
    expect(only.map((r: { runId: string }) => r.runId)).toContain(annRun);
    expect((await call(s, admin, "GET", "/api/runs?owner=00000000-0000-4000-8000-000000000000")).json()).toEqual([]);
    expect((await call(s, admin, "GET", "/api/runs?owner=a/b")).status).toBe(400);
    expect((await call(s, admin, "GET", `/api/runs?owner=${"x".repeat(65)}`)).status).toBe(400);

    const mine = (await call(s, ann, "GET", `/api/runs?owner=${bob.user.id}`)).json();
    expect(mine.map((r: { runId: string }) => r.runId)).toContain(annRun);
    expect(mine.map((r: { runId: string }) => r.runId)).not.toContain(bobRun);
    expect(mine.every((r: { ownerName?: string }) => !("ownerName" in r))).toBe(true);
    await s.ctx.scheduler.idle();
  });
});

describe("the owner options", () => {
  it("count over every run, not only the newest 200", async () => {
    const s = await boot(prepare());
    const admin = await signInAs(s.base);
    const ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    const bob = await signInAs(s.base, { name: "Bob", email: "bob@example.com", role: "user" });
    const bobRun = "20200101-000000-bbbb";
    writeRun(s, bobRun, { owner: bob.user.id });
    writeRun(s, "20200101-000001-gone", { owner: "11111111-1111-4111-8111-111111111111" });
    for (let i = 0; i < 200; i++) writeRun(s, `20200102-${String(i).padStart(6, "0")}-aaaa`, { owner: ann.user.id });

    const list = (await call(s, admin, "GET", "/api/runs")).json();
    expect(list).toHaveLength(200);
    expect(list.map((r: { runId: string }) => r.runId)).not.toContain(bobRun);
    const owners = (await call(s, admin, "GET", "/api/run-owners")).json();
    expect(owners).toEqual([
      { id: ann.user.id, name: "Ann", runs: 200 },
      { id: bob.user.id, name: "Bob", runs: 1 },
      { id: "11111111-1111-4111-8111-111111111111", name: "deleted account", runs: 1 },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    const bobs = (await call(s, admin, "GET", `/api/runs?owner=${bob.user.id}`)).json();
    expect(bobs.map((r: { runId: string }) => r.runId)).toEqual([bobRun]);
    expect((await call(s, ann, "GET", "/api/run-owners")).status).toBe(403);
  });
});

describe("the owner of a watcher in the config", () => {
  it("must be an account when new or changed; an old unknown one can stay", async () => {
    const p = prepare();
    mkdirSync(p.home, { recursive: true });
    writeFileSync(join(p.home, "config.yaml"), "watchers:\n  - id: old\n    github_repo: a/b\n    owner: gone@example.com\n");
    const s = await boot(p);
    const admin = await signInAs(s.base);
    await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    const file = join(p.home, "config.yaml");
    const text = readFileSync(file, "utf8");
    const watcher = (id: string, owner: string) => ({ id, github_repo: "a/b", owner });

    const bad = await call(s, admin, "PUT", "/api/config", { watchers: [watcher("new", "nobody@example.com")] });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("new");
    expect(readFileSync(file, "utf8")).toBe(text);
    const changed = await call(s, admin, "PUT", "/api/config", { watchers: [watcher("old", "other@example.com")] });
    expect(changed.status).toBe(400);

    expect((await call(s, admin, "PUT", "/api/config", { watchers: [watcher("w", "ann@example.com")] })).status).toBe(200);
    // the saved one stays valid when another setting changes
    expect((await call(s, admin, "PUT", "/api/config", { concurrency: 3, watchers: [watcher("w", "ann@example.com")] })).status).toBe(200);
  });

  it("keeps a watcher whose unknown owner was saved before, when another setting changes", async () => {
    const p = prepare();
    mkdirSync(p.home, { recursive: true });
    writeFileSync(join(p.home, "config.yaml"), "watchers:\n  - id: old\n    github_repo: a/b\n    owner: gone@example.com\n");
    const s = await boot(p);
    const admin = await signInAs(s.base);
    const r = await call(s, admin, "PUT", "/api/config", { concurrency: 3, watchers: [{ id: "old", github_repo: "a/b", owner: "gone@example.com" }] });
    expect(r.status).toBe(200);
  });
});

describe("runs of older versions", () => {
  it("go to the first admin at start, with the file time kept", async () => {
    const p = prepare();
    mkdirSync(p.home, { recursive: true });
    const admin = await createUser({ name: "Test Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
    const s0 = { runsDir: p.runsDir, repo: p.repo } as Srv;
    writeRun(s0, "20260101-000000-aaaa");
    writeRun(s0, "20260101-000001-bbbb", { status: "running", pid: 2 ** 22 + 12345 });
    const past = new Date("2026-01-05T10:00:00.000Z");
    const file = (id: string) => join(p.runsDir, id, "run.json");
    utimesSync(file("20260101-000001-bbbb"), past, past);
    const s = await boot(p);
    expect(runJson(s, "20260101-000000-aaaa").owner).toBe(admin.id);
    expect(runJson(s, "20260101-000001-bbbb").owner).toBe(admin.id);
    expect(statSync(file("20260101-000001-bbbb")).mtime.toISOString()).toBe(past.toISOString());
    const who = await signInAs(s.base);
    const list = (await call(s, who, "GET", "/api/runs")).json();
    expect(list.map((r: { ownerName: string }) => r.ownerName)).toEqual(["Test Admin", "Test Admin"]);
    expect(list.find((r: { runId: string }) => r.runId === "20260101-000001-bbbb").finishedAt).toBe(past.toISOString());
  });

  it("go to the admin made on the setup page", async () => {
    const p = prepare();
    const s = await boot(p);
    writeRun(s, "20260101-000000-aaaa");
    expect(runJson(s, "20260101-000000-aaaa").owner).toBeUndefined();
    const r = await fetch(s.base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD }) });
    expect(r.status).toBe(201);
    const { user } = (await r.json()) as { user: { id: string } };
    expect(runJson(s, "20260101-000000-aaaa").owner).toBe(user.id);
  });

  it("go to an admin made with the command line while the server runs", async () => {
    const p = prepare();
    const s = await boot(p, { adoptEveryMs: 50 });
    writeRun(s, "20260101-000000-aaaa");
    const answers = ["Ann", "ann@example.com"];
    const hidden = [TEST_PASSWORD, TEST_PASSWORD];
    const io: UserIo = { isTTY: true, ask: async () => answers.shift()!, askHidden: async () => hidden.shift()!, readStdinLine: async () => undefined, out: () => {} };
    expect(await userCommand({ positionals: ["create"], values: { admin: true } }, io)).toBe(0);
    expect(await until(() => !!runJson(s, "20260101-000000-aaaa").owner, 2000)).toBe(true);
  });

  it("are given to the admin after a run that was live has ended", async () => {
    const p = prepare();
    mkdirSync(p.home, { recursive: true });
    const flow = parseFlow("name: sleepy\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: 'sleep 1'}\n");
    writeFileSync(join(p.home, "queue.json"), JSON.stringify([{ runId: "20260101-000000-live", job: { kind: "run", flow, task: "", repo: p.repo, vars: {} }, enqueuedAt: new Date().toISOString() }]));
    const s = await boot(p, { adoptEveryMs: 50 });
    expect(await until(() => existsSync(join(p.runsDir, "20260101-000000-live", "run.json")))).toBe(true);
    const r = await fetch(s.base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD }) });
    expect(r.status).toBe(201);
    const { user } = (await r.json()) as { user: { id: string } };
    expect(s.ctx.scheduler.isActive("20260101-000000-live")).toBe(true);
    expect(runJson(s, "20260101-000000-live").owner).toBeUndefined();
    await s.ctx.scheduler.idle();
    expect(await until(() => runJson(s, "20260101-000000-live").owner === user.id, 3000)).toBe(true);
    const done = runJson(s, "20260101-000000-live");
    expect(done.status).toBe("succeeded");
    expect(done.history.map((h: { id: string }) => h.id)).toEqual(["a"]);
  });
});
