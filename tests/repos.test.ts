import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_LIMIT, RepoError, RepoHalfSaved, addRepo, getRepo, listRepos, ownsRepo, readRepoSecret, removeGithubRepo, removeRepo, removeReposLocked, removeUserCredential, reposPath, setRepoAuth, setRepoConnection, setRepoSettings, transferRepo } from "../src/auth/repos.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { jsonFiles } from "../src/home-migrate.js";
import { createUser, deleteUser, hashPassword } from "../src/auth/users.js";
import { PUBLIC_KEY_RE, KeygenError } from "../src/credentials/ssh-keygen.js";
import { addCredential, addCredentialLocked, credentialsPath, listCredentials, readSecret, removeCredential } from "../src/credentials/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let kg: FakeKeygen;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repos-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  kg = fakeKeygen();
});
afterEach(() => {
  kg.remove();
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
const add = (user: string, url: string, extra: object = {}) => addRepo(user, { url, ...extra }, OK);
const urls = (user: string) => listRepos(user).map((r) => r.url);
/** The credentials that no record names. */
const orphans = (user: string) => {
  const named = new Set(listRepos(user).map((r) => r.credentialId));
  return listCredentials(user).filter((c) => !named.has(c.id));
};

describe("the repository list", () => {
  it("adds, lists, checks and removes; lists are per user", () => {
    expect(listRepos(ANN)).toEqual([]);
    const a = add(ANN, "  acme/app ");
    expect(a).toMatchObject({ owner: ANN, url: "https://github.com/acme/app", method: "none" });
    expect(Object.keys(a).sort()).toEqual(["added", "id", "method", "owner", "url"]);
    add(ANN, "acme/web");
    add(BOB, "git@gitlab.com:other/thing.git");
    expect(urls(ANN)).toEqual(["https://github.com/acme/app", "https://github.com/acme/web"]);
    expect(urls(BOB)).toEqual(["git@gitlab.com:other/thing.git"]);
    expect(ownsRepo(ANN, "ACME/App")).toBe(true);
    expect(ownsRepo(ANN, "acme/app.git")).toBe(true);
    expect(ownsRepo(ANN, "other/thing")).toBe(false);
    expect(ownsRepo(BOB, "other/thing")).toBe(false);
    removeRepo(ANN, a.id);
    expect(urls(ANN)).toEqual(["https://github.com/acme/web"]);
    expect(urls(BOB)).toHaveLength(1);
  });

  it("owns a GitHub repository added in the ssh form, not one on another host", () => {
    add(ANN, "git@github.com:acme/app.git");
    add(ANN, "https://gitlab.com/acme/web");
    expect(ownsRepo(ANN, "acme/app")).toBe(true);
    expect(ownsRepo(ANN, "acme/web")).toBe(false);
  });

  it("gives each error its code", () => {
    for (const bad of ["nope", "a/..", "file:///x", "/tmp/x", "owner/repo", "https://u:p@github.com/a/b"]) expect(code(() => add(ANN, bad)), bad).toBe("bad-url");
    const a = add(ANN, "acme/app");
    for (const same of ["ACME/app", "acme/app.git", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app"]) expect(code(() => add(ANN, same)), same).toBe("duplicate");
    expect(code(() => add(BOB, "https://github.com/ACME/App.git"))).toBe("taken");
    expect(code(() => removeRepo(ANN, "00000000-0000-4000-8000-000000000000"))).toBe("not-found");
    expect(code(() => removeRepo(BOB, a.id))).toBe("not-found");
    expect(code(() => removeGithubRepo(BOB, "acme/app"))).toBe("not-found");
  });

  it("refuses an account that does not exist and writes nothing", () => {
    expect(code(() => addRepo(ANN, { url: "acme/app", method: "github-token", token: TOKEN }, { ownerOk: () => false }))).toBe("no-owner");
    expect(code(() => addRepo(ANN, "acme/app", { ownerOk: () => false }))).toBe("no-owner");
    expect(() => statSync(reposPath())).toThrow();
    expect(kc.calls()).toEqual([]);
  });

  it("allows 50 repositories and no more", () => {
    for (let i = 0; i < REPO_LIMIT; i++) add(ANN, `acme/r${i}`);
    expect(code(() => add(ANN, "acme/extra"))).toBe("limit");
    expect(listRepos(ANN)).toHaveLength(REPO_LIMIT);
    add(BOB, "acme/other");
  });

  it("writes the file with mode 0600", () => {
    add(ANN, "acme/app");
    expect(statSync(reposPath()).mode & 0o777).toBe(0o600);
  });
});

describe("authentication methods", () => {
  it("stores a github-token in the credential store and keeps only its id", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    expect(r.method).toBe("github-token");
    expect(listCredentials(ANN).map((c) => [c.id, c.name])).toEqual([[r.credentialId, `repo:${r.id}`]]);
    expect(readSecret(ANN, r.credentialId!)).toBe(TOKEN);
    const text = readFileSync(reposPath(), "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from(TOKEN).toString("base64"));
  });

  it("keeps the user name of an https-token", () => {
    const r = add(ANN, "https://git.example.com/a/b", { method: "https-token", username: "ann", token: TOKEN });
    expect(r).toMatchObject({ method: "https-token", username: "ann" });
    expect(readSecret(ANN, r.credentialId!)).toBe(TOKEN);
  });

  const badAuth: [string, string, object][] = [
    ["an unknown method", "acme/app", { method: "magic", token: TOKEN }],
    ["github-token on another host", "https://gitlab.com/a/b", { method: "github-token", token: TOKEN }],
    ["github-token on an ssh url", "git@github.com:acme/app", { method: "github-token", token: TOKEN }],
    ["a classic token", "acme/app", { method: "github-token", token: "ghp_" + "Zx9".repeat(12) }],
    ["github-token with a user name", "acme/app", { method: "github-token", username: "ann", token: TOKEN }],
    ["https-token without a user name", "https://h.example.com/a", { method: "https-token", token: TOKEN }],
    ["https-token with a colon in the name", "https://h.example.com/a", { method: "https-token", username: "a:b", token: TOKEN }],
    ["https-token with a space in the name", "https://h.example.com/a", { method: "https-token", username: "a b", token: TOKEN }],
    ["https-token on ssh", "ssh://h.example.com/a", { method: "https-token", username: "ann", token: TOKEN }],
    ["a short token", "https://h.example.com/a", { method: "https-token", username: "ann", token: "short" }],
    ["no token", "acme/app", { method: "github-token" }],
    ["none with a token", "acme/app", { method: "none", token: TOKEN }],
    ["a token without a method", "acme/app", { token: TOKEN }],
  ];
  it.each(badAuth)("refuses %s and changes nothing", (_n, url, extra) => {
    expect(code(() => add(ANN, url, extra))).toBe("bad-auth");
    expect(() => statSync(reposPath())).toThrow();
    expect(() => statSync(credentialsPath())).toThrow();
    expect(kc.calls()).toEqual([]);
  });
});

describe("setRepoAuth", () => {
  it("replaces only the token when only a token is given", () => {
    const r = add(ANN, "https://git.example.com/a/b", { method: "https-token", username: "ann", token: TOKEN });
    const keyBefore = JSON.parse(readFileSync(credentialsPath(), "utf8")).keyId;
    const { repo } = setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK);
    expect(repo).toMatchObject({ id: r.id, added: r.added, method: "https-token", username: "ann" });
    expect(repo.credentialId).not.toBe(r.credentialId);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8")).keyId).not.toBe(keyBefore);
    expect(listCredentials(ANN).map((c) => c.id)).toEqual([repo.credentialId]);
    expect(readSecret(ANN, repo.credentialId!)).toBe(TOKEN2);
  });

  it("changes the user name without touching the token or the Keychain", () => {
    const r = add(ANN, "https://git.example.com/a/b", { method: "https-token", username: "ann", token: TOKEN });
    kc.clearLog();
    const before = readFileSync(credentialsPath(), "utf8");
    const { repo } = setRepoAuth(ANN, r.id, { username: "ann2" }, OK);
    expect(repo).toMatchObject({ username: "ann2", credentialId: r.credentialId });
    expect(readFileSync(credentialsPath(), "utf8")).toBe(before);
    expect(kc.calls()).toEqual([]);
  });

  it("changes the address to another form of the same repository only", () => {
    const r = add(ANN, "acme/app");
    expect(setRepoAuth(ANN, r.id, { url: "git@github.com:acme/app.git" }, OK).repo.url).toBe("git@github.com:acme/app.git");
    expect(code(() => setRepoAuth(ANN, r.id, { url: "acme/other" }, OK))).toBe("bad-url");
    const t = add(ANN, "acme/web", { method: "github-token", token: TOKEN });
    expect(code(() => setRepoAuth(ANN, t.id, { url: "git@github.com:acme/web" }, OK))).toBe("bad-auth");
    expect(listRepos(ANN).find((x) => x.id === t.id)?.url).toBe("https://github.com/acme/web");
  });

  it("needs a token for a new method, and something to change", () => {
    const r = add(ANN, "acme/app");
    expect(code(() => setRepoAuth(ANN, r.id, { method: "github-token" }, OK))).toBe("bad-auth");
    expect(code(() => setRepoAuth(ANN, r.id, {}, OK))).toBe("bad-auth");
    expect(code(() => setRepoAuth(ANN, r.id, { token: TOKEN }, OK))).toBe("bad-auth");
  });

  it("moves between methods and back to none", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    const h = setRepoAuth(ANN, r.id, { method: "https-token", username: "ann", token: TOKEN2 }, OK).repo;
    expect(h).toMatchObject({ method: "https-token", username: "ann" });
    expect(listCredentials(ANN)).toHaveLength(1);
    const n = setRepoAuth(ANN, r.id, { method: "none" }, OK).repo;
    expect(n).toEqual({ id: r.id, owner: ANN, url: r.url, method: "none", added: r.added });
    expect(listCredentials(ANN)).toEqual([]);
  });

  it("answers not-found for another account's id", () => {
    const r = add(ANN, "acme/app");
    expect(code(() => setRepoAuth(BOB, r.id, { token: TOKEN }, OK))).toBe("not-found");
  });

  it("repairs a record whose token was removed through the credential store", async () => {
    const { removeCredential } = await import("../src/credentials/store.js");
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    removeCredential(ANN, r.credentialId!);
    expect(setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK).repo.credentialId).toBeDefined();
    const r2 = add(ANN, "acme/web", { method: "github-token", token: TOKEN });
    removeCredential(ANN, r2.credentialId!);
    removeRepo(ANN, r2.id);
    expect(orphans(ANN)).toEqual([]);
  });
});

describe("removeRepo", () => {
  it("wipes the token and replaces the key; another account's token still reads", () => {
    const a = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    const b = add(BOB, "acme/web", { method: "github-token", token: TOKEN2 });
    const keyBefore = JSON.parse(readFileSync(credentialsPath(), "utf8")).keyId;
    expect(removeRepo(ANN, a.id)).toMatchObject({ oldKeysLeft: 0, removed: { id: a.id, url: "https://github.com/acme/app" } });
    expect(listCredentials(ANN)).toEqual([]);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8")).keyId).not.toBe(keyBefore);
    expect(readSecret(BOB, b.credentialId!)).toBe(TOKEN2);
  });

  it("reports an old key that stays in the Keychain, and the record is gone", () => {
    const a = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    add(ANN, "acme/web", { method: "github-token", token: TOKEN2 });
    kc.fail("delete");
    expect(removeRepo(ANN, a.id).oldKeysLeft).toBe(1);
    expect(urls(ANN)).toEqual(["https://github.com/acme/web"]);
  });

  const retired = () => JSON.parse(readFileSync(credentialsPath(), "utf8")).retiredKeyIds as string[];

  it("a retry of a removal that left an old key cleans it", () => {
    const a = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    add(ANN, "acme/web", { method: "github-token", token: TOKEN2 });
    kc.fail("delete");
    expect(removeRepo(ANN, a.id).oldKeysLeft).toBe(1);
    kc.fail();
    expect(retired()).toHaveLength(1);
    expect(code(() => removeRepo(ANN, a.id))).toBe("not-found");
    expect(retired()).toEqual([]);
    expect(Object.keys(kc.items())).toHaveLength(1);
  });

  it("does not report an old key that the save of the new token removed on its own retry", () => {
    const a = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    add(ANN, "acme/web", { method: "github-token", token: TOKEN2 });
    process.env.FAKE_KEYCHAIN_FAIL_ONCE = "delete";
    try {
      expect(setRepoAuth(ANN, a.id, { token: TOKEN2 + "x" }, OK).oldKeysLeft).toBe(0);
    } finally {
      delete process.env.FAKE_KEYCHAIN_FAIL_ONCE;
    }
    expect(retired()).toEqual([]);
    expect(Object.keys(kc.items())).toHaveLength(1);
  });

  it("a retry of a change to none cleans an old key left by the first try", () => {
    const a = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    add(ANN, "acme/web", { method: "github-token", token: TOKEN2 });
    kc.fail("delete");
    expect(setRepoAuth(ANN, a.id, { method: "none" }, OK).oldKeysLeft).toBe(1);
    kc.fail();
    expect(setRepoAuth(ANN, a.id, { method: "none" }, OK).oldKeysLeft).toBe(0);
    expect(retired()).toEqual([]);
    expect(Object.keys(kc.items())).toHaveLength(1);
  });

  it("never wipes a credential of the user's own", () => {
    const a = add(ANN, "acme/app");
    withAuthLock(() => addCredentialLocked({ id: "33333333-3333-4333-8333-333333333333", userId: ANN, type: "token", name: `repo:${a.id}`, secret: TOKEN }));
    removeRepo(ANN, a.id);
    expect(listCredentials(ANN)).toHaveLength(1);
    const b = add(ANN, "acme/web");
    withAuthLock(() => addCredentialLocked({ id: "44444444-4444-4444-8444-444444444444", userId: ANN, type: "token", name: `repo:${b.id}`, secret: TOKEN }));
    expect(code(() => setRepoAuth(ANN, b.id, { method: "github-token", token: TOKEN2 }, OK))).toBe("bad-auth");
    expect(listCredentials(ANN)).toHaveLength(2);
    expect(listRepos(ANN)[0]!.method).toBe("none");
  });

  it("leaves an ordinary credential alone when a record points at it", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    const own = withAuthLock(() => addCredentialLocked({ id: "55555555-5555-4555-8555-555555555555", userId: ANN, type: "token", name: "mine", secret: TOKEN2 }));
    const file = JSON.parse(readFileSync(reposPath(), "utf8"));
    file.repos[0].credentialId = own.id;
    writeFileSync(reposPath(), JSON.stringify(file));
    removeRepo(ANN, r.id);
    expect(listCredentials(ANN).map((c) => c.name)).toContain("mine");
  });
});

describe("failures at every write", () => {
  const tmpAsFolder = () => mkdirSync(`${reposPath()}.tmp`);
  const clearTmp = () => rmSync(`${reposPath()}.tmp`, { recursive: true, force: true });

  it("add: the first write fails, nothing changes", () => {
    tmpAsFolder();
    expect(code(() => add(ANN, "acme/app", { method: "github-token", token: TOKEN }))).toBeInstanceOf(StoreError);
    clearTmp();
    expect(kc.calls()).toEqual([]);
    expect(add(ANN, "acme/app", { method: "github-token", token: TOKEN }).method).toBe("github-token");
  });

  it("add: saving the token fails, the record is taken back", () => {
    kc.fail("add");
    expect(code(() => add(ANN, "acme/app", { method: "github-token", token: TOKEN }))).toBeTruthy();
    kc.fail();
    expect(listRepos(ANN)).toEqual([]);
    expect(() => statSync(credentialsPath())).toThrow();
    add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    expect(orphans(ANN)).toEqual([]);
  });

  it("change: the wipe fails, nothing changes", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    add(ANN, "acme/web", { method: "github-token", token: TOKEN2 });
    const before = [readFileSync(reposPath(), "utf8"), readFileSync(credentialsPath(), "utf8")];
    kc.fail("find");
    expect(code(() => setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK))).toBeTruthy();
    kc.fail();
    expect([readFileSync(reposPath(), "utf8"), readFileSync(credentialsPath(), "utf8")]).toEqual(before);
  });

  it("change: the record write fails after the wipe; the repeat stores the token", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    tmpAsFolder();
    expect(code(() => setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK))).toBeInstanceOf(StoreError);
    clearTmp();
    expect(listCredentials(ANN)).toEqual([]);
    expect(listRepos(ANN)[0]!.credentialId).toBe(r.credentialId);
    const again = setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK).repo;
    expect(readSecret(ANN, again.credentialId!)).toBe(TOKEN2);
  });

  it("change: saving the new token fails; the record names a missing token and the repeat works", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    kc.fail("add");
    expect(code(() => setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK))).toBeTruthy();
    kc.fail();
    expect(listCredentials(ANN)).toEqual([]);
    const again = setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK).repo;
    expect(orphans(ANN)).toEqual([]);
    expect(readSecret(ANN, again.credentialId!)).toBe(TOKEN2);
  });

  it("remove: the record write fails after the wipe; the repeat removes it", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    tmpAsFolder();
    expect(code(() => removeRepo(ANN, r.id))).toBeInstanceOf(StoreError);
    clearTmp();
    expect(listRepos(ANN)).toHaveLength(1);
    removeRepo(ANN, r.id);
    expect(listRepos(ANN)).toEqual([]);
  });

  it("add: the token and the undo both fail; the record is listed and a new token repairs it", () => {
    kc.remove();
    const dir = mkdtempSync(join(tmpdir(), "bad-security-"));
    const bin = join(dir, "security");
    writeFileSync(bin, `#!/bin/sh\nmkdir "${reposPath()}.tmp"\nexit 1\n`, { mode: 0o755 });
    process.env.SCF_SECURITY_BIN = bin;
    try {
      expect(code(() => add(ANN, "acme/app", { method: "github-token", token: TOKEN }))).toBeInstanceOf(RepoHalfSaved);
    } finally {
      delete process.env.SCF_SECURITY_BIN;
      clearTmp();
      rmSync(dir, { recursive: true, force: true });
    }
    kc = fakeKeychain();
    const [r] = listRepos(ANN);
    expect(r).toMatchObject({ method: "github-token" });
    expect(listCredentials(ANN)).toEqual([]);
    const fixed = setRepoAuth(ANN, r!.id, { token: TOKEN }, OK).repo;
    expect(readSecret(ANN, fixed.credentialId!)).toBe(TOKEN);
  });
});

describe("version 1 of repos.json", () => {
  const v1 = (repos: Record<string, string[]>) => writeFileSync(reposPath(), JSON.stringify({ version: 1, repos }));

  it("loads as records with the method none, the same ids on every read", () => {
    v1({ [ANN]: ["acme/app", "acme/web"] });
    const a = listRepos(ANN);
    expect(a.map((r) => [r.url, r.method])).toEqual([["https://github.com/acme/app", "none"], ["https://github.com/acme/web", "none"]]);
    expect(listRepos(ANN).map((r) => r.id)).toEqual(a.map((r) => r.id));
    expect(a[0]!.added).toBe(statSync(reposPath()).mtime.toISOString());
  });

  it("keeps a name that two accounts hold", () => {
    v1({ [ANN]: ["acme/app"], [BOB]: ["acme/app"] });
    expect(urls(ANN)).toEqual(urls(BOB));
    expect(code(() => add(ANN, "acme/app"))).toBe("duplicate");
  });

  it("keeps acme/app, acme/app.git and acme/.git as three records", () => {
    v1({ [ANN]: ["acme/app", "acme/app.git", "acme/.git"] });
    const l = listRepos(ANN);
    expect(new Set(l.map((r) => r.id)).size).toBe(3);
    for (const n of ["acme/app", "acme/app.git", "acme/.git"]) expect(ownsRepo(ANN, n)).toBe(true);
    expect(code(() => add(ANN, "acme/app"))).toBe("duplicate");
    removeGithubRepo(ANN, "acme/app.git");
    expect(urls(ANN)).toEqual(["https://github.com/acme/app", "https://github.com/acme/.git"]);
    removeGithubRepo(ANN, "acme/app");
    expect(urls(ANN)).toEqual(["https://github.com/acme/.git"]);
  });

  it("removes the only record of the same repository by another spelling", () => {
    v1({ [ANN]: ["acme/app.git"] });
    removeGithubRepo(ANN, "ACME/App");
    expect(listRepos(ANN)).toEqual([]);
  });

  it("writes version 2 on the first change and keeps the ids", () => {
    v1({ [ANN]: ["acme/app"] });
    const ids = listRepos(ANN).map((r) => r.id);
    add(ANN, "acme/web");
    expect(JSON.parse(readFileSync(reposPath(), "utf8")).version).toBe(2);
    expect(listRepos(ANN).map((r) => r.id).slice(0, 1)).toEqual(ids);
  });

  it("removeReposLocked writes version 2 without the account, and nothing when there are no records", () => {
    v1({ [ANN]: ["acme/app"], [BOB]: ["acme/web"] });
    expect(withAuthLock(() => removeReposLocked(ANN))).toBe(1);
    expect(JSON.parse(readFileSync(reposPath(), "utf8")).version).toBe(2);
    expect(urls(BOB)).toEqual(["https://github.com/acme/web"]);
    const before = readFileSync(reposPath(), "utf8");
    expect(withAuthLock(() => removeReposLocked(ANN))).toBe(0);
    expect(readFileSync(reposPath(), "utf8")).toBe(before);
  });
});

describe("a broken repos.json", () => {
  const id = ANN;
  const rec = (extra: object = {}) => ({ id: BOB, owner: id, url: "https://github.com/acme/app", method: "none", added: "2026-10-01T10:00:00.000Z", ...extra });
  const v2 = (...repos: object[]) => ({ version: 2, repos });
  const wrong: [string, unknown][] = [
    ["an extra top key", { version: 1, repos: {}, more: 1 }],
    ["a wrong version", { version: 3, repos: [] }],
    ["a key that is not a UUID", { version: 1, repos: { ann: ["acme/app"] } }],
    ["a bad name", { version: 1, repos: { [id]: ["nope"] } }],
    ["the placeholder", { version: 1, repos: { [id]: ["Owner/Repo"] } }],
    ["51 names", { version: 1, repos: { [id]: Array.from({ length: 51 }, (_, i) => `acme/r${i}`) } }],
    ["two names that differ only in case", { version: 1, repos: { [id]: ["acme/app", "ACME/App"] } }],
    ["v2: an extra key", v2(rec({ more: 1 }))],
    ["v2: a repeated id", v2(rec(), rec({ url: "https://github.com/acme/web" }))],
    ["v2: 51 records of one owner", v2(...Array.from({ length: 51 }, (_, i) => rec({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, url: `https://github.com/acme/r${i}` })))],
    ["v2: a url with a user name", v2(rec({ url: "https://ann@github.com/acme/app" }))],
    ["v2: a url not in stored form", v2(rec({ url: "acme/app" }))],
    ["v2: github-token without a credential", v2(rec({ method: "github-token" }))],
    ["v2: none with a credential", v2(rec({ credentialId: ANN }))],
    ["v2: https-token on ssh", v2(rec({ url: "ssh://git@host/a", method: "https-token", credentialId: ANN, username: "ann" }))],
    ["v2: a user name with a colon", v2(rec({ url: "https://host/a", method: "https-token", credentialId: ANN, username: "a:b" }))],
    ["v2: a user name with a space", v2(rec({ url: "https://host/a", method: "https-token", credentialId: ANN, username: "a b" }))],
  ];
  it.each(wrong)("gives wrong-format for %s", (_name, content) => {
    writeFileSync(reposPath(), JSON.stringify(content));
    for (const fn of [() => listRepos(id), () => ownsRepo(id, "acme/app"), () => add(id, "acme/new")]) {
      const e = code(fn);
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("wrong-format");
    }
  });

  it("gives not-json for text that is not JSON", () => {
    writeFileSync(reposPath(), "{");
    expect((code(() => listRepos(id)) as StoreError).kind).toBe("not-json");
  });
});

describe("removeReposLocked", () => {
  it("throws outside the lock", () => {
    expect(() => removeReposLocked(ANN)).toThrow("inside withAuthLock");
  });

  it("removes one account's records and keeps the other", () => {
    add(ANN, "acme/app");
    add(BOB, "acme/web");
    expect(withAuthLock(() => removeReposLocked(ANN))).toBe(1);
    expect(listRepos(ANN)).toEqual([]);
    expect(urls(BOB)).toEqual(["https://github.com/acme/web"]);
  });

  it("writes nothing when the account has no records", () => {
    expect(withAuthLock(() => removeReposLocked(ANN))).toBe(0);
    expect(() => statSync(reposPath())).toThrow();
  });
});

describe("the data-folder move", () => {
  it("does not list a top-level repos.json, but lists one inside a run", () => {
    mkdirSync(join(home, "runs", "x"), { recursive: true });
    writeFileSync(join(home, "repos.json"), "{}");
    writeFileSync(join(home, "runs", "x", "repos.json"), "{}");
    expect(jsonFiles(home)).toEqual([join(home, "runs", "x", "repos.json")]);
  });
});

describe("the SSH deploy key", () => {
  const SSH = "git@github.com:acme/app.git";
  const deploy = (user: string, url = SSH) => add(user, url, { method: "ssh-deploy-key" });
  const lastPair = () => kg.pairs().at(-1)!;
  const keyCreds = (user: string) => listCredentials(user).filter((c) => c.type === "ssh-key");

  it.each([SSH, "ssh://git@host.example.com/a/b"])("adds one for %s: a record, a key credential, no private key in the file", (url) => {
    const r = deploy(ANN, url);
    expect(Object.keys(r).sort()).toEqual(["added", "credentialId", "id", "method", "owner", "publicKey", "url"]);
    expect(r.publicKey).toMatch(PUBLIC_KEY_RE);
    expect(listCredentials(ANN).map((c) => [c.type, c.name, c.id])).toEqual([["ssh-key", `repo:${r.id}`, r.credentialId]]);
    expect(readSecret(ANN, r.credentialId!)).toBe(lastPair().privateKey);
    expect(r.publicKey).toBe(lastPair().publicKey);
    const text = readFileSync(reposPath(), "utf8");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(lastPair().privateKey.split("\n")[1]!);
    expect(listRepos(ANN)).toEqual([r]);
  });

  const bad: [string, string, object][] = [
    ["an https address", "https://github.com/acme/app", {}],
    ["a name", "acme/app", {}],
    ["a token", SSH, { token: TOKEN }],
    ["a user name", SSH, { username: "ann" }],
  ];
  it.each(bad)("refuses a deploy key with %s", (_n, url, extra) => {
    const e = (() => {
      try {
        add(ANN, url, { method: "ssh-deploy-key", ...extra });
      } catch (x) {
        return x;
      }
      return undefined;
    })();
    expect(e).toBeInstanceOf(RepoError);
    expect((e as RepoError).code).toBe("bad-auth");
    if (Object.keys(extra).length === 0) expect((e as RepoError).message).toContain("SSH address");
    expect(() => statSync(reposPath())).toThrow();
    expect(() => statSync(credentialsPath())).toThrow();
    expect(kg.calls()).toEqual([]);
  });

  describe("changing", () => {
    it("token to deploy key with an SSH address", () => {
      const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
      const next = setRepoAuth(ANN, r.id, { method: "ssh-deploy-key", url: SSH }, OK).repo;
      expect(next).toMatchObject({ method: "ssh-deploy-key", url: SSH });
      expect(next.publicKey).toMatch(PUBLIC_KEY_RE);
      expect(next).not.toHaveProperty("username");
      expect(listCredentials(ANN).map((c) => [c.type, c.id])).toEqual([["ssh-key", next.credentialId]]);
      expect(listRepos(ANN)).toEqual([next]);
    });

    it("an https address is refused for a deploy key", () => {
      const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
      expect(code(() => setRepoAuth(ANN, r.id, { method: "ssh-deploy-key" }, OK))).toBe("bad-auth");
      const d = deploy(BOB, "git@github.com:acme/web.git");
      expect(code(() => setRepoAuth(BOB, d.id, { url: "https://github.com/acme/web" }, OK))).toBe("bad-auth");
      expect(listRepos(BOB)).toEqual([d]);
    });

    it("deploy key to a token", () => {
      const r = deploy(ANN);
      const next = setRepoAuth(ANN, r.id, { method: "github-token", url: "https://github.com/acme/app", token: TOKEN }, OK).repo;
      expect(next).not.toHaveProperty("publicKey");
      expect(listCredentials(ANN).map((c) => [c.type, c.id])).toEqual([["token", next.credentialId]]);
      expect(listRepos(ANN)).toEqual([next]);
    });

    it("deploy key to none", () => {
      const r = deploy(ANN);
      const next = setRepoAuth(ANN, r.id, { method: "none" }, OK).repo;
      expect(next).toMatchObject({ method: "none" });
      expect(next).not.toHaveProperty("publicKey");
      expect(next).not.toHaveProperty("credentialId");
      expect(listCredentials(ANN)).toEqual([]);
    });

    it("newKey makes a new pair and removes the old key", () => {
      const r = deploy(ANN);
      const keyId = Object.keys(kc.items())[0];
      const next = setRepoAuth(ANN, r.id, { newKey: true }, OK).repo;
      expect(next.publicKey).not.toBe(r.publicKey);
      expect(next.publicKey).toBe(lastPair().publicKey);
      expect(next.credentialId).not.toBe(r.credentialId);
      expect(listCredentials(ANN).map((c) => c.id)).toEqual([next.credentialId]);
      expect(Object.keys(kc.items())).toHaveLength(1);
      expect(Object.keys(kc.items())[0]).not.toBe(keyId);
      expect(readSecret(ANN, next.credentialId!)).toBe(lastPair().privateKey);
      expect(kg.pairs()).toHaveLength(2);
    });

    it("the same method again makes no key and touches no file", () => {
      const r = deploy(ANN);
      const before = [readFileSync(reposPath(), "utf8"), readFileSync(credentialsPath(), "utf8")];
      kc.clearLog();
      const out = setRepoAuth(ANN, r.id, { method: "ssh-deploy-key" }, OK);
      expect(out).toEqual({ repo: r, oldKeysLeft: 0, changed: false });
      expect(kg.calls()).toHaveLength(1);
      expect(kc.calls()).toEqual([]);
      expect([readFileSync(reposPath(), "utf8"), readFileSync(credentialsPath(), "utf8")]).toEqual(before);
    });

    it("refuses newKey on a token record and a newKey that is not true", () => {
      const t = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
      expect(code(() => setRepoAuth(ANN, t.id, { newKey: true }, OK))).toBe("bad-auth");
      const d = deploy(BOB, "git@github.com:acme/web.git");
      expect(code(() => setRepoAuth(BOB, d.id, { newKey: "yes" }, OK))).toBe("bad-auth");
      expect(code(() => setRepoAuth(BOB, d.id, { newKey: false }, OK))).toBe("bad-auth");
      expect(kg.calls()).toHaveLength(1);
    });

    it("an SSH to SSH address change keeps the key", () => {
      const r = deploy(ANN);
      const next = setRepoAuth(ANN, r.id, { url: "ssh://git@github.com/acme/app" }, OK).repo;
      expect(next).toMatchObject({ url: "ssh://git@github.com/acme/app", publicKey: r.publicKey, credentialId: r.credentialId });
      expect(kg.calls()).toHaveLength(1);
      expect(readSecret(ANN, r.credentialId!)).toBe(lastPair().privateKey);
    });
  });

  describe("repair with the method again", () => {
    const repaired = (id: string, user = ANN) => {
      const before = kg.pairs().length;
      const next = setRepoAuth(user, id, { method: "ssh-deploy-key" }, OK).repo;
      expect(kg.pairs()).toHaveLength(before + 1);
      expect(next.publicKey).toBe(lastPair().publicKey);
      expect(readSecret(user, next.credentialId!)).toBe(lastPair().privateKey);
      return next;
    };

    it("a key that is missing", () => {
      const r = deploy(ANN);
      removeCredential(ANN, r.credentialId!);
      const next = repaired(r.id);
      expect(keyCreds(ANN)).toHaveLength(1);
      expect(orphans(ANN)).toEqual([]);
      expect(next.credentialId).not.toBe(r.credentialId);
    });

    it("a credential of the wrong type under the same id and name", () => {
      const r = deploy(ANN);
      removeCredential(ANN, r.credentialId!);
      withAuthLock(() => addCredentialLocked({ id: r.credentialId!, userId: ANN, type: "token", name: `repo:${r.id}`, secret: TOKEN }));
      repaired(r.id);
      expect(listCredentials(ANN).map((c) => c.type)).toEqual(["ssh-key"]);
      expect(orphans(ANN)).toEqual([]);
    });

    it("a record that points at a credential with another name", () => {
      const r = deploy(ANN);
      removeCredential(ANN, r.credentialId!);
      const own = withAuthLock(() => addCredentialLocked({ id: "55555555-5555-4555-8555-555555555555", userId: ANN, type: "token", name: "mine", secret: TOKEN2 }));
      const file = JSON.parse(readFileSync(reposPath(), "utf8"));
      file.repos[0].credentialId = own.id;
      writeFileSync(reposPath(), JSON.stringify(file));
      repaired(r.id);
      expect(listCredentials(ANN).map((c) => c.name).sort()).toEqual(["mine", `repo:${r.id}`]);
      expect(orphans(ANN).map((c) => c.name)).toEqual(["mine"]);
    });
  });

  describe("removing and deleting", () => {
    it("removeRepo deletes the key and leaves another account's secret", () => {
      const mine = deploy(ANN);
      const bob = add(BOB, "acme/web", { method: "github-token", token: TOKEN });
      removeRepo(ANN, mine.id);
      expect(listCredentials(ANN)).toEqual([]);
      expect(readSecret(BOB, bob.credentialId!)).toBe(TOKEN);
    });

    it("deleting the account removes its records and keys, not Bob's", async () => {
      const pw = "test-password-12345";
      await hashPassword(pw);
      await createUser({ name: "Root", email: "root@example.com", password: pw, role: "admin" });
      const user = await createUser({ name: "Ann", email: "ann@example.com", password: pw });
      deploy(user.id);
      const bob = deploy(BOB, "git@github.com:acme/web.git");
      deleteUser(user.id);
      expect(listRepos(user.id)).toEqual([]);
      expect(listCredentials(user.id)).toEqual([]);
      expect(readSecret(BOB, bob.credentialId!)).toBe(lastPair().privateKey);
    });
  });

  describe("failures", () => {
    const tmpAsFolder = () => mkdirSync(`${reposPath()}.tmp`);
    const clearTmp = () => rmSync(`${reposPath()}.tmp`, { recursive: true, force: true });
    const files = () => [readFileSync(reposPath(), "utf8"), readFileSync(credentialsPath(), "utf8")];

    it("a failed keygen on add changes nothing", () => {
      kg.fail("exit");
      expect(code(() => deploy(ANN))).toBeInstanceOf(KeygenError);
      expect(() => statSync(reposPath())).toThrow();
      expect(() => statSync(credentialsPath())).toThrow();
      expect(kc.calls()).toEqual([]);
    });

    it("a failed keygen on change changes nothing", () => {
      const r = deploy(ANN);
      const before = files();
      kc.clearLog();
      kg.fail("no-public");
      expect(code(() => setRepoAuth(ANN, r.id, { newKey: true }, OK))).toBeInstanceOf(KeygenError);
      expect(files()).toEqual(before);
      expect(kc.calls()).toEqual([]);
    });

    it("saving the key fails on add: the record is taken back", () => {
      kc.fail("add");
      expect(code(() => deploy(ANN))).toBeTruthy();
      kc.fail();
      expect(listRepos(ANN)).toEqual([]);
      expect(() => statSync(credentialsPath())).toThrow();
    });

    it("saving the new key fails: the record names a missing key and the repeat stores one", () => {
      const r = deploy(ANN);
      kc.fail("add");
      expect(code(() => setRepoAuth(ANN, r.id, { newKey: true }, OK))).toBeTruthy();
      kc.fail();
      expect(listCredentials(ANN)).toEqual([]);
      const next = setRepoAuth(ANN, r.id, { method: "ssh-deploy-key" }, OK).repo;
      expect(readSecret(ANN, next.credentialId!)).toBe(lastPair().privateKey);
      expect(keyCreds(ANN)).toHaveLength(1);
    });

    it("an old Keychain key that cannot be deleted is reported and cleaned by the repeat", () => {
      const r = deploy(ANN);
      deploy(ANN, "git@github.com:acme/web.git");
      kc.fail("delete");
      const out = setRepoAuth(ANN, r.id, { newKey: true }, OK);
      kc.fail();
      expect(out.oldKeysLeft).toBe(1);
      const pairs = kg.pairs().length;
      expect(setRepoAuth(ANN, r.id, { method: "ssh-deploy-key" }, OK).oldKeysLeft).toBe(0);
      expect(kg.pairs()).toHaveLength(pairs);
    });

    it("the record write fails after the wipe: the old record stays and the repeat makes a new key", () => {
      const r = deploy(ANN);
      tmpAsFolder();
      expect(code(() => setRepoAuth(ANN, r.id, { newKey: true }, OK))).toBeInstanceOf(StoreError);
      clearTmp();
      expect(listCredentials(ANN)).toEqual([]);
      expect(listRepos(ANN)).toEqual([r]);
      expect(orphans(ANN)).toEqual([]);
      const next = setRepoAuth(ANN, r.id, { method: "ssh-deploy-key" }, OK).repo;
      expect(keyCreds(ANN)).toHaveLength(1);
      expect(readSecret(ANN, next.credentialId!)).toBe(lastPair().privateKey);
    });
  });

  describe("a broken file", () => {
    const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "k".repeat(43);
    const base = { id: BOB, owner: ANN, added: "2026-10-01T10:00:00.000Z" };
    const dk = (extra: object = {}) => ({ ...base, url: SSH, method: "ssh-deploy-key", credentialId: ANN, publicKey: PUB, ...extra });
    const wrong: [string, object][] = [
      ["no public key", dk({ publicKey: undefined })],
      ["a bad public key", dk({ publicKey: "ssh-rsa AAAA" })],
      ["an https address", dk({ url: "https://github.com/acme/app" })],
      ["a user name", dk({ username: "ann" })],
      ["no credential", dk({ credentialId: undefined })],
      ["a public key on a token record", { ...base, url: "https://github.com/acme/app", method: "github-token", credentialId: ANN, publicKey: PUB }],
      ["a public key on a none record", { ...base, url: "https://github.com/acme/app", method: "none", publicKey: PUB }],
    ];
    it.each(wrong)("gives wrong-format for %s", (_n, record) => {
      writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [record] }));
      const e = code(() => listRepos(ANN));
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("wrong-format");
    });

    it("reads a good record", () => {
      writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [dk()] }));
      expect(listRepos(ANN)[0]).toMatchObject({ method: "ssh-deploy-key", publicKey: PUB });
    });
  });
});

describe("the connection status", () => {
  const SSH_URL = "git@github.com:acme/key.git";
  const result = (ok = true) => ({
    at: new Date().toISOString(),
    ok,
    checks: [{ check: "clone" as const, ok, code: ok ? "ok" : "failed", message: "A fixed sentence." }],
  });
  const tested = (url = "https://github.com/acme/app") => {
    const r = add(ANN, url, { method: "github-token", token: TOKEN });
    expect(setRepoConnection(getRepo(r.id)!, result())).toBe("saved");
    return r;
  };
  const connection = (id: string) => getRepo(id)?.connection;
  const findOwner = () => ({ id: BOB, status: "active" as const });

  it("setRepoConnection saves the result and listRepos shows it", () => {
    const r = add(ANN, "https://github.com/acme/app", { method: "github-token", token: TOKEN });
    const res = result(false);
    expect(setRepoConnection(getRepo(r.id)!, res)).toBe("saved");
    expect(listRepos(ANN)[0]!.connection).toEqual(res);
  });

  it("answers gone for a removed record and changed for a changed one, and writes nothing", () => {
    const r = tested();
    const rec = getRepo(r.id)!;
    setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK);
    const before = readFileSync(reposPath(), "utf8");
    expect(setRepoConnection(rec, result(false))).toBe("changed");
    expect(readFileSync(reposPath(), "utf8")).toBe(before);
    removeRepo(ANN, r.id);
    const after = readFileSync(reposPath(), "utf8");
    expect(setRepoConnection(rec, result())).toBe("gone");
    expect(readFileSync(reposPath(), "utf8")).toBe(after);
  });

  it("answers changed when the credential is gone, and writes nothing", () => {
    const r = add(ANN, "https://github.com/acme/app", { method: "github-token", token: TOKEN });
    const rec = getRepo(r.id)!;
    removeCredential(ANN, r.credentialId!);
    const before = readFileSync(reposPath(), "utf8");
    expect(setRepoConnection(rec, result())).toBe("changed");
    expect(readFileSync(reposPath(), "utf8")).toBe(before);
  });

  it("throws on a wrong value and writes nothing", () => {
    const r = add(ANN, "https://github.com/acme/app", { method: "github-token", token: TOKEN });
    const before = readFileSync(reposPath(), "utf8");
    const rec = getRepo(r.id)!;
    expect(() => setRepoConnection(rec, { ...result(), checks: [] })).toThrow();
    expect(() => setRepoConnection(rec, { ...result(), at: "yesterday" })).toThrow();
    expect(() => setRepoConnection(rec, { ...result(), extra: 1 } as never)).toThrow();
    expect(readFileSync(reposPath(), "utf8")).toBe(before);
  });

  it("setRepoAuth clears it for a new token, key, method or address form, and keeps it for no change", () => {
    const r = tested();
    setRepoAuth(ANN, r.id, { method: "github-token" }, OK);
    expect(connection(r.id)).toBeDefined();
    setRepoAuth(ANN, r.id, { url: "https://github.com/acme/app" }, OK);
    expect(connection(r.id)).toBeDefined();
    setRepoAuth(ANN, r.id, { token: TOKEN2 }, OK);
    expect(connection(r.id)).toBeUndefined();

    setRepoConnection(getRepo(r.id)!, result());
    setRepoAuth(ANN, r.id, { url: "https://github.com/ACME/app" }, OK);
    expect(connection(r.id)).toBeUndefined();

    setRepoConnection(getRepo(r.id)!, result());
    setRepoAuth(ANN, r.id, { method: "https-token", username: "ann", token: TOKEN }, OK);
    expect(connection(r.id)).toBeUndefined();

    const k = add(ANN, SSH_URL, { method: "ssh-deploy-key" });
    setRepoConnection(getRepo(k.id)!, result());
    setRepoAuth(ANN, k.id, { method: "ssh-deploy-key" }, OK);
    expect(connection(k.id)).toBeDefined();
    setRepoAuth(ANN, k.id, { newKey: true }, OK);
    expect(connection(k.id)).toBeUndefined();

    setRepoConnection(getRepo(k.id)!, result());
    setRepoAuth(ANN, k.id, { method: "none" }, OK);
    expect(connection(k.id)).toBeUndefined();
  });

  it("transferRepo clears it and setRepoSettings keeps it", () => {
    const r = tested();
    setRepoSettings(r.id, { mainBranch: "trunk" });
    expect(connection(r.id)).toBeDefined();
    transferRepo(r.id, "bob@example.com", { findOwner });
    expect(connection(r.id)).toBeUndefined();
    const k = add(ANN, SSH_URL, { method: "ssh-deploy-key" });
    setRepoConnection(getRepo(k.id)!, result());
    transferRepo(k.id, "bob@example.com", { findOwner });
    expect(connection(k.id)).toBeUndefined();
  });

  describe("removeUserCredential", () => {
    it("clears the status when the repository's own credential goes, and only that one", () => {
      const r = tested();
      const other = tested("https://github.com/acme/other");
      expect(removeUserCredential(ANN, r.credentialId!).removed).toBe(1);
      expect(connection(r.id)).toBeUndefined();
      expect(connection(other.id)).toBeDefined();
      expect(listCredentials(ANN).map((c) => c.id)).toEqual([other.credentialId]);
    });

    it("keeps every status when another credential of the user goes", () => {
      const r = tested();
      const c = addCredential({ userId: ANN, type: "token", name: "mine", secret: TOKEN2 }, OK);
      expect(removeUserCredential(ANN, c.id).removed).toBe(1);
      expect(connection(r.id)).toBeDefined();
    });

    it("does nothing for an id that is not the user's", () => {
      const r = tested();
      const before = readFileSync(reposPath(), "utf8");
      expect(removeUserCredential(BOB, r.credentialId!).removed).toBe(0);
      expect(readFileSync(reposPath(), "utf8")).toBe(before);
      expect(listCredentials(ANN)).toHaveLength(1);
    });
  });

  describe("readRepoSecret", () => {
    it("returns the token or the key and sets lastUsed", () => {
      const r = add(ANN, "https://github.com/acme/app", { method: "github-token", token: TOKEN });
      expect(listCredentials(ANN)[0]!.lastUsed).toBeNull();
      expect(readRepoSecret(getRepo(r.id)!)).toBe(TOKEN);
      expect(listCredentials(ANN)[0]!.lastUsed).toBeTruthy();
      const k = add(ANN, SSH_URL, { method: "ssh-deploy-key" });
      expect(readRepoSecret(getRepo(k.id)!)).toBeTruthy();
    });

    it("throws no-credential when the credential is gone or of another type", () => {
      const r = add(ANN, "https://github.com/acme/app", { method: "github-token", token: TOKEN });
      const rec = getRepo(r.id)!;
      expect(code(() => readRepoSecret({ ...rec, method: "ssh-deploy-key" }))).toBe("no-credential");
      removeCredential(ANN, r.credentialId!);
      expect(code(() => readRepoSecret(rec))).toBe("no-credential");
    });

    it("throws no-credential when the read does not find the credential", () => {
      const r = add(ANN, "https://github.com/acme/app", { method: "github-token", token: TOKEN });
      const rec = getRepo(r.id)!;
      // listed for the owner, but the read is for another user: readSecret reports not-found
      expect(code(() => readRepoSecret({ ...rec, owner: BOB }))).toBe("no-credential");
    });
  });

  describe("the file", () => {
    const base = { id: BOB, owner: ANN, url: "https://github.com/acme/app", method: "none", added: "2026-10-01T10:00:00.000Z" };
    const good = { at: "2026-10-01T10:00:00.000Z", ok: true, checks: [{ check: "clone", ok: true, code: "ok", message: "Fine." }] };
    const wrong: [string, unknown][] = [
      ["no checks", { ...good, checks: [] }],
      ["an unknown check", { ...good, checks: [{ ...good.checks[0], check: "ping" }] }],
      ["no time", { ok: true, checks: good.checks }],
      ["a text instead of an object", "ok"],
    ];
    it.each(wrong)("gives wrong-format for %s", (_n, connection) => {
      writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [{ ...base, connection }] }));
      const e = code(() => listRepos(ANN));
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("wrong-format");
    });

    it("loads a record with the field and one without", () => {
      writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [{ ...base, connection: good }] }));
      expect(listRepos(ANN)[0]!.connection).toEqual(good);
      writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [base] }));
      expect(listRepos(ANN)[0]!.connection).toBeUndefined();
    });
  });
});
