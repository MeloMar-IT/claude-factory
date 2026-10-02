import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_LIMIT, RepoError, RepoHalfSaved, addRepo, listRepos, ownsRepo, removeGithubRepo, removeRepo, removeReposLocked, reposPath, setRepoAuth } from "../src/auth/repos.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { jsonFiles } from "../src/home-migrate.js";
import { addCredentialLocked, credentialsPath, listCredentials, readSecret } from "../src/credentials/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repos-"));
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
    expect(removeRepo(ANN, a.id)).toEqual({ oldKeysLeft: 0 });
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
