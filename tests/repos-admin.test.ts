import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { checkRepoSettings, validBranchName, validBranchPattern, validDocPath } from "../src/auth/repo-settings.js";
import { PERSONAL_METHODS, REPO_BOUND_METHODS, REPO_LIMIT, REPO_METHODS, RepoError, type TransferOptions, addRepo, listAllRepos, listRepos, ownsRepo, reposPath, setRepoAuth, setRepoSettings, transferRepo } from "../src/auth/repos.js";
import { StoreError } from "../src/auth/store.js";
import { TEST_PASSWORD } from "./helpers/session.js";
import { createUser, setStatus } from "../src/auth/users.js";
import { credentialsPath, listCredentials } from "../src/credentials/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repos-admin-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RepoError ? e.code : e;
  }
  return undefined;
};
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
};
const add = (user: string, url: string, extra: object = {}) => addRepo(user, { url, ...extra }, OK);
const tokenRepo = (user: string, url = "acme/app") => add(user, url, { method: "github-token", token: TOKEN });
const owners: Record<string, { id: string; status: "active" | "blocked" }> = { "bob@example.com": { id: BOB, status: "active" } };
const findOwner = (email: string) => owners[email];
const raw = () => readFileSync(reposPath(), "utf8");
const rawCreds = () => readFileSync(credentialsPath(), "utf8");
const file = () => JSON.parse(raw()) as { version: number; repos: Record<string, unknown>[] };

describe("validBranchName", () => {
  it.each(["main", "feature/x-1", "release/1.0", "user@fix", "@/x"])("accepts %s", (n) => expect(validBranchName(n)).toBe(true));
  it.each(["", "-x", "a b", "a..b", "a~b", "a:b", "a*", "a?", "a[b", "a\\b", "/a", "a/", "a.", "a//b", ".a", "a/.b", "a.lock", "HEAD", "a@{b", "a\u0007b"])(
    "refuses %j by git's rules",
    (n) => expect(validBranchName(n)).toBe(false),
  );
  it("refuses a lone @ by the choice made here", () => expect(validBranchName("@")).toBe(false));
  it("refuses 201 characters by the limit chosen here", () => {
    expect(validBranchName("a".repeat(200))).toBe(true);
    expect(validBranchName("a".repeat(201))).toBe(false);
  });
});

describe("validBranchPattern", () => {
  it.each(["*", "release/*", "fix-?", "v?.*"])("accepts %s", (p) => expect(validBranchPattern(p)).toBe(true));
  it.each(["", "rel/[ab]", "a b", "a\\*", "/*", "*/", "a..*", "-*", "*.lock", "@"])("refuses %j", (p) => expect(validBranchPattern(p)).toBe(false));
});

describe("validDocPath", () => {
  it.each(["docs/CHANGELOG.md", "README.md", "docs/User Guide.md"])("accepts %s", (p) => expect(validDocPath(p)).toBe(true));
  it.each(["/abs", "~/x", "-x", "a/../b", "./a", "a//b", "a\\b", "a\u0007b"])("refuses %j", (p) => expect(validDocPath(p)).toBe(false));
  it("refuses 301 characters", () => {
    expect(validDocPath("a".repeat(300))).toBe(true);
    expect(validDocPath("a".repeat(301))).toBe(false);
  });
});

describe("checkRepoSettings", () => {
  it("trims, drops empty entries and repeats, and drops a final slash", () => {
    expect(
      checkRepoSettings({ testCommand: "  npm test ", docs: [" docs/ ", "", "docs", "README.md"], protectedBranches: [" main ", "main", "  "], mainBranch: " main ", developBranch: " dev" }),
    ).toEqual({ testCommand: "npm test", docs: ["docs", "README.md"], protectedBranches: ["main"], mainBranch: "main", developBranch: "dev" });
  });

  it("gives {} for {} and for nulls and empty values", () => {
    expect(checkRepoSettings({})).toEqual({});
    expect(checkRepoSettings({ testCommand: null, docs: null, protectedBranches: null, mainBranch: null, developBranch: null })).toEqual({});
    expect(checkRepoSettings({ testCommand: " ", docs: [], mainBranch: "" })).toEqual({});
  });

  it.each([
    ["not an object", "x", "the settings must be an object"],
    ["null", null, "the settings must be an object"],
    ["an array", [], "the settings must be an object"],
    ["an unknown key", { nope: 1 }, "unknown setting"],
    ["a number as command", { testCommand: 5 }, "testCommand must be text"],
    ["a command with a line break", { testCommand: "a\nb" }, "one line"],
    ["a command of 501 characters", { testCommand: "a".repeat(501) }, "at most 500"],
    ["docs as a string", { docs: "docs" }, "docs must be a list"],
    ["51 entries", { docs: Array.from({ length: 51 }, (_, i) => `d${i}`) }, "at most 50"],
    ["a bad doc path", { docs: ["../x"] }, "not a path"],
    ["a bad pattern", { protectedBranches: ["a[b]"] }, '"*" matches any text, "?" one character'],
    ["a bad branch", { mainBranch: "a b" }, "valid git branch name"],
    ["a branch that is not text", { developBranch: 1 }, "developBranch must be text"],
  ])("refuses %s", (_n, input, text) => {
    expect(code(() => checkRepoSettings(input))).toBe("bad-settings");
    expect(message(() => checkRepoSettings(input))).toContain(text);
  });
});

describe("settings in the store", () => {
  const S = { testCommand: "npm test", docs: ["docs/CHANGELOG.md"], protectedBranches: ["release/*"], mainBranch: "main", developBranch: "develop" };

  it("stores settings; listAllRepos has them, listRepos and the returns of addRepo and setRepoAuth do not", () => {
    const a = add(ANN, "acme/app");
    expect("settings" in a).toBe(false);
    expect(setRepoSettings(a.id, S).repo.settings).toEqual(S);
    expect(listAllRepos()[0]!.settings).toEqual(S);
    expect(listRepos(ANN).every((r) => !("settings" in r))).toBe(true);
    const changed = setRepoAuth(ANN, a.id, { method: "github-token", token: TOKEN }, OK);
    expect("settings" in changed.repo).toBe(false);
    expect(file().repos[0]!.settings).toEqual(S);
  });

  it("setRepoAuth keeps the settings for a user name, a token and a change to none", () => {
    const a = add(ANN, "acme/app", { method: "https-token", username: "ann", token: TOKEN });
    setRepoSettings(a.id, S);
    setRepoAuth(ANN, a.id, { username: "ann2" }, OK);
    expect(file().repos[0]!.settings).toEqual(S);
    setRepoAuth(ANN, a.id, { token: TOKEN + "x" }, OK);
    expect(file().repos[0]!.settings).toEqual(S);
    setRepoAuth(ANN, a.id, { method: "none" }, OK);
    expect(file().repos[0]!.settings).toEqual(S);
  });

  it("does not write the file for the same user name on a record with settings", () => {
    const a = add(ANN, "acme/app", { method: "https-token", username: "ann", token: TOKEN });
    setRepoSettings(a.id, S);
    const text = raw();
    const mtime = statSync(reposPath()).mtimeMs;
    setRepoAuth(ANN, a.id, { username: "ann" }, OK);
    expect(raw()).toBe(text);
    expect(statSync(reposPath()).mtimeMs).toBe(mtime);
  });

  it("removes the key for {}; an unknown id is not-found; the file keeps mode 0600", () => {
    const a = add(ANN, "acme/app");
    setRepoSettings(a.id, S);
    expect(statSync(reposPath()).mode & 0o777).toBe(0o600);
    expect("settings" in setRepoSettings(a.id, {}).repo).toBe(false);
    expect("settings" in file().repos[0]!).toBe(false);
    expect(code(() => setRepoSettings("33333333-3333-4333-8333-333333333333", S))).toBe("not-found");
    expect(code(() => setRepoSettings(a.id, { nope: 1 }))).toBe("bad-settings");
  });

  it("writes a file without settings as version 2 with the same keys; a version 1 file becomes version 2 with its ids", () => {
    const a = add(ANN, "acme/app");
    expect(file().version).toBe(2);
    expect(Object.keys(file().repos[0]!).sort()).toEqual(["added", "id", "method", "owner", "url"]);
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: { [BOB]: ["acme/web"] } }));
    const id = listRepos(BOB)[0]!.id;
    setRepoSettings(id, { mainBranch: "main" });
    expect(file().version).toBe(2);
    expect(file().repos.find((r) => r.owner === BOB)!.id).toBe(id);
    expect(a.id).toBeTruthy();
  });

  it.each([
    ["empty settings", {}],
    ["an unknown settings key", { nope: "x" }],
    ["a bad branch", { mainBranch: "a b" }],
  ])("refuses a file with %s", (_n, settings) => {
    const a = add(ANN, "acme/app");
    const f = file();
    f.repos[0]!.settings = settings;
    writeFileSync(reposPath(), JSON.stringify(f));
    try {
      listRepos(ANN);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("wrong-format");
    }
    expect(a.id).toBeTruthy();
  });
});

describe("what a change reports (for the audit log)", () => {
  it("setRepoSettings names the fields that differ; setRepoAuth says whether it changed; transferRepo says whether it moved", () => {
    const a = add(ANN, "acme/app");
    expect(setRepoSettings(a.id, { testCommand: "npm test", mainBranch: "main" }).changed).toEqual(["mainBranch", "testCommand"]);
    expect(setRepoSettings(a.id, { testCommand: "npm test", mainBranch: "main" }).changed).toEqual([]);
    expect(setRepoSettings(a.id, {}).changed).toEqual(["mainBranch", "testCommand"]);
    expect(setRepoAuth(ANN, a.id, { method: "none" }, { ownerOk: () => true }).changed).toBe(false);
    expect(setRepoAuth(ANN, a.id, { url: "git@github.com:acme/app.git" }, { ownerOk: () => true }).changed).toBe(true);
    expect(transferRepo(a.id, "bob@example.com", { findOwner }).moved).toBe(true);
    expect(transferRepo(a.id, "bob@example.com", { findOwner }).moved).toBe(false);
  });
});

describe("transferRepo", () => {
  it("moves a token record to a user: method none, token gone, settings kept", () => {
    const a = tokenRepo(ANN);
    setRepoSettings(a.id, { mainBranch: "trunk" });
    const keyBefore = JSON.parse(rawCreds()).keyId;
    const r = transferRepo(a.id, "bob@example.com", { findOwner });
    expect(r.oldKeysLeft).toBe(0);
    expect(r.repo).toMatchObject({ id: a.id, owner: BOB, method: "none", settings: { mainBranch: "trunk" } });
    expect("credentialId" in r.repo || "username" in r.repo).toBe(false);
    expect(listCredentials(ANN)).toEqual([]);
    expect(JSON.parse(rawCreds()).keyId).not.toBe(keyBefore);
    expect(listRepos(ANN)).toEqual([]);
    expect(listRepos(BOB).map((x) => x.id)).toEqual([a.id]);
    expect(ownsRepo(BOB, "acme/app")).toBe(true);
    expect(ownsRepo(ANN, "acme/app")).toBe(false);
  });

  it("moves an https-token record the same way", () => {
    const a = add(ANN, "https://git.example.com/o/r", { method: "https-token", username: "ann", token: TOKEN });
    const r = transferRepo(a.id, "bob@example.com", { findOwner });
    expect(r.repo).toMatchObject({ owner: BOB, method: "none" });
    expect(listCredentials(ANN)).toEqual([]);
  });

  it("moves a token record to an admin: method none, token gone", () => {
    const a = tokenRepo(ANN);
    const admin = "44444444-4444-4444-8444-444444444444";
    const r = transferRepo(a.id, "root@example.com", { findOwner: () => ({ id: admin, status: "active" }) });
    expect(r.repo).toMatchObject({ owner: admin, method: "none" });
    expect(listCredentials(ANN)).toEqual([]);
  });

  it("moves a none record with no Keychain call", () => {
    const a = add(ANN, "acme/app");
    kc.clearLog();
    transferRepo(a.id, "bob@example.com", { findOwner });
    expect(kc.calls()).toEqual([]);
    expect(listRepos(BOB)).toHaveLength(1);
  });

  it("matches the e-mail of real accounts in any case, with spaces, and accepts a long raw text", async () => {
    const bob = await createUser({ name: "Bob", email: "bob@example.com", password: TEST_PASSWORD, role: "user" });
    const a = add(ANN, "acme/app");
    expect(transferRepo(a.id, "  BOB@Example.COM ").repo.owner).toBe(bob.id);
    const b = add(ANN, "acme/web");
    expect(transferRepo(b.id, `${" ".repeat(300)}bob@example.com${" ".repeat(300)}`).repo.owner).toBe(bob.id);
  });

  it("refuses with bad-owner for a missing e-mail", () => {
    const a = add(ANN, "acme/app");
    for (const v of [undefined, null, "", "   ", 5]) {
      expect(code(() => transferRepo(a.id, v, { findOwner }))).toBe("bad-owner");
      expect(message(() => transferRepo(a.id, v, { findOwner }))).toBe("give the e-mail of the new owner");
    }
  });

  it("refuses with bad-owner for a bad address without asking for the account", () => {
    const a = add(ANN, "acme/app");
    let asked = 0;
    const spy = () => (asked++, undefined);
    for (const v of ["not-an-email", "a b@x.io", "a\u0007@x.io", `${"a".repeat(250)}@x.io`]) {
      expect(code(() => transferRepo(a.id, v, { findOwner: spy })), v).toBe("bad-owner");
      expect(message(() => transferRepo(a.id, v, { findOwner: spy }))).toBe("that is not a valid e-mail address");
    }
    expect(asked).toBe(0);
  });

  it("refuses an unknown account, a blocked one, a full one, a duplicate and an unknown id, and changes no file", () => {
    const a = tokenRepo(ANN);
    const before = [raw(), rawCreds()];
    const same = () => expect([raw(), rawCreds()]).toEqual(before);
    expect(code(() => transferRepo(a.id, "nobody@example.com", { findOwner }))).toBe("no-owner");
    same();
    expect(code(() => transferRepo(a.id, "bob@example.com", { findOwner: () => ({ id: BOB, status: "blocked" }) }))).toBe("blocked");
    same();
    expect(code(() => transferRepo("33333333-3333-4333-8333-333333333333", "bob@example.com", { findOwner }))).toBe("not-found");
    same();
    for (let i = 0; i < REPO_LIMIT; i++) add(BOB, `acme/r${i}`);
    const full = [raw(), rawCreds()];
    expect(code(() => transferRepo(a.id, "bob@example.com", { findOwner }))).toBe("limit");
    expect([raw(), rawCreds()]).toEqual(full);
  });

  it("refuses a real blocked account", async () => {
    const bob = await createUser({ name: "Bob", email: "bob@example.com", password: TEST_PASSWORD, role: "user" });
    const a = add(ANN, "acme/app");
    await setStatus(bob.id, "blocked");
    expect(code(() => transferRepo(a.id, "bob@example.com"))).toBe("blocked");
  });

  it("refuses a repository both accounts hold in a version 1 file", () => {
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: { [ANN]: ["acme/app"], [BOB]: ["acme/app"] } }));
    const before = raw();
    expect(code(() => transferRepo(listRepos(ANN)[0]!.id, "bob@example.com", { findOwner }))).toBe("duplicate");
    expect(raw()).toBe(before);
  });

  it("changes nothing for the same owner and returns the record", () => {
    const a = add(BOB, "acme/app");
    const before = raw();
    expect(transferRepo(a.id, "bob@example.com", { findOwner }).repo).toMatchObject({ id: a.id, owner: BOB });
    expect(raw()).toBe(before);
  });

  it("does not remove or move an ordinary credential a hand-edited record names", () => {
    const a = tokenRepo(ANN);
    const f = file();
    f.repos[0]!.credentialId = "55555555-5555-4555-8555-555555555555";
    writeFileSync(reposPath(), JSON.stringify(f));
    const creds = rawCreds();
    transferRepo(a.id, "bob@example.com", { findOwner });
    expect(listCredentials(ANN)).toHaveLength(1);
    expect(listCredentials(BOB)).toEqual([]);
    expect(rawCreds()).toBe(creds);
  });

  it("changes nothing when the wipe fails", () => {
    const a = tokenRepo(ANN);
    tokenRepo(ANN, "acme/web");
    const before = [raw(), rawCreds()];
    kc.fail("find");
    expect(() => transferRepo(a.id, "bob@example.com", { findOwner })).toThrow();
    kc.fail();
    expect([raw(), rawCreds()]).toEqual(before);
  });

  it("leaves the owner and a gone token when the record write fails; the repeat finishes", () => {
    const a = tokenRepo(ANN);
    mkdirSync(`${reposPath()}.tmp`);
    expect(() => transferRepo(a.id, "bob@example.com", { findOwner })).toThrow();
    rmSync(`${reposPath()}.tmp`, { recursive: true, force: true });
    expect(listRepos(ANN)).toHaveLength(1);
    expect(listCredentials(ANN)).toEqual([]);
    expect(transferRepo(a.id, "bob@example.com", { findOwner }).repo).toMatchObject({ owner: BOB, method: "none" });
  });

  it("reports an old key that stays; the repeat to the same owner cleans it", () => {
    const a = tokenRepo(ANN);
    kc.fail("delete");
    expect(transferRepo(a.id, "bob@example.com", { findOwner }).oldKeysLeft).toBe(1);
    kc.fail();
    expect(transferRepo(a.id, "bob@example.com", { findOwner }).oldKeysLeft).toBe(0);
  });
});

describe("what a transfer does to a sign-in", () => {
  it("lists the methods: personal ones are wiped, repository-bound ones move", () => {
    expect([...PERSONAL_METHODS].sort()).toEqual(["github-token", "https-token"]);
    // Before a method is listed here, add transfer tests with a real record of it: kept for the new owner, the repeat after
    // a failed record write, and a missing credential refused with "no-credential".
    expect(REPO_BOUND_METHODS).toEqual([]);
    expect([...PERSONAL_METHODS, ...REPO_BOUND_METHODS, "none"].sort()).toEqual([...REPO_METHODS].sort());
  });

  it("takes no option that changes what happens to a credential", () => {
    expectTypeOf<keyof TransferOptions>().toEqualTypeOf<"findOwner">();
  });
});
