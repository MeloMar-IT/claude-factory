import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { SelfUpdater, type UpdaterOptions } from "../src/self-update.js";
import { confirmStart, loadUpdateState, readVersion, saveUpdateState, startGuard, type UpdateStep } from "../src/self-update-state.js";
import { buildStamp, RESTART_CODE, supervise, type StartGuard } from "../src/supervise.js";

vi.setConfig({ testTimeout: 60_000 });

// Local git repositories only: a bare remote, a seed clone that publishes commits, and the install (the checkout the Foundry runs from).
const V1: Record<string, string> = {
  "app.txt": "v1\n",
  "server.mjs": "process.exit(0);\n",
  "package-lock.json": "{}\n",
  ".gitignore": "dist/\nbreak-*\n.break-here\n",
  "install.sh": "[ -e break-install ] && exit 1\nexit 0\n",
  "build.sh": '[ -e break-build ] && { echo "build broke"; exit 1; }\nmkdir -p dist && cp app.txt dist/app.js\n',
  "test.sh": "exit 0\n",
};
const STEPS: UpdateStep[] = [
  { name: "install", cmd: "sh", args: ["install.sh"] },
  { name: "build", cmd: "sh", args: ["build.sh"] },
  { name: "test", cmd: "sh", args: ["test.sh"] },
];
const IN_PLACE_ONLY = 'case "$PWD" in *self-update-stage*) ;; *) %;; esac\n';
const NEVER = "setInterval(() => {}, 1000);\n";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  if (!cond()) throw new Error("timed out");
}
const sha7 = (s: string) => s.slice(0, 7);

beforeAll(() => {
  Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });
});

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "scf-su-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const install = join(root, "install");
  const file = join(root, "data", "self-update.json");
  mkdirSync(join(root, "data"));
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", seed);
  git(seed, "remote", "add", "origin", remote);
  const write = (files: Record<string, string>) => { for (const [k, v] of Object.entries(files)) writeFileSync(join(seed, k), v); };
  write(V1);
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "v1");
  git(seed, "push", "origin", "main");
  git(root, "clone", remote, install);
  execFileSync("sh", ["build.sh"], { cwd: install });
  const fx = {
    root, remote, seed, install, file,
    head: () => git(install, "rev-parse", "HEAD"),
    dist: () => readFileSync(join(install, "dist", "app.js"), "utf8").trim(),
    state: () => loadUpdateState(file).state,
    stage: join(root, "data", "self-update-stage"),
    publish(files: Record<string, string>, o: { replace?: boolean } = {}) {
      if (o.replace) git(seed, "reset", "--hard", "HEAD~1");
      write(files);
      git(seed, "add", "-A");
      git(seed, "commit", "-m", "next");
      git(seed, "push", ...(o.replace ? ["--force"] : []), "origin", "main");
      return git(seed, "rev-parse", "HEAD");
    },
    /** Takes the new commit into the install without the updater (a half-done install). */
    takeIn(sha: string) {
      git(install, "fetch", "origin");
      git(install, "merge", "--ff-only", sha);
    },
  };
  return fx;
}
type Fx = ReturnType<typeof fixture>;

function updater(f: Fx, over: Partial<UpdaterOptions> = {}) {
  const t = {
    idle: true, drained: 0, exits: [] as number[], logs: [] as string[], before: 0,
  };
  const u = new SelfUpdater({
    config: () => ({ enabled: true, repo: "acme/foundry" }),
    idle: () => t.idle,
    drain: () => { t.drained++; },
    beforeExit: () => { t.before++; },
    log: (m) => t.logs.push(m),
    dir: f.install, file: f.file, steps: STEPS,
    originRepo: () => "acme/foundry",
    guarded: true,
    exit: (c) => t.exits.push(c),
    ...over,
  });
  return Object.assign(t, { u });
}

/** Publishes v2, tests it while the queue is busy, then installs it. */
async function installV2(f: Fx, files: Record<string, string> = { "app.txt": "v2\n" }) {
  const v2 = f.publish(files);
  const t = updater(f);
  t.idle = false;
  await t.u.tick(true);
  t.idle = true;
  await t.u.tick(true);
  return { v2, t };
}

describe("self-update: the update path", () => {
  it("builds and tests first, installs when the queue is idle, and confirms the start", async () => {
    const f = fixture();
    const v1 = f.head();
    const v2 = f.publish({ "app.txt": "v2\n" });
    const t = updater(f);
    t.idle = false;
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2);
    expect(t.drained).toBe(1);
    expect(f.head()).toBe(v1);
    expect(f.dist()).toBe("v1");
    expect(t.u.view().update).toEqual({ waiting: true, commit: v2, text: `An update is waiting (${sha7(v2)}): it is installed when the active runs are done.` });
    expect(existsSync(f.stage)).toBe(false);

    t.idle = true;
    await t.u.tick(true);
    expect(f.head()).toBe(v2);
    expect(f.dist()).toBe("v2");
    const pending = f.state().pending;
    expect(pending).toMatchObject({ from: v1, to: v2, phase: "installed" });
    expect(pending?.stamp).toBe(buildStamp(join(f.install, "dist")));
    expect(t.exits).toEqual([RESTART_CODE]);
    expect(t.drained).toBe(1);

    const log: string[] = [];
    const ok = await confirmStart("http://127.0.0.1:1", { stamp: pending!.stamp!, log: (m) => log.push(m), dir: f.install, file: f.file, fetch: async () => true });
    expect(ok).toBe(true);
    expect(f.state().pending).toBeUndefined();
    expect(f.state().updated).toMatchObject({ from: v1, to: v2 });
  });

  it("does nothing when main has nothing new", async () => {
    const f = fixture();
    const t = updater(f);
    await t.u.tick(true);
    expect(t.u.view().update).toBeUndefined();
    expect(t.u.view().version?.commit).toBe(f.head());
    expect(t.drained).toBe(0);
  });

  it("installs nothing while the queue is busy, and drains once", async () => {
    const f = fixture();
    const v1 = f.head();
    f.publish({ "app.txt": "v2\n" });
    const t = updater(f);
    t.idle = false;
    for (let i = 0; i < 4; i++) await t.u.tick(true);
    expect(f.head()).toBe(v1);
    expect(t.drained).toBe(1);
    expect(t.exits).toEqual([]);
  });

  it("does nothing with local changes or on another branch, and fetches nothing", async () => {
    for (const how of ["changed", "untracked", "branch"]) {
      const f = fixture();
      const v1 = f.head();
      const v2 = f.publish({ "app.txt": "v2\n" });
      const ref = git(f.install, "rev-parse", "refs/remotes/origin/main");
      if (how === "changed") writeFileSync(join(f.install, "app.txt"), "mine\n");
      if (how === "untracked") writeFileSync(join(f.install, "notes.txt"), "mine\n");
      if (how === "branch") git(f.install, "checkout", "-b", "other");
      const t = updater(f);
      await t.u.tick(true);
      const why = how === "branch" ? "the checkout is not on main" : "the checkout has local changes";
      expect(t.u.view().update).toEqual({ waiting: true, commit: v2, text: `An update is waiting (${sha7(v2)}): ${why}.` });
      expect(existsSync(f.stage)).toBe(false);
      expect(t.drained).toBe(0);
      expect(t.exits).toEqual([]);
      expect(f.head()).toBe(v1);
      expect(git(f.install, "rev-parse", "refs/remotes/origin/main")).toBe(ref);
      expect(() => git(f.install, "cat-file", "-e", v2)).toThrow();
      // said once
      await t.u.tick(true);
      expect(t.logs.filter((l) => l.includes(why))).toHaveLength(1);
    }
  });

  it("does not update a checkout that has commits that are not on main", async () => {
    const f = fixture();
    writeFileSync(join(f.install, "mine.txt"), "x\n");
    git(f.install, "add", "-A");
    git(f.install, "commit", "-m", "local");
    const v2 = f.publish({ "app.txt": "v2\n" });
    const t = updater(f);
    await t.u.tick(true);
    expect(t.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): the checkout has commits that are not on main.`);
    expect(t.drained).toBe(0);
    expect(existsSync(f.stage)).toBe(false);
  });

  it("makes no network call for the wrong repository, when off, or when not guarded", async () => {
    const f = fixture();
    f.publish({ "app.txt": "v2\n" });
    rmSync(f.remote, { recursive: true, force: true }); // a call would answer "unreachable"
    const wrong = updater(f, { originRepo: () => "evil/foundry" });
    await wrong.u.tick(true);
    expect(wrong.u.view().update).toEqual({ waiting: false, text: "Self-update does nothing: the origin of the checkout is not acme/foundry." });
    const local = updater(f, { originRepo: undefined }); // the default parser: a local path is no GitHub repository
    await local.u.tick(true);
    expect(local.u.view().update?.text).toContain("is not acme/foundry");
    const off = updater(f, { config: () => ({ enabled: false }) });
    await off.u.tick(true);
    expect(off.u.view().update).toBeUndefined();
    const free = updater(f, { guarded: false });
    await free.u.tick(true);
    expect(free.u.view().update).toEqual({ waiting: false, text: "Self-update does nothing: stop and start the Foundry once, so that it can go back after a bad update." });
    const gone = updater(f);
    await gone.u.tick(true);
    expect(gone.u.view().update).toEqual({ waiting: false, text: "Self-update does nothing: main could not be read from GitHub." });
  });

  it("does nothing when the Foundry does not run from a checkout", async () => {
    const f = fixture();
    const plain = join(f.root, "plain");
    mkdirSync(plain);
    const t = updater(f, { dir: plain });
    await t.u.tick(true);
    expect(t.u.view()).toEqual({ update: { waiting: false, text: "Self-update does nothing: the Foundry does not run from a git checkout." } });
  });

  it("keeps the old version when the build or the tests fail, and tries again only for a newer commit", async () => {
    for (const [stage, files] of [["build", { "build.sh": 'echo "build broke"\nexit 1\n' }], ["test", { "test.sh": "echo nope\nexit 1\n" }], ["install", { "install.sh": "exit 1\n" }]] as const) {
      const f = fixture();
      const v1 = f.head();
      const bad = f.publish({ ...files, "app.txt": "v2\n" });
      const t = updater(f);
      await t.u.tick(true);
      expect(f.state().failed).toMatchObject({ commit: bad, stage });
      expect(f.state().tested).toBeUndefined();
      expect(f.head()).toBe(v1);
      expect(f.dist()).toBe("v1");
      expect(t.drained).toBe(0);
      expect(t.exits).toEqual([]);
      expect(existsSync(f.stage)).toBe(false);
      expect(t.u.view().update?.text).toContain("The Foundry waits for a newer commit on main.");
      await t.u.tick(true);
      expect(t.logs.filter((l) => l.includes("building and testing"))).toHaveLength(1);

      const good = f.publish({ "build.sh": V1["build.sh"]!, "test.sh": "exit 0\n", "install.sh": V1["install.sh"]!, "app.txt": "v3\n" });
      await t.u.tick(true);
      expect(f.state().failed).toBeUndefined();
      expect(f.state().tested?.commit).toBe(good);
    }
  });

  it("says why a failure happened, in the text of its stage", async () => {
    const f = fixture();
    const v2 = f.publish({ "test.sh": "exit 1\n" });
    const t = updater(f);
    await t.u.tick(true);
    expect(t.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): its tests failed. The Foundry waits for a newer commit on main.`);
  });

  it("stages a newer commit when main moves while it waits for the runs", async () => {
    const f = fixture();
    const v2 = f.publish({ "app.txt": "v2\n" });
    const t = updater(f);
    t.idle = false;
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2);
    const v3 = f.publish({ "app.txt": "v3\n" });
    t.idle = true;
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v3);
    expect(f.dist()).toBe("v1");
    expect(t.exits).toEqual([]);
    expect(t.drained).toBe(1);
    await t.u.tick(true);
    expect(f.head()).toBe(v3);
    expect(f.dist()).toBe("v3");
    expect(t.exits).toEqual([RESTART_CODE]);
  });

  it("stages the replacement when main is force-pushed while it waits", async () => {
    const f = fixture();
    const v2 = f.publish({ "app.txt": "v2\n" });
    const t = updater(f);
    t.idle = false;
    await t.u.tick(true);
    const v2b = f.publish({ "app.txt": "v2b\n" }, { replace: true });
    expect(v2b).not.toBe(v2);
    t.idle = true;
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2b);
    expect(f.dist()).toBe("v1");
    await t.u.tick(true);
    expect(f.head()).toBe(v2b);
    expect(f.dist()).toBe("v2b");
  });

  it("installs nothing, and restarts so the watchers start again, when GitHub cannot be read at idle", async () => {
    const f = fixture();
    const v1 = f.head();
    f.publish({ "app.txt": "v2\n" });
    const t = updater(f);
    t.idle = false;
    await t.u.tick(true);
    rmSync(f.remote, { recursive: true, force: true });
    t.idle = true;
    await t.u.tick(true);
    expect(f.head()).toBe(v1);
    expect(f.dist()).toBe("v1");
    expect(f.state().pending).toBeUndefined();
    expect(t.exits).toEqual([RESTART_CODE]);
  });

  it("goes back when the install fails in place", async () => {
    const f = fixture();
    const v1 = f.head();
    const { v2, t } = await installV2(f, { "app.txt": "v2\n", "build.sh": IN_PLACE_ONLY.replace("%", 'echo "in place broke"; exit 1') + V1["build.sh"] });
    expect(f.head()).toBe(v1);
    expect(f.dist()).toBe("v1");
    expect(f.state().pending).toBeUndefined();
    expect(f.state().failed).toMatchObject({ commit: v2, stage: "apply", back: v1, backOk: true });
    expect(f.state().failed?.lines?.join(" ")).toContain("in place broke");
    expect(t.exits).toEqual([RESTART_CODE]);
  });

  it("stops a running step when the server stops, and removes a stale stage folder", async () => {
    const f = fixture();
    const mark = join(f.root, "marker");
    const v2 = f.publish({ "test.sh": `sleep 1.5\ntouch ${mark}\n` });
    const t = updater(f);
    const round = t.u.tick(true);
    await until(() => t.u.busy());
    t.u.stop();
    await round;
    expect(t.u.busy()).toBe(false);
    await sleep(2200);
    expect(existsSync(mark)).toBe(false);
    expect(f.state().failed).toBeUndefined();
    expect(f.state().tested).toBeUndefined();

    // a leftover stage folder of a server that was stopped while it built
    git(f.install, "worktree", "add", "--detach", f.stage, v2);
    const again = updater(f, { steps: STEPS.map((s) => (s.name === "test" ? { ...s, args: ["-c", "exit 0"], cmd: "sh" } : s)) });
    await again.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2);
    expect(existsSync(f.stage)).toBe(false);
  });

  it("keeps secrets out of the record and the log", async () => {
    const f = fixture();
    f.publish({ "build.sh": 'echo "token=hunter2-secret"\nexit 1\n' });
    const t = updater(f, { redact: (s) => s.replaceAll("hunter2-secret", "<hidden>") });
    await t.u.tick(true);
    expect(readFileSync(f.file, "utf8")).not.toContain("hunter2-secret");
    expect(t.logs.join("\n")).not.toContain("hunter2-secret");
    expect(f.state().failed?.lines?.join(" ")).toContain("hidden");

    const g = fixture();
    g.publish({ "build.sh": 'echo "token=hunter2-secret"\nexit 1\n' });
    const s = updater(g, { redact: () => { throw new Error("store unreadable"); } });
    await s.u.tick(true);
    expect(g.state().failed?.lines).toEqual(["the output is not shown"]);
    expect(readFileSync(g.file, "utf8")).not.toContain("hunter2-secret");
  });
});

describe("self-update: going back", () => {
  const guard = (f: Fx, over: Partial<StartGuard> = {}): StartGuard => ({
    ...startGuard(() => {}, { dir: f.install, file: f.file, steps: STEPS }),
    pollMs: 20,
    ...over,
  });
  const server = (f: Fx) => join(f.install, "server.mjs");

  it("goes back when the new version stops before it is healthy, and reports it", async () => {
    const f = fixture();
    const v1 = f.head();
    const { v2 } = await installV2(f, { "app.txt": "v2\n", "server.mjs": "process.exit(1);\n" });
    expect(f.head()).toBe(v2);
    expect(await supervise(server(f), [], () => {}, guard(f))).toBe(0);
    expect(f.head()).toBe(v1);
    expect(f.dist()).toBe("v1");
    expect(f.state().pending).toBeUndefined();
    expect(f.state().failed).toMatchObject({ commit: v2, stage: "start", back: v1, backOk: true });

    const next = updater(f);
    await next.u.tick(true);
    expect(f.head()).toBe(v1);
    expect(next.exits).toEqual([]);
    expect(next.u.view().update?.text).toBe(`An update is waiting (${sha7(v2)}): it did not start healthy and the Foundry went back to ${sha7(v1)}. The Foundry waits for a newer commit on main.`);
  });

  it("goes back when the new version does not answer in time", async () => {
    const f = fixture();
    const v1 = f.head();
    await installV2(f, { "app.txt": "v2\n", "server.mjs": NEVER });
    expect(await supervise(server(f), [], () => {}, guard(f, { healthMs: 200 }))).toBe(0);
    expect(f.head()).toBe(v1);
    expect(f.dist()).toBe("v1");
    expect(f.state().failed).toMatchObject({ stage: "start", backOk: true });
  });

  it("still goes back when the record is cleared on the tick that decides", async () => {
    const f = fixture();
    const marker = join(f.root, "starts");
    writeFileSync(join(f.root, "child.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "x"); setInterval(() => {}, 1000);\n`);
    const p = { from: "a".repeat(40), to: "b".repeat(40), phase: "installed" as const };
    let cleared = false;
    const t0 = Date.now();
    const calls: string[] = [];
    const g: StartGuard = {
      pending: () => {
        const r = cleared ? undefined : p;
        if (Date.now() >= t0 + 150) cleared = true; // answers on the deciding tick, gone right after
        return r;
      },
      rollBack: async (why) => { calls.push(why); return true; },
      healthMs: 150, pollMs: 20,
    };
    let settled = false;
    const done = supervise(join(f.root, "child.mjs"), [], () => {}, g).then((c) => { settled = true; return c; });
    await until(() => calls.length === 1 && existsSync(marker) && readFileSync(marker, "utf8").length === 2);
    await sleep(200);
    expect(calls).toEqual(["timeout"]);
    expect(settled).toBe(false);
    process.emit("SIGTERM");
    await done;
  });

  it("does not guard a commit again after it was put back, and never rolls back a healthy start", async () => {
    const f = fixture();
    const p = { from: "a".repeat(40), to: "b".repeat(40), phase: "installed" as const };
    const calls: string[] = [];
    // healthy: the record is cleared while the server runs
    writeFileSync(join(f.root, "slow.mjs"), "setTimeout(() => process.exit(0), 300);\n");
    let n = 0;
    const healthy: StartGuard = { pending: () => (n++ < 2 ? p : undefined), rollBack: async (w) => { calls.push(w); return true; }, pollMs: 20 };
    expect(await supervise(join(f.root, "slow.mjs"), [], () => {}, healthy)).toBe(0);
    expect(calls).toEqual([]);

    // once: the first start stops, the commit is put back, the second start is not guarded
    writeFileSync(join(f.root, "second.mjs"), `process.exit(process.env.FACTORY_NO_OPEN ? 0 : 1);\n`);
    const again: StartGuard = { pending: () => p, rollBack: async (w) => { calls.push(w); return true; }, pollMs: 20 };
    expect(await supervise(join(f.root, "second.mjs"), [], () => {}, again)).toBe(0);
    expect(calls).toEqual(["exit"]);
  });

  it("is not confirmed by a healthy server of another build, another commit, or an unfinished install", async () => {
    const f = fixture();
    const v1 = f.head();
    const v2 = f.publish({ "app.txt": "v2\n" });
    f.takeIn(v2);
    const log = (_: string) => {};
    const confirm = (stamp: number) => confirmStart("http://127.0.0.1:1", { stamp, log, dir: f.install, file: f.file, fetch: async () => true });
    const stamp = buildStamp(join(f.install, "dist"));
    saveUpdateState({ pending: { from: v1, to: v2, phase: "installed", stamp } }, f.file);
    expect(await confirm(stamp + 1)).toBe(false); // another build
    expect(f.state().pending).toBeDefined();
    saveUpdateState({ pending: { from: v1, to: v2, phase: "apply", stamp } }, f.file);
    expect(await confirm(stamp)).toBe(false); // the install is not finished
    expect(f.state().pending).toBeDefined();
    saveUpdateState({ pending: { from: v1, to: v1, phase: "installed", stamp } }, f.file);
    expect(await confirm(stamp)).toBe(false); // HEAD is not the installed commit
    expect(f.state().pending).toBeDefined();
    saveUpdateState({ pending: { from: v1, to: v2, phase: "installed", stamp } }, f.file);
    expect(await confirmStart("http://127.0.0.1:1", { stamp, log, dir: f.install, file: f.file, fetch: async () => false })).toBe(false); // no answer
    expect(f.state().pending).toBeDefined();
    expect(await confirm(stamp)).toBe(true);
  });

  it("finishes going back before the first start when an install was cut off", async () => {
    // (a) the checkout is still at the old version
    {
      const f = fixture();
      const v1 = f.head();
      const v2 = f.publish({ "app.txt": "v2\n" });
      saveUpdateState({ pending: { from: v1, to: v2, phase: "apply" } }, f.file);
      expect(await supervise(server(f), [], () => {}, guard(f))).toBe(0);
      expect(f.head()).toBe(v1);
      expect(f.dist()).toBe("v1");
      expect(f.state().pending).toBeUndefined();
      expect(f.state().failed).toMatchObject({ commit: v2, stage: "apply", backOk: true });
    }
    // (b) the checkout is at the new version, the build is old
    {
      const f = fixture();
      const v1 = f.head();
      const v2 = f.publish({ "app.txt": "v2\n" });
      f.takeIn(v2);
      saveUpdateState({ pending: { from: v1, to: v2, phase: "apply" } }, f.file);
      expect(await supervise(server(f), [], () => {}, guard(f))).toBe(0);
      expect(f.head()).toBe(v1);
      expect(f.dist()).toBe("v1");
      expect(f.state().failed).toMatchObject({ stage: "apply", backOk: true });
    }
    // (c) the server was stopped during a slow build in place
    {
      const f = fixture();
      const v1 = f.head();
      const v2 = f.publish({ "app.txt": "v2\n", "build.sh": IN_PLACE_ONLY.replace("%", "sleep 20") + V1["build.sh"] });
      const t = updater(f);
      t.idle = false;
      await t.u.tick(true);
      t.idle = true;
      const round = t.u.tick(true);
      await until(() => f.state().pending?.phase === "apply" && t.u.busy());
      await sleep(300);
      t.u.stop();
      await round;
      expect(f.head()).toBe(v2);
      expect(t.exits).toEqual([]);
      expect(await supervise(server(f), [], () => {}, guard(f))).toBe(0);
      expect(f.head()).toBe(v1);
      expect(f.dist()).toBe("v1");
      expect(f.state().failed).toMatchObject({ commit: v2, stage: "apply", backOk: true });
    }
  });

  it("says when it cannot go back, builds nothing at the new version, and stops self-update", async () => {
    const cases: [string, (f: Fx, v1: string, v2: string) => void][] = [
      ["dirty tree", (f) => writeFileSync(join(f.install, "app.txt"), "mine\n")],
      ["other branch", (f) => git(f.install, "checkout", "-b", "other")],
      ["reset fails", (f) => writeFileSync(join(f.install, ".git", "index.lock"), "")],
      ["install of the old version fails", (f) => writeFileSync(join(f.install, "break-install"), "")],
      ["build of the old version fails", (f) => writeFileSync(join(f.install, "break-build"), "")],
    ];
    for (const [name, spoil] of cases) {
      const f = fixture();
      const v1 = f.head();
      const v2 = f.publish({ "app.txt": "v2\n", "package-lock.json": '{"v":2}\n' });
      f.takeIn(v2);
      spoil(f, v1, v2);
      saveUpdateState({ pending: { from: v1, to: v2, phase: "installed", stamp: 1 } }, f.file);
      const logs: string[] = [];
      const g = { ...guard(f), ...startGuard((m) => logs.push(m), { dir: f.install, file: f.file, steps: STEPS }), pollMs: 20 };
      expect(await supervise(server(f), [], () => {}, { ...g, healthMs: 100 }), name).toBe(0);
      expect(f.state().failed, name).toMatchObject({ commit: v2, stage: "start", back: v1, backOk: false });
      expect(f.state().pending, name).toBeUndefined();
      if (name === "dirty tree" || name === "other branch" || name === "reset fails") expect(f.dist(), name).toBe("v1"); // nothing was built at v2
      expect(logs.join("\n"), name).not.toContain(f.install);
      const t = updater(f);
      await t.u.tick(true);
      expect(t.u.view().update?.text, name).toBe(`Self-update is stopped: the update to ${sha7(v2)} failed and the Foundry could not go back to ${sha7(v1)}. Repair the checkout by hand (git status, npm ci, npm run build), then delete self-update.json in the data folder.`);
      expect(t.drained, name).toBe(0);
      expect(existsSync(f.stage), name).toBe(false);
    }
  });
});

describe("self-update: readiness and the switch", () => {
  it("confirms the start with the real probe: it needs no session, only /api/ready", async () => {
    const f = fixture();
    const v1 = f.head();
    const v2 = f.publish({ "app.txt": "v2\n" });
    f.takeIn(v2);
    const stamp = buildStamp(join(f.install, "dist"));
    saveUpdateState({ pending: { from: v1, to: v2, phase: "installed", stamp } }, f.file);
    const server = createServer((req, res) => {
      res.statusCode = req.url === "/api/ready" ? 200 : 401; // /api/health needs a session
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await confirmStart(url, { stamp, log: () => {}, dir: f.install, file: f.file })).toBe(true);
      expect(f.state().updated?.to).toBe(v2);
    } finally {
      server.close();
    }
  });

  it("restarts onto the unchanged version when it is switched off while it waits for the runs", async () => {
    const f = fixture();
    const v1 = f.head();
    f.publish({ "app.txt": "v2\n" });
    let enabled = true;
    const t = updater(f, { config: () => ({ enabled, repo: "acme/foundry" }) });
    t.idle = false;
    await t.u.tick(true);
    expect(t.drained).toBe(1);
    enabled = false;
    await t.u.tick(true);
    expect(t.exits).toEqual([]); // the active runs are not cut off
    t.idle = true;
    await t.u.tick(true);
    expect(t.exits).toEqual([RESTART_CODE]);
    expect(f.head()).toBe(v1);
    expect(f.dist()).toBe("v1");
    expect(f.state().pending).toBeUndefined();
  });

  it("does not drain when it is switched off while the update is built", async () => {
    const f = fixture();
    f.publish({ "test.sh": "sleep 1\nexit 0\n" });
    let enabled = true;
    const t = updater(f, { config: () => ({ enabled, repo: "acme/foundry" }) });
    const round = t.u.tick(true);
    await until(() => t.u.busy());
    enabled = false;
    await round;
    expect(t.drained).toBe(0);
    expect(t.exits).toEqual([]);
    expect(t.u.view().update).toBeUndefined();
  });
});

describe("self-update: what changes between the check and the install", () => {
  /** Tests v2 while the queue is busy, then runs one idle round in which `race` happens right after the check (at the idle test). */
  async function raced(race: (f: Fx, set: { repo: string }) => void, text: (v2: string, v1: string) => string) {
    const f = fixture();
    const v1 = f.head();
    const v2 = f.publish({ "app.txt": "v2\n" });
    const set = { repo: "acme/foundry" };
    let busy = true;
    let armed = false;
    let calls = 0;
    const t = updater(f, {
      config: () => ({ enabled: true, repo: set.repo }),
      idle: () => {
        if (!armed) return !busy;
        if (++calls === 2) race(f, set); // the first call is the gate at the start of the round, the second comes after the check
        return true;
      },
    });
    await t.u.tick(true);
    expect(f.state().tested?.commit).toBe(v2);
    armed = true;
    busy = false;
    await t.u.tick(true);
    expect(f.head()).not.toBe(v2); // (the local commit of one race moves HEAD on purpose)
    expect(f.dist()).toBe("v1");
    expect(f.state().pending).toBeUndefined();
    expect(t.exits).toEqual([]);
    expect(t.u.view().update?.text).toBe(text(v2, v1));
  }

  it("installs nothing when a file is changed after the check", async () => {
    await raced((f) => writeFileSync(join(f.install, "app.txt"), "mine\n"), (v2) => `An update is waiting (${sha7(v2)}): the checkout has local changes.`);
  });

  it("installs nothing when the checkout switches to another branch after the check", async () => {
    await raced((f) => git(f.install, "checkout", "-b", "other"), (v2) => `An update is waiting (${sha7(v2)}): the checkout is not on main.`);
  });

  it("installs nothing when the checkout gets a commit after the check", async () => {
    await raced((f) => {
      writeFileSync(join(f.install, "mine.txt"), "x\n");
      git(f.install, "add", "-A");
      git(f.install, "commit", "-m", "local");
    }, (v2) => `An update is waiting (${sha7(v2)}): the checkout has commits that are not on main.`);
  });

  it("installs nothing when the configured repository changes after the check", async () => {
    await raced((_f, set) => { set.repo = "acme/other"; }, () => "Self-update does nothing: the origin of the checkout is not acme/other.");
  });
});

describe("self-update: the record", () => {
  it("marks a record that cannot be read as broken and never overwrites it", async () => {
    const f = fixture();
    for (const text of ["{not json", JSON.stringify({ pending: { from: "xyz", to: "abc", phase: "installed" } })]) {
      writeFileSync(f.file, text);
      expect(loadUpdateState(f.file)).toEqual({ state: {}, broken: true });
      const t = updater(f);
      f.publish({ "app.txt": `v${Math.random()}\n` });
      await t.u.tick(true);
      expect(t.u.view().update).toEqual({ waiting: false, text: "Self-update is stopped: self-update.json in the data folder could not be read. Check the checkout (git status, git log), then delete the file." });
      expect(readFileSync(f.file, "utf8")).toBe(text);
      expect(startGuard(() => {}, { file: f.file }).pending()).toBeUndefined();
    }
  });

  it("reads a record with an unknown key, and no record as empty", () => {
    const f = fixture();
    expect(loadUpdateState(f.file)).toEqual({ state: {}, broken: false });
    const sha = "c".repeat(40);
    writeFileSync(f.file, JSON.stringify({ updated: { from: sha, to: sha, at: "x" }, later: 1 }));
    expect(loadUpdateState(f.file).broken).toBe(false);
    expect(loadUpdateState(f.file).state.updated?.to).toBe(sha);
  });

  it("reads the version of a checkout only", () => {
    const f = fixture();
    const v = readVersion(f.install);
    expect(v?.commit).toBe(f.head());
    expect(Number.isNaN(Date.parse(v!.date))).toBe(false);
    const plain = join(f.root, "plain");
    mkdirSync(plain);
    expect(readVersion(plain)).toBeUndefined();
    mkdirSync(join(f.install, "inside"));
    expect(readVersion(join(f.install, "inside"))).toBeUndefined();
  });
});

describe("self-update: the setting", () => {
  it("is off by default and needs the repository when on", () => {
    expect(ConfigSchema.parse({}).self_update).toEqual({ enabled: false });
    expect(ConfigSchema.parse({ self_update: { enabled: true, repo: "acme/foundry" } }).self_update).toEqual({ enabled: true, repo: "acme/foundry" });
    for (const bad of [{ enabled: true }, { enabled: true, repo: "owner/repo" }, { enabled: true, repo: "x/.." }, { enabled: true, repo: `${"a".repeat(40)}/x` }, { enabled: true, repo: "_owner/x" }, { enabled: false, extra: 1 }]) {
      expect(() => ConfigSchema.parse({ self_update: bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
