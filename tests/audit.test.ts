import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditEntrySchema, EVENT_ACTIONS, TARGET_MAX, auditAction, changedKeys, appendAuditLocked, auditPath, prepareAuditLocked, writeAudit, type AuditEvent } from "../src/auth/audit.js";
import { findSession } from "../src/auth/sessions.js";
import { createUser, setStatus, startSession } from "../src/auth/users.js";
import { openAppendLocked, StoreError, withAuthLock } from "../src/auth/store.js";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "audit-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const id = () => randomUUID();
const lines = () => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean);
const mode = (p: string) => statSync(p).mode & 0o777;
const add = (by: string, event: AuditEvent) =>
  withAuthLock(() => {
    const log = prepareAuditLocked(by, event);
    try {
      log.write();
    } finally {
      log.close();
    }
  });
const kind = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof StoreError ? { kind: e.kind, message: e.message } : e;
  }
  return undefined;
};

describe("prepareAuditLocked", () => {
  it("needs the lock and creates no file without it", () => {
    expect(() => prepareAuditLocked("cli", { action: "create", userId: id() })).toThrow();
    expect(existsSync(auditPath())).toBe(false);
  });

  it("writes nothing until write()", () => {
    withAuthLock(() => prepareAuditLocked("cli", { action: "block", userId: id() }).close());
    expect(!existsSync(auditPath()) || lines().length === 0).toBe(true);
  });

  it("appends one line with mode 0600 and the exact keys", () => {
    const uid = id();
    add("cli", { action: "create", userId: uid });
    expect(mode(auditPath())).toBe(0o600);
    expect(readFileSync(auditPath(), "utf8").endsWith("\n")).toBe(true);
    const entry = JSON.parse(lines()[0]!);
    expect(Object.keys(entry)).toEqual(["time", "by", "action", "userId"]);
    expect(entry).toMatchObject({ by: "cli", action: "create", userId: uid });
  });

  it("appends and keeps the first line, and fixes the mode", () => {
    add("cli", { action: "create", userId: id() });
    const first = lines()[0];
    chmodSync(auditPath(), 0o644);
    add(id(), { action: "role", userId: id(), oldRole: "user", newRole: "admin" });
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toBe(first);
    expect(mode(auditPath())).toBe(0o600);
    expect(JSON.parse(lines()[1]!)).toMatchObject({ oldRole: "user", newRole: "admin" });
  });

  it("writes an edit entry with exactly the keys time, by, action, userId", () => {
    add("cli", { action: "edit", userId: id() });
    expect(Object.keys(JSON.parse(lines()[0]!))).toEqual(["time", "by", "action", "userId"]);
  });

  it("refuses invalid entries", () => {
    const bad: unknown[] = [
      { action: "block", userId: id(), oldRole: "user", newRole: "admin" },
      { action: "role", userId: id() },
      { action: "rename", userId: id() },
      { action: "create", userId: "not-a-uuid" },
    ];
    for (const e of bad) expect(() => withAuthLock(() => prepareAuditLocked("cli", e as AuditEvent))).toThrow();
    expect(() => withAuthLock(() => prepareAuditLocked("ann@example.com", { action: "create", userId: id() }))).toThrow();
    expect(() => add(id(), { action: "create", userId: id() })).not.toThrow();
    expect(lines()).toHaveLength(1);
  });

  it("keeps a cut-off tail and starts the next entry on its own line", () => {
    writeFileSync(auditPath(), '{"time":"2026', { mode: 0o600 });
    add("cli", { action: "delete", userId: id() });
    add("cli", { action: "unblock", userId: id() });
    const text = readFileSync(auditPath(), "utf8");
    expect(text.startsWith('{"time":"2026\n')).toBe(true);
    expect(text).not.toContain("\n\n");
    const l = lines();
    expect(l).toHaveLength(3);
    expect(AuditEntrySchema.safeParse(JSON.parse(l[1]!)).success).toBe(true);
  });

  it("writes a `reset` entry with exactly time, by, action and userId", () => {
    const user = id();
    add("cli", { action: "reset", userId: user });
    const entry = JSON.parse(lines()[0]!);
    expect(Object.keys(entry).sort()).toEqual(["action", "by", "time", "userId"]);
    expect(entry).toMatchObject({ action: "reset", by: "cli", userId: user });
    expect(AuditEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("adds no separator after a complete line", () => {
    add("cli", { action: "create", userId: id() });
    add("cli", { action: "create", userId: id() });
    expect(readFileSync(auditPath(), "utf8")).not.toContain("\n\n");
  });

  it("refuses a directory, a symlink and a dangling symlink, naming the file", () => {
    mkdirSync(auditPath());
    const dir = kind(() => withAuthLock(() => prepareAuditLocked("cli", { action: "create", userId: id() })));
    expect(dir).toMatchObject({ kind: "cannot-write" });
    expect((dir as { message: string }).message).toContain("audit.jsonl");
    rmSync(auditPath(), { recursive: true });
    writeFileSync(join(home, "target"), "x");
    symlinkSync(join(home, "target"), auditPath());
    expect(kind(() => withAuthLock(() => prepareAuditLocked("cli", { action: "create", userId: id() })))).toMatchObject({ kind: "cannot-write" });
    rmSync(auditPath());
    symlinkSync(join(home, "nowhere"), auditPath());
    expect(kind(() => withAuthLock(() => prepareAuditLocked("cli", { action: "create", userId: id() })))).toMatchObject({ kind: "cannot-write" });
    expect(readFileSync(join(home, "target"), "utf8")).toBe("x");
  });

  it("gives `locked` when the lock was removed, and appends nothing", () => {
    const r = kind(() =>
      withAuthLock(() => {
        rmSync(join(home, "auth.lock"), { recursive: true, force: true });
        prepareAuditLocked("cli", { action: "create", userId: id() });
      }),
    );
    expect(r).toMatchObject({ kind: "locked" });
    expect(!existsSync(auditPath()) || lines().length === 0).toBe(true);
  });

  it("says the change was made when the write fails after close", () => {
    const r = kind(() =>
      withAuthLock(() => {
        const log = prepareAuditLocked("cli", { action: "create", userId: id() });
        log.close();
        log.write();
      }),
    );
    expect(r).toMatchObject({ kind: "cannot-write" });
    expect((r as { message: string }).message).toContain("the account change was made");
  });
});

describe("openAppendLocked", () => {
  it("refuses a path outside the locked folder and a line with a newline", () => {
    expect(() => withAuthLock(() => openAppendLocked(join(tmpdir(), "x.jsonl")))).toThrow();
    withAuthLock(() => {
      const f = openAppendLocked(join(home, "x.jsonl"));
      expect(() => f.append("a\nb")).toThrow();
      f.close();
    });
  });

  it("append after close throws cannot-write", () => {
    const r = kind(() =>
      withAuthLock(() => {
        const f = openAppendLocked(join(home, "x.jsonl"));
        f.close();
        f.append("a");
      }),
    );
    expect(r).toMatchObject({ kind: "cannot-write" });
  });

  it("writes a long line whole", () => {
    const long = "x".repeat(64 * 1024);
    withAuthLock(() => {
      const f = openAppendLocked(join(home, "x.jsonl"));
      f.append(long);
      f.close();
    });
    expect(readFileSync(join(home, "x.jsonl"), "utf8")).toBe(long + "\n");
  });
});

describe("block lines and stopWork", () => {
  it("a block line has exactly time, by, action, userId, stopWork", () => {
    add("cli", { action: "block", userId: id(), stopWork: true });
    add("cli", { action: "block", userId: id() });
    const l = lines().map((x) => JSON.parse(x) as Record<string, unknown>);
    expect(Object.keys(l[0]!)).toEqual(["time", "by", "action", "userId", "stopWork"]);
    expect(l[0]!.stopWork).toBe(true);
    expect(l[1]!.stopWork).toBe(false);
  });

  it("a block line from before still parses; stopWork on another action is refused", () => {
    const base = { time: new Date().toISOString(), by: "cli", userId: id() };
    expect(AuditEntrySchema.safeParse({ ...base, action: "block" }).success).toBe(true);
    expect(AuditEntrySchema.safeParse({ ...base, action: "block", stopWork: false }).success).toBe(true);
    expect(AuditEntrySchema.safeParse({ ...base, action: "unblock", stopWork: true }).success).toBe(false);
  });
});

describe("event lines", () => {
  const time = () => new Date().toISOString();
  const ok = (e: Record<string, unknown>) => AuditEntrySchema.safeParse({ time: time(), by: "anonymous", action: "sign-in", result: "failed", ...e }).success;
  const keys = (n: number) => Object.keys(JSON.parse(lines()[n]!));

  it("writeAudit takes the lock itself and writes one line, mode 0600", () => {
    const u = id();
    writeAudit(u, { action: "sign-in", result: "ok", userId: u });
    writeAudit("anonymous", { action: "sign-in", result: "failed" }, 0);
    expect(lines()).toHaveLength(2);
    expect(mode(auditPath())).toBe(0o600);
    expect(keys(0)).toEqual(["time", "by", "action", "result", "userId"]);
    expect(keys(1)).toEqual(["time", "by", "action", "result"]);
    for (const l of lines()) expect(AuditEntrySchema.safeParse(JSON.parse(l)).success).toBe(true);
  });

  it("writeAudit inside the lock throws, and appendAuditLocked needs the lock", () => {
    const event = { action: "sign-in", result: "failed" } as const;
    expect(() => withAuthLock(() => writeAudit("anonymous", event))).toThrow();
    expect(() => appendAuditLocked("anonymous", event)).toThrow();
    expect(existsSync(auditPath())).toBe(false);
    withAuthLock(() => appendAuditLocked("anonymous", event));
    expect(lines()).toHaveLength(1);
  });

  it("writes target and detail in order", () => {
    withAuthLock(() => {
      const log = prepareAuditLocked(id(), { action: "sign-in", result: "ok", target: "t", detail: "d" });
      try {
        log.write();
      } finally {
        log.close();
      }
    });
    expect(keys(0)).toEqual(["time", "by", "action", "result", "target", "detail"]);
  });

  it("accepts the good shapes", () => {
    expect(ok({ by: id(), result: "ok", userId: id() })).toBe(true);
    expect(ok({})).toBe(true);
    expect(ok({ target: "abc" })).toBe(true);
    expect(ok({ target: "abc", detail: "x".repeat(500) })).toBe(true);
    expect(ok({ by: "cli" })).toBe(true);
  });

  it("refuses the bad shapes", () => {
    const bad: Record<string, unknown>[] = [
      { result: undefined },
      { result: "maybe" },
      { userId: id(), target: "t" },
      { userId: "nope" },
      { detail: "d" },
      { userId: id(), detail: "d" },
      { target: "" },
      { target: "x".repeat(TARGET_MAX + 1) },
      { target: "a\nb" },
      { target: " a" },
      { target: "a", detail: "x".repeat(501) },
      { email: "a@example.com" },
      { stopWork: true },
      { by: "ann@example.com" },
      { action: "sign-out" },
    ];
    for (const b of bad) expect(ok(b), JSON.stringify(b)).toBe(false);
    const u = id();
    expect(AuditEntrySchema.safeParse({ time: time(), by: u, action: "create", userId: u, result: "ok" }).success).toBe(false);
    expect(AuditEntrySchema.safeParse({ time: time(), by: "anonymous", action: "create", userId: u }).success).toBe(false);
  });

  it("writeAudit refuses an invalid entry and writes nothing", () => {
    expect(() => writeAudit("ann@example.com", { action: "sign-in", result: "failed" })).toThrow();
    expect(() => writeAudit("anonymous", { action: "create", userId: id() })).toThrow();
    expect(() => writeAudit("cli", { action: "sign-in", result: "ok", detail: "x" })).toThrow();
    expect(existsSync(auditPath())).toBe(false);
  });

  it("reports a file that cannot be written, and a held lock with no wait", () => {
    mkdirSync(auditPath());
    expect(kind(() => writeAudit("anonymous", { action: "sign-in", result: "failed" }))).toMatchObject({ kind: "cannot-write", message: expect.stringContaining("audit.jsonl") });
    rmSync(auditPath(), { recursive: true });
    const lock = join(home, "auth.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    const started = Date.now();
    expect(kind(() => writeAudit("anonymous", { action: "sign-in", result: "failed" }, 0))).toMatchObject({ kind: "locked" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps old lines valid and unchanged", () => {
    const u = id();
    const t = time();
    const old = [
      { time: t, by: "cli", action: "create", userId: u },
      { time: t, by: u, action: "password", userId: u },
      { time: t, by: u, action: "link", userId: u },
      { time: t, by: u, action: "edit", userId: u },
      { time: t, by: u, action: "unblock", userId: u },
      { time: t, by: u, action: "delete", userId: u },
      { time: t, by: u, action: "block", userId: u },
      { time: t, by: u, action: "block", userId: u, stopWork: true },
      { time: t, by: u, action: "role", userId: u, oldRole: "user", newRole: "admin" },
    ].map((l) => JSON.stringify(l));
    for (const l of old) expect(AuditEntrySchema.safeParse(JSON.parse(l)).success).toBe(true);
    writeFileSync(auditPath(), old.join("\n") + "\n");
    writeAudit("anonymous", { action: "sign-in", result: "failed" });
    expect(lines().slice(0, old.length)).toEqual(old);
    expect(lines()).toHaveLength(old.length + 1);
  });
});

describe("auditAction", () => {
  it("writes one line with the expected keys and mode", () => {
    const by = id();
    const log: string[] = [];
    auditAction((m) => log.push(m), by, "repo-add", "r1");
    auditAction((m) => log.push(m), by, "repo-change", "r1", "settings: a");
    const [a, b] = lines().map((l) => JSON.parse(l));
    expect(Object.keys(a).sort()).toEqual(["action", "by", "result", "target", "time"]);
    expect(Object.keys(b).sort()).toEqual(["action", "by", "detail", "result", "target", "time"]);
    expect(a.result).toBe("ok");
    expect(mode(auditPath())).toBe(0o600);
    expect(log).toEqual([]);
  });

  it("accepts every event action and not an unknown one", () => {
    const base = { time: new Date().toISOString(), by: id(), result: "ok" };
    for (const action of EVENT_ACTIONS) expect(AuditEntrySchema.safeParse({ ...base, action }).success).toBe(true);
    expect(AuditEntrySchema.safeParse({ ...base, action: "run-stop" }).success).toBe(false);
  });

  it("limits the target to TARGET_MAX", () => {
    const by = id();
    auditAction(undefined, by, "flow-publish", "x".repeat(TARGET_MAX), "1");
    expect(lines()).toHaveLength(1);
    const log: string[] = [];
    auditAction((m) => log.push(m), by, "flow-publish", "x".repeat(TARGET_MAX + 1));
    expect(lines()).toHaveLength(1);
    expect(log).toEqual(["audit: audit.jsonl not-valid (flow-publish)"]);
  });

  it("never throws and names what failed", () => {
    const log: string[] = [];
    const l = (m: string) => log.push(m);
    mkdirSync(auditPath());
    expect(() => auditAction(l, id(), "repo-add", "r")).not.toThrow();
    rmSync(auditPath(), { recursive: true });
    auditAction(l, id(), "repo-add", "a\nb");
    auditAction(l, "not-a-uuid", "repo-add", "r");
    expect(existsSync(auditPath())).toBe(false);
    const lock = join(home, "auth.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    const started = Date.now();
    auditAction(l, id(), "run-start", "r");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log).toEqual([
      "audit: audit.jsonl cannot-write (repo-add)",
      "audit: audit.jsonl not-valid (repo-add)",
      "audit: audit.jsonl not-valid (repo-add)",
      "audit: auth.lock locked (run-start)",
    ]);
    expect(() => auditAction(undefined, "x", "repo-add", "r")).not.toThrow();
  });
});

describe("changedKeys", () => {
  it("names the top-level keys that differ, sorted", () => {
    expect(changedKeys({ a: 1 }, { a: 1 })).toEqual([]);
    expect(changedKeys({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(["a"]);
    expect(changedKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(changedKeys({ a: 1, b: 2 }, {})).toEqual(["a", "b"]);
    expect(changedKeys({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    expect(changedKeys({ z: 1, m: 1 }, { z: 2, m: 2, a: 3 })).toEqual(["a", "m", "z"]);
  });
});

describe("startSession with audit", () => {
  const make = async () => {
    const u = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345" });
    return u;
  };

  it("writes no line without the option", async () => {
    const u = await make();
    expect(startSession(u.id, u.passwordHash)?.token).toBeTruthy();
    expect(existsSync(auditPath())).toBe(false);
  });

  it("writes one ok line with the option", async () => {
    const u = await make();
    const r = startSession(u.id, u.passwordHash, undefined, { audit: true })!;
    expect("auditFailed" in r).toBe(false);
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!)).toMatchObject({ by: u.id, userId: u.id, action: "sign-in", result: "ok" });
  });

  it("keeps the session when the line cannot be written", async () => {
    const u = await make();
    mkdirSync(auditPath());
    const r = startSession(u.id, u.passwordHash, undefined, { audit: true })!;
    expect(r.auditFailed).toBe(true);
    expect(findSession(r.token)).toBeTruthy();
    expect(r.user.lastSignIn).not.toBeNull();
  });

  it("writes no line for a wrong hash or a blocked account", async () => {
    const u = await make();
    expect(startSession(u.id, "scrypt$wrong", undefined, { audit: true })).toBeUndefined();
    await setStatus(u.id, "blocked");
    expect(startSession(u.id, u.passwordHash, undefined, { audit: true })).toBeUndefined();
    expect(existsSync(auditPath())).toBe(false);
  });
});
