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
import { acquireLock, lockPath, releaseLock } from "../src/home-migrate.js";
import { RESTART_CODE } from "../src/supervise.js";

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
    const stop = watchDataHome({ idle: () => false, beforeExit: () => {}, log: (m) => logs.push(m), everyMs: 20, reason: () => "moved", exit: (c) => exits.push(c) });
    await wait(120);
    stop();
    expect(logs).toHaveLength(1);
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

describe("server on a moved folder", () => {
  it("refuses changes with 503 but still answers reads", async () => {
    fakeRun("running", { pid: process.pid });
    expect(prepareDataHome({ log: quiet }).home).toBe(oldHome);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { startServer } = await import("../src/server/server.js");
    const { close } = await startServer({ repo: tmp, runsDir: join(oldHome, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    try {
      fakeRun("succeeded");
      expect(migrateDataHome({ from: oldHome, to: newHome, env: {}, freeBytes: () => 1e15, sizeBytes: () => 1 }).status).toBe("migrated");
      const before = readFileSync(join(oldHome, "config.yaml"), "utf8");
      const put = await fetch(`http://127.0.0.1:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ concurrency: 5 }) });
      expect(put.status).toBe(503);
      expect(readFileSync(join(oldHome, "config.yaml"), "utf8")).toBe(before);
      expect((await fetch(`http://127.0.0.1:${port}/api/config`)).status).toBe(200);
    } finally {
      close();
    }
  });
});
