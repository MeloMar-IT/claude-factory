import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultHome, MARKER_NAME, migrateDataHome, NOTE_NAME, type MigrateOptions } from "../src/home.js";
import { acquireLock, explicitHome, lockHolder, lockPath, releaseLock, replacePath, runningRuns, snapshot } from "../src/home-migrate.js";

let tmp: string;
let from: string;
let to: string;
const env = {} as NodeJS.ProcessEnv;
const isRoot = process.getuid?.() === 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "home-test-"));
  from = join(tmp, ".claude-factory");
  to = join(tmp, ".spaghetti-code-foundry");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const write = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const runJson = (id: string, over: Record<string, unknown> = {}) => {
  const runDir = join(from, "runs", id);
  write(join(runDir, "run.json"), JSON.stringify({ runId: id, status: "succeeded", runDir, ...over }, null, 2));
  return runDir;
};

function makeOld() {
  write(join(from, "config.yaml"), "watchers:\n  - id: w\n    github_repo: acme/app\n");
  write(join(from, "flows", "mine.yaml"), "name: mine\n");
  write(join(from, "learnings", "acme__app.md"), "learned\n");
  write(join(from, "queue.json"), "[]");
  symlinkSync("mine.yaml", join(from, "flows", "link.yaml"));
  symlinkSync("nowhere", join(from, "flows", "dangling.yaml"));
  runJson("r1");
}

const migrate = (o: Partial<MigrateOptions> = {}) =>
  migrateDataHome({ from, to, env, freeBytes: () => 1e15, sizeBytes: () => 1000, ...o });
const leftovers = () => readdirSync(tmp).filter((n) => n.includes(".migrating-"));

describe("home helpers", () => {
  it("explicitHome: SCF_HOME wins and empty counts as unset", () => {
    expect(explicitHome({ SCF_HOME: "/a", FACTORY_HOME: "/b" })).toBe("/a");
    expect(explicitHome({ SCF_HOME: "", FACTORY_HOME: "/b" })).toBe("/b");
    expect(explicitHome({ SCF_HOME: "", FACTORY_HOME: "" })).toBeUndefined();
  });

  it("defaultHome picks the old folder only while it is the only one and not moved", () => {
    const saved = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const nw = join(tmp, ".spaghetti-code-foundry");
      expect(defaultHome()).toBe(nw);
      mkdirSync(from);
      expect(defaultHome()).toBe(from);
      writeFileSync(join(from, NOTE_NAME), "x");
      expect(defaultHome()).toBe(nw);
      rmSync(join(from, NOTE_NAME));
      mkdirSync(nw);
      expect(defaultHome()).toBe(nw);
    } finally {
      process.env.HOME = saved;
    }
  });

  it("replacePath leaves longer names alone", () => {
    expect(replacePath("/h/.cf/x /h/.cf-x /h/.cf.bak /h/.cf", "/h/.cf", "/h/.new")).toBe("/h/.new/x /h/.cf-x /h/.cf.bak /h/.new");
  });

  it("locks: a dead pid is broken, a live one is not", () => {
    const lock = lockPath(to);
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(deadPid()));
    expect(lockHolder(lock)).toBeUndefined();
    expect(acquireLock(lock, 300)).toBe(true);
    expect(lockHolder(lock)).toBe(process.pid);
    expect(acquireLock(lock, 300)).toBe(false);
    releaseLock(lock);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("runningRuns", () => {
  const old = new Date(Date.now() - 4 * 3600_000);
  it("blocks a running run without pid, even when its files are old", () => {
    const d = runJson("a", { status: "running" });
    utimesSync(join(d, "run.json"), old, old);
    const r = runningRuns(join(from, "runs"));
    expect(r.map((x) => x.id)).toEqual(["a"]);
  });
  it("a dead pid does not block; this process does", () => {
    runJson("dead", { status: "running", pid: deadPid() });
    expect(runningRuns(join(from, "runs"))).toEqual([]);
    runJson("live", { status: "running", pid: process.pid });
    expect(runningRuns(join(from, "runs")).map((x) => x.id)).toEqual(["live"]);
  });
  it("blocks on a truncated run.json, a missing one and an unreadable one", () => {
    write(join(from, "runs", "trunc", "run.json"), '{"status": "run');
    mkdirSync(join(from, "runs", "empty"));
    const ids = () => runningRuns(join(from, "runs")).map((x) => x.id).sort();
    expect(ids()).toEqual(["empty", "trunc"]);
    if (!isRoot) {
      const d = runJson("locked");
      chmodSync(join(d, "run.json"), 0);
      expect(ids()).toContain("locked");
    }
  });
  it("never blocks on waiting runs", () => {
    runJson("w", { status: "waiting" });
    expect(runningRuns(join(from, "runs"))).toEqual([]);
  });
});

describe("migrateDataHome", () => {
  it("moves everything, keeps the old folder and leaves no temp folder", () => {
    makeOld();
    const before = snapshot(from);
    const r = migrate();
    expect(r.status).toBe("migrated");
    expect(r.home).toBe(to);
    expect(readdirSync(to).sort()).toEqual([MARKER_NAME, "config.yaml", "flows", "learnings", "queue.json", "runs"]);
    expect(readlinkSync(join(to, "flows", "link.yaml"))).toBe("mine.yaml");
    expect(lstatSync(join(to, "flows", "dangling.yaml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(to, "learnings", "acme__app.md"), "utf8")).toBe("learned\n");
    expect(loadConfig(join(to, "config.yaml")).watchers).toHaveLength(1);
    const marker = JSON.parse(readFileSync(join(to, MARKER_NAME), "utf8"));
    expect(marker).toMatchObject({ from, state: "done" });
    const note = readFileSync(join(from, NOTE_NAME), "utf8");
    expect(note).toContain(to);
    expect(note).toContain("scf service install");
    const after = snapshot(from);
    after.delete(NOTE_NAME);
    expect([...after]).toEqual([...before]);
    expect(leftovers()).toEqual([]);
  });

  it("is skipped when a home is set explicitly, and never overwrites an existing new folder", () => {
    makeOld();
    expect(migrate({ env: { FACTORY_HOME: "/x" } }).status).toBe("skipped");
    expect(existsSync(to)).toBe(false);
    write(join(to, "mine.txt"), "mine");
    expect(migrate().status).toBe("skipped");
    expect(readdirSync(to)).toEqual(["mine.txt"]);
    expect(existsSync(join(from, NOTE_NAME))).toBe(false);
  });

  it("is skipped without an old folder", () => {
    expect(migrate().status).toBe("skipped");
    expect(existsSync(to)).toBe(false);
  });

  it("postpones while a run is running, naming it and `scf resume`", () => {
    makeOld();
    runJson("busy1", { status: "running" });
    const r = migrate({ copy: () => { throw new Error("must not copy"); } });
    expect(r).toMatchObject({ status: "postponed", reason: "running", home: from });
    expect(r.message).toContain("busy1");
    expect(r.message).toContain("scf resume");
    expect(existsSync(to)).toBe(false);
  });

  it.each([
    ["a new run", () => runJson("new1")],
    ["a rewritten run.json", () => write(join(from, "runs", "r1", "run.json"), '{"status":"succeeded","x":1}')],
    ["an empty run folder", () => mkdirSync(join(from, "runs", "empty"))],
    ["an edited config.yaml", () => write(join(from, "config.yaml"), "concurrency: 3\n")],
  ])("goes busy when %s appears during the copy", (_n, change) => {
    makeOld();
    const before = snapshot(from);
    const r = migrate({ copy: (f, t) => { change(); migrateCopy(f, t); } });
    expect(r).toMatchObject({ status: "postponed", reason: "busy" });
    expect(existsSync(to)).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(from, NOTE_NAME))).toBe(false);
    expect(snapshot(from).size).toBeGreaterThanOrEqual(before.size);
  });

  it("a failed copy changes nothing, also with a read-only folder in the temp folder", () => {
    makeOld();
    const before = snapshot(from);
    expect(migrate({ copy: () => { throw new Error("disk on fire"); } })).toMatchObject({ status: "failed", home: from });
    expect(existsSync(to)).toBe(false);
    expect(leftovers()).toEqual([]);
    const r = migrate({
      copy: (_f, t) => {
        mkdirSync(join(t, "ro", "deep"), { recursive: true });
        writeFileSync(join(t, "ro", "deep", "f"), "x");
        if (!isRoot) chmodSync(join(t, "ro"), 0o500);
        throw new Error("boom");
      },
    });
    expect(r.status).toBe("failed");
    expect(leftovers()).toEqual([]);
    expect(snapshot(from)).toEqual(before);
  });

  it("lost race: a new folder that appears during the copy is kept", () => {
    makeOld();
    const r = migrate({ copy: (f, t) => { migrateCopy(f, t); mkdirSync(to); write(join(to, "theirs"), "1"); } });
    expect(r.status).toBe("skipped");
    expect(readdirSync(to)).toEqual(["theirs"]);
    expect(leftovers()).toEqual([]);
  });

  it("lost race: an empty folder or a dangling symlink that appears during the copy is kept", () => {
    makeOld();
    const r = migrate({ copy: (f, t) => { migrateCopy(f, t); mkdirSync(to); } });
    expect(r.status).toBe("skipped");
    expect(readdirSync(to)).toEqual([]);
    expect(leftovers()).toEqual([]);
    rmSync(to, { recursive: true });
    const r2 = migrate({ copy: (f, t) => { migrateCopy(f, t); symlinkSync("nowhere", to); } });
    expect(r2.status).toBe("skipped");
    expect(lstatSync(to).isSymbolicLink()).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("a concurrent migration that finishes during our copy wins: we use its folder", () => {
    makeOld();
    // (the nested call shares our pid, so it reuses our temp folder name: make our temp folder again, as a real second process would have its own)
    const r = migrate({ copy: (_f, t) => { expect(migrate().status).toBe("migrated"); mkdirSync(t); } });
    expect(r).toMatchObject({ status: "skipped", home: to });
    expect(existsSync(join(to, "config.yaml"))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("never writes through an absolute config.yaml symlink into the old folder", () => {
    makeOld();
    const real = join(from, "real.yaml");
    const cfg = `notify:\n  command: ${from}/notify.sh\n`;
    write(real, cfg);
    rmSync(join(from, "config.yaml"));
    symlinkSync(real, join(from, "config.yaml"));
    const r = migrate({ checkConfig: () => {} });
    expect(r.status).toBe("migrated");
    expect(readFileSync(real, "utf8")).toBe(cfg);
    expect(r.warnings.join("\n")).toContain("notify.command");
  });

  it("removes a stale staging folder of a dead process, even without a marker", () => {
    makeOld();
    const stale = join(tmp, `.spaghetti-code-foundry.staging-${deadPid()}`);
    write(join(stale, "half"), "x");
    expect(migrate().status).toBe("migrated");
    expect(existsSync(stale)).toBe(false);
  });

  it("keeps the config warning in the note when the note is written on a later start", () => {
    makeOld();
    write(join(from, "config.yaml"), `notify:\n  command: ${from}/notify.sh\n`);
    const r = migrate({ checkConfig: () => { throw new Error("bad"); }, writeNote: () => { throw new Error("read-only"); } });
    expect(r.status).toBe("migrated");
    expect(existsSync(join(from, NOTE_NAME))).toBe(false);
    migrate();
    expect(readFileSync(join(from, NOTE_NAME), "utf8")).toContain("notify.command");
  });

  it("postpones when space is short or cannot be checked", () => {
    makeOld();
    const r = migrate({ freeBytes: () => 0, copy: () => { throw new Error("no"); } });
    expect(r).toMatchObject({ status: "postponed", reason: "space" });
    expect(r.needBytes).toBeGreaterThan(100 * 1024 * 1024);
    expect(migrate({ sizeBytes: () => { throw new Error("du failed"); } })).toMatchObject({ status: "postponed", reason: "space" });
    expect(existsSync(to)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("removes stale temp folders of dead processes before the space check, but only ours", () => {
    makeOld();
    const ours = join(tmp, `.spaghetti-code-foundry.migrating-${deadPid()}`);
    write(join(ours, MARKER_NAME), "{}");
    const foreign = join(tmp, `.spaghetti-code-foundry.migrating-${deadPid()}`.replace(/\d+$/, (n) => String(Number(n) + 1)));
    write(join(foreign, "keep.txt"), "x");
    let seen = true;
    const r = migrate({ freeBytes: () => { seen = existsSync(ours); return 1e15; } });
    expect(seen).toBe(false);
    expect(r.status).toBe("migrated");
    expect(existsSync(join(foreign, "keep.txt"))).toBe(true);
  });

  it("rewrites paths in copied JSON, but not longer names, in-place workdirs or workspaces", () => {
    makeOld();
    const runDir = runJson("r2", {
      status: "waiting",
      workdir: join(from, "runs", "r2", "workspace"),
      vars: { x: `${from}/vars`, other: `${from}-x/a`, bak: `${from}.bak` },
      history: [{ logFile: join(runDir0("r2"), "logs", "a.log") }],
      waiting: { message: `see ${from}/runs/r2/out` },
      state: { next: "b", steps: { a: { output: `${from}/runs/r2/workspace` } } },
    });
    runJson("inplace", { status: "waiting", workdir: "/some/repo" });
    write(join(from, "locks", "acme", "l.json"), JSON.stringify({ runDir }));
    write(join(from, "queue.json"), JSON.stringify([{ runsDir: join(from, "runs") }]));
    write(join(from, "runs", "r2", "workspace", "package.json"), JSON.stringify({ p: from }));
    write(join(from, "broken.json"), `{"p": "${from}"`);
    expect(migrate().status).toBe("migrated");
    const run = JSON.parse(readFileSync(join(to, "runs", "r2", "run.json"), "utf8"));
    expect(run.runDir).toBe(join(to, "runs", "r2"));
    expect(run.vars).toEqual({ x: `${to}/vars`, other: `${from}-x/a`, bak: `${from}.bak` });
    expect(run.history[0].logFile).toBe(join(to, "runs", "r2", "logs", "a.log"));
    expect(run.waiting.message).toBe(`see ${to}/runs/r2/out`);
    expect(run.state.steps.a.output).toBe(join(to, "runs", "r2", "workspace"));
    expect(JSON.parse(readFileSync(join(to, "runs", "inplace", "run.json"), "utf8")).workdir).toBe("/some/repo");
    expect(JSON.parse(readFileSync(join(to, "locks", "acme", "l.json"), "utf8")).runDir).toBe(join(to, "runs", "r2"));
    expect(readFileSync(join(to, "queue.json"), "utf8")).toContain(to);
    expect(readFileSync(join(to, "runs", "r2", "workspace", "package.json"), "utf8")).toContain(from);
    expect(readFileSync(join(to, "broken.json"), "utf8")).toContain(from);
  });

  it("rewrites paths in config.yaml, lists the keys, and keeps comments", () => {
    makeOld();
    write(join(from, "config.yaml"), `# my config\nnotify:\n  command: ${from}/notify.sh\nwatchers:\n  - id: w\n    github_repo: acme/app\n    flow: ${from}/flows/mine.yaml\n`);
    const r = migrate({ checkConfig: (p) => void loadConfig(p) });
    expect(r.status).toBe("migrated");
    expect(r.message).toContain("notify.command");
    expect(r.message).toContain("watchers.0.flow");
    const text = readFileSync(join(to, "config.yaml"), "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain(`${to}/notify.sh`);
    expect(text).not.toContain(from);
  });

  it("keeps config.yaml as it is when the check fails, and says so in a warning and the note", () => {
    makeOld();
    const cfg = `notify:\n  command: ${from}/notify.sh\n`;
    write(join(from, "config.yaml"), cfg);
    const r = migrate({ checkConfig: () => { throw new Error("bad"); } });
    expect(r.status).toBe("migrated");
    expect(readFileSync(join(to, "config.yaml"), "utf8")).toBe(cfg);
    expect(r.warnings.join("\n")).toContain("notify.command");
    expect(readFileSync(join(from, NOTE_NAME), "utf8")).toContain("notify.command");
  });

  it("retries a failed note on the next start, and refuses to copy again when the new folder is gone", () => {
    makeOld();
    const r = migrate({ writeNote: () => { throw new Error("read-only"); } });
    expect(r.status).toBe("migrated");
    expect(r.warnings.join("\n")).toContain("later start");
    expect(existsSync(join(from, NOTE_NAME))).toBe(false);
    migrate();
    expect(existsSync(join(from, NOTE_NAME))).toBe(true);
    rmSync(to, { recursive: true });
    const again = migrate({ copy: () => { throw new Error("must not copy"); } });
    expect(again).toMatchObject({ status: "failed", reason: "moved-missing", home: from });
    expect(again.message).toContain("SCF_HOME");
    expect(existsSync(to)).toBe(false);
  });
});

function migrateCopy(f: string, t: string) {
  cpSync(f, t, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}
function runDir0(id: string) {
  return join(from, "runs", id);
}
