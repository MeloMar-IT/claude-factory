import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditEntrySchema, auditPath, prepareAuditLocked, type AuditEvent } from "../src/auth/audit.js";
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

  it("refuses invalid entries", () => {
    const bad: unknown[] = [
      { action: "block", userId: id(), oldRole: "user", newRole: "admin" },
      { action: "role", userId: id() },
      { action: "edit", userId: id() },
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
