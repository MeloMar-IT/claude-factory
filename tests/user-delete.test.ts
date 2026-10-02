import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, reposPath } from "../src/auth/repos.js";
import { StoreError } from "../src/auth/store.js";
import { readSessions } from "../src/auth/sessions.js";
import { randomUUID } from "node:crypto";
import { createUser, deleteUser, hashPassword, listUsers, startSession, usersPath, UserError, type User } from "../src/auth/users.js";
import { KeyError } from "../src/credentials/keychain.js";
import { addCredential, credentialsPath, listCredentials, readSecret } from "../src/credentials/store.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";

const PW = "test-password-12345";
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let admin: User;
let ann: User;
let bob: User;

beforeAll(async () => void (await hashPassword(PW)));
beforeEach(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "user-delete-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  admin = await createUser({ name: "Root", email: "root@example.com", password: PW, role: "admin" });
  ann = await createUser({ name: "Ann", email: "ann@example.com", password: PW });
  bob = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const cred = (u: User, name: string, tag: string) => addCredential({ userId: u.id, type: "token", name, secret: fakeToken(tag) });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe("deleteUser", () => {
  it("removes the account, its sessions and only its credentials", () => {
    startSession(ann.id, ann.passwordHash);
    startSession(bob.id, bob.passwordHash);
    cred(ann, "a", "Aa1");
    const b = cred(bob, "b", "Bb2");
    const oldKeys = Object.keys(kc.items());
    expect(deleteUser(ann.id)).toEqual({ email: "ann@example.com", credentials: 1, oldKeysLeft: 0 });
    expect(listUsers().map((u) => u.email)).not.toContain("ann@example.com");
    expect(readSessions().map((s) => s.userId)).toEqual([bob.id]);
    expect(listCredentials(ann.id)).toEqual([]);
    expect(readSecret(bob.id, b.id)).toBe(fakeToken("Bb2"));
    expect(Object.keys(kc.items())).toHaveLength(1);
    expect(Object.keys(kc.items())).not.toEqual(oldKeys);
  });

  it("removes the repository list of the account and keeps the other one", () => {
    addRepo(ann.id, "acme/app");
    addRepo(bob.id, "acme/web");
    deleteUser(ann.id);
    expect(listRepos(ann.id)).toEqual([]);
    expect(listRepos(bob.id).map((r) => r.url)).toEqual(["https://github.com/acme/web"]);
  });

  it("removes the records and tokens of the account's repositories only", () => {
    const token = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
    addRepo(ann.id, { url: "acme/app", method: "github-token", token });
    addRepo(bob.id, { url: "acme/web", method: "github-token", token });
    const bobRepo = listRepos(bob.id)[0]!;
    expect(deleteUser(ann.id).credentials).toBe(1);
    expect(listRepos(ann.id)).toEqual([]);
    expect(listCredentials(ann.id)).toEqual([]);
    expect(readSecret(bob.id, bobRepo.credentialId!)).toBe(token);
  });

  it("stops before anything else when repos.json cannot be read, and works once it is fixed", () => {
    startSession(ann.id, ann.passwordHash);
    cred(ann, "a", "Aa1");
    writeFileSync(reposPath(), "not json");
    const users = readFileSync(usersPath());
    expect(code(() => deleteUser(ann.id))).toBeInstanceOf(StoreError);
    expect(readFileSync(usersPath())).toEqual(users);
    expect(readSessions().filter((s) => s.userId === ann.id)).toHaveLength(1);
    expect(listCredentials(ann.id)).toHaveLength(1);
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: {} }));
    expect(deleteUser(ann.id).credentials).toBe(1);
  });

  it("reports an unknown account", () => {
    expect(code(() => deleteUser("00000000-0000-4000-8000-000000000000"))).toMatchObject({ code: "not-found" });
  });

  it("refuses the only admin, and allows it when there is another", async () => {
    const before = readFileSync(usersPath());
    expect(code(() => deleteUser(admin.id))).toMatchObject({ code: "last-admin" });
    expect(readFileSync(usersPath())).toEqual(before);
    await createUser({ name: "Two", email: "two@example.com", password: PW, role: "admin" });
    expect(deleteUser(admin.id).credentials).toBe(0);
  });

  it("stops on an invalid credentials file and leaves users.json alone", () => {
    cred(ann, "a", "Aa1");
    writeFileSync(credentialsPath(), "not json");
    const before = readFileSync(usersPath());
    expect(code(() => deleteUser(ann.id))).toBeInstanceOf(StoreError);
    expect(readFileSync(usersPath())).toEqual(before);
  });

  it("keeps the account and its credentials when the Keychain fails (sessions are gone)", () => {
    startSession(ann.id, ann.passwordHash);
    cred(ann, "a", "Aa1");
    cred(bob, "b", "Bb2");
    kc.fail("find");
    expect(code(() => deleteUser(ann.id))).toBeInstanceOf(KeyError);
    kc.fail();
    expect(listUsers().map((u) => u.id)).toContain(ann.id);
    expect(listCredentials(ann.id)).toHaveLength(1);
    expect(readSessions().filter((s) => s.userId === ann.id)).toEqual([]);
  });

  it("can be finished after users.json could not be written", () => {
    startSession(ann.id, ann.passwordHash);
    cred(ann, "a", "Aa1");
    mkdirSync(usersPath() + ".tmp");
    expect(code(() => deleteUser(ann.id))).toBeInstanceOf(StoreError);
    expect(listUsers().map((u) => u.id)).toContain(ann.id);
    expect(readSessions()).toEqual([]);
    expect(listCredentials(ann.id)).toEqual([]);
    rmSync(usersPath() + ".tmp", { recursive: true });
    expect(deleteUser(ann.id).credentials).toBe(0);
    expect(listUsers().map((u) => u.id)).not.toContain(ann.id);
    expect(existsSync(usersPath())).toBe(true);
    expect(UserError).toBeDefined();
  });
});

describe("deleteUser and the last admin and the audit log", () => {
  const auditFile = () => join(home, "audit.jsonl");
  const auditLines = () => (existsSync(auditFile()) ? readFileSync(auditFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

  it("writes one `delete` line with the account id", () => {
    deleteUser(ann.id, { by: "cli" });
    expect(auditLines()).toEqual([expect.objectContaining({ action: "delete", by: "cli", userId: ann.id })]);
  });

  it("an unwritable log stops the delete before anything changes", () => {
    startSession(ann.id, ann.passwordHash);
    cred(ann, "a", "Aa1");
    mkdirSync(auditFile());
    const users = readFileSync(usersPath());
    const err = code(() => deleteUser(ann.id, { by: "cli" })) as StoreError;
    expect(err).toBeInstanceOf(StoreError);
    expect(err.kind).toBe("cannot-write");
    expect(readFileSync(usersPath())).toEqual(users);
    expect(readSessions()).toHaveLength(1);
    expect(listCredentials(ann.id)).toHaveLength(1);
    rmSync(auditFile(), { recursive: true });
    expect(deleteUser(ann.id, { by: "cli" }).credentials).toBe(1);
    expect(auditLines()).toHaveLength(1);
  });

  it("no line when the account is not found or is the last admin", () => {
    expect((code(() => deleteUser(randomUUID(), { by: "cli" })) as UserError).code).toBe("not-found");
    expect((code(() => deleteUser(admin.id, { by: "cli" })) as UserError).code).toBe("last-admin");
    expect(auditLines()).toHaveLength(0);
  });

  it("a blocked second admin does not help, and a blocked admin can be deleted", () => {
    const file = JSON.parse(readFileSync(usersPath(), "utf8")) as { users: User[] };
    const second = { ...admin, id: randomUUID(), email: "second@example.com", status: "blocked" };
    writeFileSync(usersPath(), JSON.stringify({ ...file, users: [...file.users, second] }), { mode: 0o600 });
    const before = readFileSync(usersPath());
    expect((code(() => deleteUser(admin.id)) as UserError).code).toBe("last-admin");
    expect(readFileSync(usersPath())).toEqual(before);
    deleteUser(second.id);
    expect(listUsers().map((u) => u.id)).not.toContain(second.id);
  });

  it("keeps the runs of the account", () => {
    mkdirSync(join(home, "runs", "r1"), { recursive: true });
    const run = join(home, "runs", "r1", "run.json");
    writeFileSync(run, JSON.stringify({ runId: "r1", owner: ann.id }));
    const before = readFileSync(run);
    deleteUser(ann.id, { by: "cli" });
    expect(readFileSync(run)).toEqual(before);
  });
});
