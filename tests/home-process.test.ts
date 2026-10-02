import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { FACTORY_HOME, parseFlow } from "../src/flow/load.js";
import {
  claimRunStart, homeMoved, homePaths, homeRestartReason, migrateDataHome, NOTE_NAME, prepareDataHome, setFactoryHome, watchDataHome,
} from "../src/home.js";
import { acquireLock, lockHolder, lockPath, releaseLock } from "../src/home-migrate.js";
import { StoreError, withAuthLock, writeJsonFile } from "../src/auth/store.js";
import { createUser, setStatus } from "../src/auth/users.js";
import { RESTART_CODE } from "../src/supervise.js";
import { signInAs } from "./helpers/session.js";

let tmp: string;
let oldHome: string;
let newHome: string;
let saved: { HOME?: string; FACTORY_HOME?: string; SCF_HOME?: string; SUP?: string; binding: string };
const quiet = () => {};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const write = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const fakeRun = (status: string, extra: Record<string, unknown> = {}) =>
  write(join(oldHome, "runs", "r1", "run.json"), JSON.stringify({ runId: "r1", status, runDir: join(oldHome, "runs", "r1"), ...extra }));

beforeEach(() => {
  saved = { HOME: process.env.HOME, FACTORY_HOME: process.env.FACTORY_HOME, SCF_HOME: process.env.SCF_HOME, SUP: process.env.FACTORY_SUPERVISED, binding: FACTORY_HOME };
  tmp = mkdtempSync(join(tmpdir(), "home-proc-"));
  process.env.HOME = tmp;
  delete process.env.FACTORY_HOME;
  delete process.env.SCF_HOME;
  ({ oldHome, newHome } = homePaths());
  write(join(oldHome, "config.yaml"), "concurrency: 2\n");
});
afterEach(() => {
  for (const [k, v] of [["HOME", saved.HOME], ["FACTORY_HOME", saved.FACTORY_HOME], ["SCF_HOME", saved.SCF_HOME], ["FACTORY_SUPERVISED", saved.SUP]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setFactoryHome(saved.binding);
  rmSync(tmp, { recursive: true, force: true });
});

describe("prepareDataHome", () => {
  it("uses an explicit home and copies nothing", () => {
    const dir = join(tmp, "elsewhere");
    process.env.FACTORY_HOME = dir;
    expect(prepareDataHome({ log: quiet }).status).toBe("skipped");
    expect(FACTORY_HOME).toBe(dir);
    expect(existsSync(newHome)).toBe(false);
  });

  it("treats an empty SCF_HOME as unset", () => {
    process.env.SCF_HOME = "";
    process.env.FACTORY_HOME = join(tmp, "b");
    prepareDataHome({ log: quiet });
    expect(FACTORY_HOME).toBe(join(tmp, "b"));
    expect(process.env.SCF_HOME).toBeUndefined();
  });

  it("moves the old folder by default, and the binding and CONFIG_PATH follow", () => {
    write(join(oldHome, "config.yaml"), `notify:\n  command: ~/.claude-factory/x\n`);
    const lines: string[] = [];
    const r = prepareDataHome({ log: (m) => lines.push(m) });
    expect(r.status).toBe("migrated");
    expect(FACTORY_HOME).toBe(newHome);
    expect(CONFIG_PATH()).toBe(join(newHome, "config.yaml"));
    expect(readFileSync(join(newHome, "config.yaml"), "utf8")).toContain("~/.spaghetti-code-foundry/x");
    expect(lines.join("\n")).toContain("note: moved the data folder");
    expect(existsSync(join(oldHome, NOTE_NAME))).toBe(true);
  });

  it("keeps the old folder while a run is running", () => {
    fakeRun("running", { pid: process.pid });
    expect(prepareDataHome({ log: quiet }).reason).toBe("running");
    expect(FACTORY_HOME).toBe(oldHome);
  });

  it("throws when a live process holds the lock", () => {
    expect(acquireLock(lockPath(newHome))).toBe(true);
    expect(() => prepareDataHome({ log: quiet, waitMs: 300 })).toThrow(/holds/);
    releaseLock(lockPath(newHome));
  });
});

describe("claimRunStart", () => {
  const runsDir = () => join(oldHome, "runs");

  it("just writes with an explicit home", () => {
    process.env.FACTORY_HOME = tmp;
    let n = 0;
    claimRunStart(runsDir(), () => n++);
    expect(n).toBe(1);
  });

  it("writes on the old folder, and releases the lock", () => {
    setFactoryHome(oldHome);
    let n = 0;
    claimRunStart(runsDir(), () => n++);
    expect(n).toBe(1);
    expect(existsSync(lockPath(newHome))).toBe(false);
  });

  it("refuses after the move and writes nothing", () => {
    setFactoryHome(oldHome);
    mkdirSync(newHome);
    expect(homeMoved()).toBe(newHome);
    let n = 0;
    expect(() => claimRunStart(runsDir(), () => n++)).toThrow(/moved to .*restart scf/);
    expect(n).toBe(0);
    expect(existsSync(lockPath(newHome))).toBe(false);
  });

  it("times out on a live lock holder, and breaks the lock of a dead one", () => {
    setFactoryHome(oldHome);
    const lock = lockPath(newHome);
    expect(acquireLock(lock)).toBe(true);
    expect(() => claimRunStart(runsDir(), () => {}, 300)).toThrow(/another scf process holds/);
    writeFileSync(join(lock, "pid"), String(deadPid()));
    let n = 0;
    claimRunStart(runsDir(), () => n++, 300);
    expect(n).toBe(1);
  });

  it("is not used for a runs folder outside the old data folder", () => {
    setFactoryHome(oldHome);
    mkdirSync(newHome);
    let n = 0;
    claimRunStart(join(tmp, "other", "runs"), () => n++);
    expect(n).toBe(1);
  });

  it("runFlow records its pid, and a refused start leaves no run folder", async () => {
    const flow = parseFlow("name: t\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    const dir = join(tmp, "plain-runs");
    const s = await runFlow(flow, { task: "t", repo: tmp, runsDir: dir });
    expect(s.pid).toBe(process.pid);
    expect(JSON.parse(readFileSync(join(dir, s.runId, "run.json"), "utf8")).pid).toBe(process.pid);
    setFactoryHome(oldHome);
    mkdirSync(newHome);
    await expect(runFlow(flow, { task: "t", repo: tmp, runsDir: join(oldHome, "runs"), runId: "refused" })).rejects.toThrow(/moved to/);
    expect(existsSync(join(oldHome, "runs", "refused"))).toBe(false);
  });
});

describe("homeRestartReason", () => {
  it("is empty with an explicit home or on the new folder", () => {
    setFactoryHome(oldHome);
    process.env.FACTORY_HOME = tmp;
    expect(homeRestartReason()).toBeUndefined();
    delete process.env.FACTORY_HOME;
    setFactoryHome(newHome);
    expect(homeRestartReason()).toBeUndefined();
  });

  it("says the folder moved (new folder, or only the note)", () => {
    setFactoryHome(oldHome);
    mkdirSync(newHome);
    expect(homeRestartReason()).toContain("moved to");
    rmSync(newHome, { recursive: true });
    write(join(oldHome, NOTE_NAME), "x");
    expect(homeRestartReason()).toContain("moved to");
  });

  it("says when a move postponed for a running run can happen now", () => {
    fakeRun("running", { pid: process.pid });
    expect(prepareDataHome({ log: quiet }).reason).toBe("running");
    expect(homeRestartReason()).toBeUndefined();
    fakeRun("succeeded");
    expect(homeRestartReason()).toContain("can move");
  });

  it("for a space problem waits until enough space is free", () => {
    const r = prepareDataHome({ log: quiet, freeBytes: () => 0, sizeBytes: () => 10 });
    expect(r.reason).toBe("space");
    expect(homeRestartReason({ freeBytes: () => r.needBytes! - 1 })).toBeUndefined();
    expect(homeRestartReason({ freeBytes: () => r.needBytes! })).toContain("can move");
  });
});

describe("watchDataHome", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("supervised and idle: exits with RESTART_CODE once a reason appears", async () => {
    process.env.FACTORY_SUPERVISED = "1";
    let reason: string | undefined;
    const exits: number[] = [];
    const logs: string[] = [];
    let before = 0;
    watchDataHome({ idle: () => true, beforeExit: () => before++, log: (m) => logs.push(m), everyMs: 20, reason: () => reason, exit: (c) => exits.push(c) });
    await wait(80);
    expect(exits).toEqual([]);
    reason = "the data folder moved to x";
    await wait(100);
    expect(exits).toEqual([RESTART_CODE]);
    expect(before).toBe(1);
  });

  it("not idle: logs once, does not exit", async () => {
    process.env.FACTORY_SUPERVISED = "1";
    const exits: number[] = [];
    const logs: string[] = [];
    let busy = 0;
    const stop = watchDataHome({ idle: () => false, beforeExit: () => {}, log: (m) => logs.push(m), busy: () => busy++, everyMs: 20, reason: () => "moved", exit: (c) => exits.push(c) });
    await wait(120);
    stop();
    expect(logs).toHaveLength(1);
    expect(busy).toBe(1);
    expect(exits).toEqual([]);
  });

  it("unsupervised: warns once, does not exit", async () => {
    delete process.env.FACTORY_SUPERVISED;
    const exits: number[] = [];
    const logs: string[] = [];
    const stop = watchDataHome({ idle: () => true, beforeExit: () => {}, log: (m) => logs.push(m), everyMs: 20, reason: () => "moved", exit: (c) => exits.push(c) });
    await wait(120);
    stop();
    expect(logs).toEqual(["moved — restart scf to use it"]);
    expect(exits).toEqual([]);
  });
});

describe("account store and the move", () => {
  const ann = { name: "Ann", email: "ann@example.com", password: "test-password-12345" };
  const moveOpts = { from: "", to: "", env: {} as NodeJS.ProcessEnv, freeBytes: () => 1e15, sizeBytes: () => 1000, log: quiet };

  it("writes on the old folder and releases both locks", async () => {
    setFactoryHome(oldHome);
    await createUser(ann);
    expect(existsSync(join(oldHome, "users.json"))).toBe(true);
    expect(existsSync(lockPath(newHome))).toBe(false);
    expect(existsSync(join(oldHome, "auth.lock"))).toBe(false);
  });

  it("holds the move lock between the check and the write", async () => {
    setFactoryHome(oldHome);
    await createUser(ann);
    withAuthLock(() => {
      expect(lockHolder(lockPath(newHome))).toBe(process.pid);
      const r = migrateDataHome({ ...moveOpts, from: oldHome, to: newHome, lockWaitMs: 100 });
      expect(r.status).toBe("postponed");
      expect(r.reason).toBe("busy");
      expect(existsSync(newHome)).toBe(false);
      writeJsonFile(join(oldHome, "users.json"), { version: 1, users: [] });
    });
    const r = migrateDataHome({ ...moveOpts, from: oldHome, to: newHome });
    expect(r.status).toBe("migrated");
    expect(JSON.parse(readFileSync(join(newHome, "users.json"), "utf8"))).toEqual({ version: 1, users: [] });
  });

  it("refuses after the move and changes nothing", async () => {
    setFactoryHome(oldHome);
    const u = await createUser(ann);
    const before = readFileSync(join(oldHome, "users.json"));
    mkdirSync(newHome);
    await expect(createUser({ ...ann, email: "b@example.com" })).rejects.toMatchObject({ kind: "cannot-write", message: expect.stringContaining("moved to") });
    await expect(setStatus(u.id, "blocked")).rejects.toBeInstanceOf(StoreError);
    expect(readFileSync(join(oldHome, "users.json"))).toEqual(before);
    expect(existsSync(join(oldHome, "auth.lock"))).toBe(false);
    expect(existsSync(lockPath(newHome))).toBe(false);
  });

  it("reports a busy move lock", () => {
    setFactoryHome(oldHome);
    acquireLock(lockPath(newHome));
    try {
      expect(() => withAuthLock(() => 1, 150)).toThrow(expect.objectContaining({ kind: "locked", message: expect.stringContaining(lockPath(newHome)) }));
      expect(existsSync(join(oldHome, "auth.lock"))).toBe(false);
    } finally {
      releaseLock(lockPath(newHome));
    }
  });

  it("takes no move lock with an explicit home", () => {
    process.env.FACTORY_HOME = join(tmp, "explicit");
    withAuthLock(() => expect(existsSync(lockPath(newHome))).toBe(false));
  });
});

describe("server on a moved folder", () => {
  it("refuses changes with 503 but still answers reads", async () => {
    fakeRun("running", { pid: process.pid });
    expect(prepareDataHome({ log: quiet }).home).toBe(oldHome);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { startServer } = await import("../src/server/server.js");
    const base = `http://127.0.0.1:${port}`;
    const { close } = await startServer({ repo: tmp, runsDir: join(oldHome, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    try {
      const pw = "test-password-12345";
      const s = await signInAs(base, { email: "ann@example.com", password: pw });
      fakeRun("succeeded");
      expect(migrateDataHome({ from: oldHome, to: newHome, env: {}, freeBytes: () => 1e15, sizeBytes: () => 1 }).status).toBe("migrated");
      const before = readFileSync(join(oldHome, "config.yaml"), "utf8");
      const putOpts = (headers: Record<string, string>) => ({ method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ concurrency: 5 }) });
      // without a session nothing is answered, and no folder path
      expect((await fetch(`${base}/api/config`, putOpts({}))).status).toBe(401);
      const noSession = await fetch(`${base}/api/config`);
      expect(noSession.status).toBe(401);
      const bodies: string[] = [await noSession.text()];
      const put = await fetch(`${base}/api/config`, putOpts(s.headers("PUT")));
      expect(put.status).toBe(503); // a signed-in user is told where the folder went
      expect(readFileSync(join(oldHome, "config.yaml"), "utf8")).toBe(before);
      expect((await fetch(`${base}/api/config`, { headers: s.headers() })).status).toBe(200);
      // the public changes answer 503 too, without the path
      const post = (path: string, body: unknown) =>
        fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const signIn = await post("/api/session", { email: "ann@example.com", password: pw });
      const setup = await post("/api/setup", { name: "B", email: "b@example.com", password: pw });
      expect([signIn.status, setup.status]).toEqual([503, 503]);
      bodies.push(await signIn.text(), await setup.text());
      // sign-out is refused as well: no cookie change, and the session still works
      for (const headers of [s.headers("DELETE"), {}]) {
        const out = await fetch(`${base}/api/session`, { method: "DELETE", headers });
        expect(out.status).toBe(503);
        expect(out.headers.get("set-cookie")).toBeNull();
        bodies.push(await out.text());
      }
      expect((await fetch(`${base}/api/config`, { headers: s.headers() })).status).toBe(200);
      for (const b of bodies) expect(b).not.toContain(newHome);
    } finally {
      close();
    }
  });
});
