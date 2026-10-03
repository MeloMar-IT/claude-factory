import { spawnSync } from "node:child_process";
import { randomUUID, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StoreError, withAuthLock, writeJsonFile } from "../src/auth/store.js";
import {
  createUser, findUserByEmail, getUser, hasAdmin, hashPassword, listUsers, publicUser, setPassword, setStatus, usersPath, verifyPassword, UserError,
} from "../src/auth/users.js";

const PW = "test-password-12345";
const isRoot = process.getuid?.() === 0;
let home: string;
let savedHome: string | undefined;
let goodHash: string;

beforeAll(async () => {
  goodHash = await hashPassword(PW);
});
beforeEach(() => {
  savedHome = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "users-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;
const file = () => usersPath();
const ann = (over: Record<string, unknown> = {}) => ({ name: "Ann", email: "ann@example.com", password: PW, ...over });
const record = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: "Ann",
  email: "ann@example.com",
  role: "admin",
  status: "active",
  passwordHash: goodHash,
  created: "2026-01-01T00:00:00.000Z",
  lastSignIn: null,
  ...over,
});
const put = (users: unknown[], extra: Record<string, unknown> = {}) =>
  writeFileSync(file(), JSON.stringify({ version: 1, users, ...extra }), { mode: 0o600 });
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: UserError) => e.code));

describe("password hash", () => {
  it("has the documented form", () => {
    expect(goodHash).toMatch(/^scrypt\$N=32768,r=8,p=3\$/);
    const [, , salt, key] = goodHash.split("$");
    expect(Buffer.from(salt!, "base64")).toHaveLength(16);
    expect(Buffer.from(key!, "base64")).toHaveLength(64);
  });

  it("uses a new salt every time", async () => {
    expect(await hashPassword(PW)).not.toBe(goodHash);
  });

  it("verifies the right password only", async () => {
    expect(await verifyPassword(PW, goodHash)).toBe(true);
    expect(await verifyPassword(PW + "x", goodHash)).toBe(false);
  });

  it("is false for anything that is not our form", async () => {
    const [, , salt, key] = goodHash.split("$") as [string, string, string, string];
    const mk = (params: string, s: string, k: string) => `scrypt$${params}$${s}$${k}`;
    const own = (o: { N: number; r: number; p: number }) =>
      scryptSync(PW, Buffer.from(salt, "base64"), 64, { ...o, maxmem: 64 * 1024 * 1024 }).toString("base64");
    const last = salt.slice(0, -3);
    const bad = [
      "",
      "scrypt$",
      "$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      mk("N=16384,r=8,p=3", salt, own({ N: 16384, r: 8, p: 3 })),
      mk("N=32768,r=4,p=3", salt, own({ N: 32768, r: 4, p: 3 })),
      mk("N=32768,r=8,p=1", salt, own({ N: 32768, r: 8, p: 1 })),
      mk("N=32768,r=8,p=3", Buffer.alloc(8).toString("base64"), key),
      mk("N=32768,r=8,p=3", salt, Buffer.alloc(32).toString("base64")),
      mk("N=32768,r=8,p=3", salt, ""),
      goodHash.replace(/==$/, ""),
      goodHash.replace(/\+/g, "-").replace(/\//g, "_") + "x",
      // a different last character that decodes to the same bytes is not canonical
      mk("N=32768,r=8,p=3", last + (salt[salt.length - 3] === "A" ? "B" : "A") + "==", key),
      goodHash + "$extra",
    ];
    for (const h of bad) expect(await verifyPassword(PW, h), h).toBe(false);
  });
});

describe("createUser", () => {
  it("rejects bad input and creates nothing", async () => {
    expect(await code(createUser(ann({ name: "" })))).toBe("bad-name");
    expect(await code(createUser(ann({ name: "x".repeat(101) })))).toBe("bad-name");
    expect(await code(createUser(ann({ name: "a\nb" })))).toBe("bad-name");
    for (const email of ["a@b", "a b@c.de", `${"x".repeat(250)}@b.de`]) expect(await code(createUser(ann({ email })))).toBe("bad-email");
    expect(await code(createUser(ann({ password: "x".repeat(9) })))).toBe("bad-password");
    expect(await code(createUser(ann({ password: "x".repeat(201) })))).toBe("bad-password");
    expect(readdirSync(home)).toEqual([]);
  });

  it("normalises the e-mail and refuses a duplicate in another case", async () => {
    const u = await createUser(ann({ email: "  Ann@Example.COM " }));
    expect(u.email).toBe("ann@example.com");
    expect(await code(createUser(ann({ email: "ANN@example.com" })))).toBe("email-taken");
    expect(listUsers()).toHaveLength(1);
    expect(findUserByEmail("ANN@EXAMPLE.com")?.id).toBe(u.id);
    expect(getUser(u.id)?.name).toBe("Ann");
  });

  it("keeps the file at 0600 and leaves no temp file or lock", async () => {
    const u = await createUser(ann());
    expect(mode(file())).toBe(0o600);
    await setPassword(u.id, "test-other-password");
    await setStatus(u.id, "blocked");
    expect(mode(file())).toBe(0o600);
    expect(readdirSync(home)).toEqual(["users.json"]);
  });

  it("replaces a leftover temp file", async () => {
    writeFileSync(`${file()}.tmp`, "garbage", { mode: 0o644 });
    await createUser(ann());
    expect(existsSync(`${file()}.tmp`)).toBe(false);
    expect(mode(file())).toBe(0o600);
  });

  it("creates a missing data folder with 0700 and keeps an existing one", async () => {
    process.env.FACTORY_HOME = join(home, "a", "b");
    expect(listUsers()).toEqual([]);
    expect(existsSync(join(home, "a"))).toBe(false);
    await createUser(ann());
    expect(mode(join(home, "a", "b"))).toBe(0o700);
    chmodSync(join(home, "a", "b"), 0o755);
    await createUser(ann({ email: "b@example.com" }));
    expect(mode(join(home, "a", "b"))).toBe(0o755);
  });

  it("onlyIfNoAdmin", async () => {
    await createUser(ann({ role: "admin" }), { onlyIfNoAdmin: true });
    expect(await code(createUser(ann({ email: "b@example.com" }), { onlyIfNoAdmin: true }))).toBe("admin-exists");
    const u = findUserByEmail("ann@example.com")!;
    put([record({ id: u.id, status: "blocked", passwordHash: u.passwordHash, created: u.created })]);
    expect(await code(createUser(ann({ email: "c@example.com" }), { onlyIfNoAdmin: true }))).toBe("admin-exists");
  });

  it("two concurrent onlyIfNoAdmin calls make one admin", async () => {
    const r = await Promise.allSettled(["a", "b"].map((n) => createUser(ann({ email: `${n}@example.com`, role: "admin" }), { onlyIfNoAdmin: true })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(listUsers().filter((u) => u.role === "admin")).toHaveLength(1);
  });

  it("concurrent creates do not undo each other", async () => {
    await Promise.all(["a", "b", "c"].map((n) => createUser(ann({ email: `${n}@example.com` }))));
    expect(listUsers()).toHaveLength(3);
    const r = await Promise.allSettled([createUser(ann({ email: "d@example.com" })), createUser(ann({ email: "D@example.com" }))]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("accounts", () => {
  it("hasAdmin counts a blocked admin and ignores users", async () => {
    await createUser(ann());
    expect(hasAdmin()).toBe(false);
    put([record({ email: "b@example.com", status: "blocked" })]);
    expect(hasAdmin()).toBe(true);
  });

  it("a missing file gives a fresh empty list each time", () => {
    listUsers().push(record() as never);
    expect(listUsers()).toEqual([]);
    expect(hasAdmin()).toBe(false);
  });

  it("publicUser has no hash", async () => {
    expect("passwordHash" in publicUser(await createUser(ann()))).toBe(false);
  });

  it("setPassword and setStatus change the account", async () => {
    const u = await createUser(ann());
    await setPassword(u.id, "test-other-password");
    const now = getUser(u.id)!;
    expect(await verifyPassword(PW, now.passwordHash!)).toBe(false);
    expect(await verifyPassword("test-other-password", now.passwordHash!)).toBe(true);
    await setStatus(u.id, "blocked");
    expect(getUser(u.id)!.status).toBe("blocked");
    expect(await code(setStatus(randomUUID(), "blocked"))).toBe("not-found");
    expect(await code(setPassword(randomUUID(), "test-other-password"))).toBe("not-found");
  });
});

describe("invalid file", () => {
  const dup = randomUUID();
  const hashCases: [string, (h: string) => string][] = [
    ["N=16384", (h) => h.replace("N=32768", "N=16384")],
    ["r=4", (h) => h.replace("r=8", "r=4")],
    ["short salt", (h) => h.split("$").map((p, i) => (i === 2 ? Buffer.alloc(8).toString("base64") : p)).join("$")],
    ["short key", (h) => h.split("$").map((p, i) => (i === 3 ? Buffer.alloc(32).toString("base64") : p)).join("$")],
    ["no padding", (h) => h.replace(/==$/, "")],
  ];
  const cases: [string, () => void, string][] = [
    ["not JSON", () => writeFileSync(file(), "{"), "not-json"],
    ["empty file", () => writeFileSync(file(), ""), "not-json"],
    ["a directory", () => mkdirSync(file()), "unreadable"],
    ["a dangling symlink", () => symlinkSync(join(home, "nowhere.json"), file()), "unreadable"],
    ["version 2", () => put([], { version: 2 }), "wrong-format"],
    ["missing users", () => writeFileSync(file(), '{"version":1}'), "wrong-format"],
    ["extra key", () => put([record({ extra: 1 })]), "wrong-format"],
    ["non-UUID id", () => put([record({ id: "abc" })]), "wrong-format"],
    ["duplicate id", () => put([record({ id: dup }), record({ id: dup, email: "b@example.com" })]), "wrong-format at users.1.id"],
    ["duplicate e-mail", () => put([record(), record()]), "wrong-format at users.1.email"],
    ["upper-case e-mail", () => put([record({ email: "Ann@example.com" })]), "wrong-format"],
    ["unknown role", () => put([record({ role: "root" })]), "wrong-format"],
    ["unknown status", () => put([record({ status: "gone" })]), "wrong-format"],
    ["date only", () => put([record({ created: "2026-01-01" })]), "wrong-format"],
    ["bad lastSignIn", () => put([record({ lastSignIn: "yesterday" })]), "wrong-format"],
    ...hashCases.map(([n, f]): [string, () => void, string] => [`hash ${n}`, () => put([record({ passwordHash: f(goodHash) })]), "wrong-format at users.0.passwordHash"]),
  ];

  it.each(cases)("%s is an error and is not changed", async (_n, setup, expected) => {
    setup();
    const isDir = !existsSync(file()) || statSync(file()).isDirectory();
    const before = isDir ? undefined : readFileSync(file());
    const kind = expected.split(" ")[0]!;
    const check = (e: unknown) => {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe(kind);
      const m = (e as Error).message;
      expect(m).toContain(file());
      expect(m).not.toContain("ann@example.com");
      expect(m).not.toContain("scrypt$");
      if (expected.includes(" at ")) expect(m).toContain(expected.replace("wrong-format", "wrong format"));
    };
    expect(() => listUsers()).toThrow(StoreError);
    try {
      listUsers();
    } catch (e) {
      check(e);
    }
    await expect(createUser(ann({ email: "z@example.com" }))).rejects.toBeInstanceOf(StoreError);
    if (before) expect(readFileSync(file())).toEqual(before);
  });

  it.skipIf(isRoot)("mode 000 is unreadable", () => {
    put([record()]);
    chmodSync(file(), 0o000);
    expect(() => listUsers()).toThrow(expect.objectContaining({ kind: "unreadable" }));
    chmodSync(file(), 0o600);
  });
});

describe("lock", () => {
  const lock = () => join(home, "auth.lock");
  const hold = (pid: number) => {
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(pid));
  };

  it("times out with a StoreError and keeps the lock", () => {
    hold(process.pid);
    expect(() => withAuthLock(() => 1, 150)).toThrow(expect.objectContaining({ kind: "locked" }));
    expect(existsSync(lock())).toBe(true);
  });

  it("setStatus waits about 2 s and changes nothing", async () => {
    const u = await createUser(ann());
    const before = readFileSync(file());
    hold(process.pid);
    const t = Date.now();
    await expect(setStatus(u.id, "blocked")).rejects.toMatchObject({ kind: "locked" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
    expect(readFileSync(file())).toEqual(before);
  });

  it("breaks a lock whose pid is dead", async () => {
    hold(deadPid());
    await createUser(ann());
    expect(readdirSync(home)).toEqual(["users.json"]);
  });

  it("refuses to write when the lock was lost", async () => {
    await createUser(ann());
    const before = readFileSync(file());
    expect(() =>
      withAuthLock(() => {
        rmSync(lock(), { recursive: true });
        writeJsonFile(file(), { version: 1, users: [] });
      }),
    ).toThrow(expect.objectContaining({ kind: "locked" }));
    expect(readFileSync(file())).toEqual(before);
    expect(existsSync(`${file()}.tmp`)).toBe(false);
  });

  it("writeJsonFile outside withAuthLock throws", () => {
    expect(() => writeJsonFile(file(), {})).toThrow();
  });
});
