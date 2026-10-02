import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptRuns, defaultOwner, ownerNames, watcherOwner, watcherOwnerProblem } from "../src/auth/run-owner.js";
import { createUser, firstAdmin } from "../src/auth/users.js";
import { runFlow } from "../src/engine/runner.js";
import { adoptRun, listRunBriefs } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { nextStep } from "../src/next-step.js";
import { hideForeign, ownRecord } from "../src/server/next.js";

const PW = "test-password-12345";
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "run-owner-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const pause = () => new Promise((r) => setTimeout(r, 5));
const make = async (name: string, email: string, role: "admin" | "user") => {
  const u = await createUser({ name, email, password: PW, role });
  await pause();
  return u;
};

describe("firstAdmin", () => {
  it("is undefined with no accounts and with users only", async () => {
    expect(firstAdmin()).toBeUndefined();
    await make("Ann", "ann@example.com", "user");
    expect(firstAdmin()).toBeUndefined();
  });

  it("is the older of two admins, and a blocked admin still counts", async () => {
    await make("Ann", "ann@example.com", "user");
    const a = await make("Old", "old@example.com", "admin");
    const b = await make("New", "new@example.com", "admin");
    expect(firstAdmin()?.id).toBe(a.id);
    expect(firstAdmin()?.id).not.toBe(b.id);
    const { setStatus } = await import("../src/auth/users.js");
    await setStatus(a.id, "blocked");
    expect(firstAdmin()?.id).toBe(a.id);
  });
});

describe("watcherOwner", () => {
  it("finds the account by e-mail, in any case and with spaces", async () => {
    const admin = await make("Admin", "admin@example.com", "admin");
    const ann = await make("Ann", "ann@example.com", "user");
    expect(watcherOwner("ann@example.com")).toBe(ann.id);
    expect(watcherOwner("  ANN@Example.com ")).toBe(ann.id);
    expect(watcherOwner()).toBe(admin.id);
    expect(watcherOwner("")).toBe(admin.id);
    expect(watcherOwner("nobody@example.com")).toBe(admin.id);
  });

  it("is undefined without accounts or with a users.json that is not JSON, and never throws", () => {
    expect(watcherOwner("ann@example.com")).toBeUndefined();
    writeFileSync(join(home, "users.json"), "{ not json");
    expect(watcherOwner("ann@example.com")).toBeUndefined();
    expect(defaultOwner()).toBeUndefined();
    expect(ownerNames().size).toBe(0);
  });
});

describe("watcherOwnerProblem", () => {
  it("accepts no owner, a known owner and an unknown owner that was there before; names a new unknown one", async () => {
    await make("Admin", "admin@example.com", "admin");
    await make("Ann", "ann@example.com", "user");
    expect(watcherOwnerProblem([{ id: "w" }], [])).toBeUndefined();
    expect(watcherOwnerProblem([{ id: "w", owner: "ann@example.com" }], [])).toBeUndefined();
    expect(watcherOwnerProblem([{ id: "w", owner: "gone@example.com" }], [{ id: "w", owner: "gone@example.com" }])).toBeUndefined();
    expect(watcherOwnerProblem([{ id: "w2", owner: "gone@example.com" }], [{ id: "w", owner: "gone@example.com" }])).toMatch(/"w2"/);
    expect(watcherOwnerProblem([{ id: "w", owner: "other@example.com" }], [{ id: "w", owner: "gone@example.com" }])).toMatch(/"w"/);
  });
});

describe("adoptRun", () => {
  const RUN = { runId: "r1", flow: "f", status: "succeeded", extra: { unknown: [1, 2] }, history: [] };
  let dir: string;
  const file = () => join(dir, "run.json");
  const write = (o: unknown, mode = 0o600) => {
    writeFileSync(file(), typeof o === "string" ? o : JSON.stringify(o, null, 2));
    chmodSync(file(), mode);
    utimesSync(file(), new Date("2026-01-02T03:04:05.678Z"), new Date("2026-01-02T03:04:05.678Z"));
  };
  const noTmp = () => expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  beforeEach(() => {
    dir = join(home, "run");
    mkdirSync(dir);
  });

  it("adds the owner, keeps every other field, the file time and the mode", () => {
    write(RUN, 0o600);
    const before = statSync(file());
    expect(adoptRun(dir, "owner-1")).toBe(true);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ ...RUN, owner: "owner-1" });
    const after = statSync(file());
    expect(Math.round(after.mtimeMs)).toBe(Math.round(before.mtimeMs));
    expect(after.mode & 0o777).toBe(0o600);
    noTmp();
  });

  it("changes nothing for a run with an owner, a broken file and a live run", () => {
    for (const content of [{ ...RUN, owner: "x" }, "{ not json", { ...RUN, status: "running", pid: process.pid }]) {
      write(content);
      const text = readFileSync(file(), "utf8");
      expect(adoptRun(dir, "owner-1")).toBe(false);
      expect(readFileSync(file(), "utf8")).toBe(text);
      noTmp();
    }
  });

  it("takes a running run whose process is gone", () => {
    write({ ...RUN, status: "running", pid: 2 ** 22 + 12345 });
    expect(adoptRun(dir, "owner-1")).toBe(true);
    expect(JSON.parse(readFileSync(file(), "utf8")).owner).toBe("owner-1");
    noTmp();
  });

  it("gives up when run.json changed meanwhile, and leaves no temporary file", () => {
    write(RUN);
    const other = JSON.stringify({ ...RUN, status: "failed" });
    expect(adoptRun(dir, "owner-1", { beforeSwap: () => writeFileSync(file(), other) })).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe(other);
    noTmp();
  });
});

describe("adoptRuns", () => {
  const runsDir = () => join(home, "runs");
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(runsDir(), id), { recursive: true });
    writeFileSync(join(runsDir(), id, "run.json"), JSON.stringify({ runId: id, flow: "f", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z", runDir: join(runsDir(), id), ...extra }));
  };

  it("does nothing without an admin", async () => {
    add("a");
    await make("Ann", "ann@example.com", "user");
    const text = readFileSync(join(runsDir(), "a", "run.json"), "utf8");
    expect(adoptRuns(runsDir())).toBe(0);
    expect(readFileSync(join(runsDir(), "a", "run.json"), "utf8")).toBe(text);
  });

  it("gives ownerless runs to the first admin once", async () => {
    add("a");
    add("b", { owner: "someone" });
    const admin = await make("Admin", "admin@example.com", "admin");
    const lines: string[] = [];
    expect(adoptRuns(runsDir(), (m) => lines.push(m))).toBe(1);
    expect(adoptRuns(runsDir())).toBe(0);
    expect(lines).toHaveLength(1);
    const owners = Object.fromEntries(listRunBriefs(runsDir()).map((b) => [b.runId, b.owner]));
    expect(owners).toEqual({ a: admin.id, b: "someone" });
  });
});

describe("adoptRuns with odd files", () => {
  const runsDir = () => join(home, "runs");
  const put = (dir: string, content: object) => {
    mkdirSync(join(runsDir(), dir), { recursive: true });
    writeFileSync(join(runsDir(), dir, "run.json"), JSON.stringify(content));
  };

  it("uses the folder name, not the runId stored in the file", async () => {
    const target = join(home, "target");
    mkdirSync(target);
    writeFileSync(join(target, "run.json"), JSON.stringify({ runId: "t", status: "succeeded" }));
    put("a", { runId: "../../target", flow: "f", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z" });
    put("b", { runId: "a", flow: "f", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z" });
    const admin = await make("Admin", "admin@example.com", "admin");
    expect(adoptRuns(runsDir())).toBe(2);
    expect(JSON.parse(readFileSync(join(target, "run.json"), "utf8")).owner).toBeUndefined();
    expect(JSON.parse(readFileSync(join(runsDir(), "a", "run.json"), "utf8")).owner).toBe(admin.id);
    expect(JSON.parse(readFileSync(join(runsDir(), "b", "run.json"), "utf8")).owner).toBe(admin.id);
  });

  it("says so when the account file is broken", () => {
    writeFileSync(join(home, "users.json"), "{ not json");
    const lines: string[] = [];
    expect(adoptRuns(runsDir(), (m) => lines.push(m))).toBe(0);
    expect(lines).toHaveLength(1);
  });
});

describe("hideForeign", () => {
  it("takes out the id of a run that is not mine, in any field", () => {
    const v = { history: [{ output: "waiting for run X1 (src)" }], line: "waiting for run mine (a)" };
    const out = hideForeign(v, (id) => id === "mine");
    expect(JSON.stringify(out)).not.toContain("X1");
    expect(out.line).toBe("waiting for run mine (a)");
    expect(hideForeign({ a: 1 }, () => false)).toEqual({ a: 1 });
  });
});

describe("runFlow", () => {
  const flow = parseFlow("name: x\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
  const start = (owner?: string) => runFlow(flow, { task: "t", repo: home, runsDir: join(home, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), ...(owner ? { owner } : {}) });
  const onDisk = (id: string) => JSON.parse(readFileSync(join(home, "runs", id, "run.json"), "utf8")) as Record<string, unknown>;

  it("gives a run without an owner to the first admin, and to nobody when there is none", async () => {
    const none = await start();
    expect("owner" in onDisk(none.runId)).toBe(false);
    const admin = await make("Admin", "admin@example.com", "admin");
    const s = await start();
    expect(onDisk(s.runId).owner).toBe(admin.id);
    const given = await start("x");
    expect(onDisk(given.runId).owner).toBe("x");
  });
});

describe("ownRecord", () => {
  it("cuts a nested dependency chain so that another account's run is not named", () => {
    const running = nextStep("running", { repo: "o/r", issue: 1, runId: "X" });
    const inner = nextStep("dependency", { repo: "o/r", issue: 2 }, { blockers: [{ issue: 1, next: running }] });
    const outer = nextStep("dependency", { repo: "o/r", issue: 3 }, { blockers: [{ issue: 2, next: inner }] });
    expect(JSON.stringify(outer)).toContain("X");
    const out = ownRecord(outer, () => false);
    const json = JSON.stringify(out);
    expect(json).not.toContain("X");
    expect(json).not.toContain("which is being worked on");
    expect(out.blockers).toEqual([{ issue: 2 }]);
    expect(out.text).toContain("#2");
    expect(out.text).toContain("#3");
  });

  it("removes a foreign afterRun and links to the runs page; an own one stays", () => {
    const rec = nextStep("one_at_a_time", { repo: "o/r", runId: "mine" }, { blockingRun: "theirs" });
    expect(rec.afterRun).toBe("theirs");
    const out = ownRecord(rec, (id) => id === "mine");
    expect(out.afterRun).toBeUndefined();
    expect(out.where.url).toBe("#/runs");
    expect(JSON.stringify(out)).not.toContain("theirs");
    expect(ownRecord(rec, () => true)).toEqual(rec);
  });
});
