import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_LIMIT, RepoError, addRepo, listRepos, ownsRepo, removeRepo, removeReposLocked, reposPath } from "../src/auth/repos.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repos-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
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

describe("the repository list", () => {
  it("adds, lists, checks and removes; lists are per user", () => {
    expect(listRepos(ANN)).toEqual([]);
    expect(addRepo(ANN, "  acme/app ")).toBe("acme/app");
    addRepo(ANN, "acme/web");
    addRepo(BOB, "other/thing");
    expect(listRepos(ANN)).toEqual(["acme/app", "acme/web"]);
    expect(listRepos(BOB)).toEqual(["other/thing"]);
    expect(ownsRepo(ANN, "ACME/App")).toBe(true);
    expect(ownsRepo(ANN, "other/thing")).toBe(false);
    removeRepo(ANN, "Acme/APP");
    expect(listRepos(ANN)).toEqual(["acme/web"]);
    removeRepo(ANN, "acme/web");
    expect(listRepos(ANN)).toEqual([]);
    expect(listRepos(BOB)).toEqual(["other/thing"]);
  });

  it("gives each error its code", () => {
    for (const bad of ["nope", "a/..", "a/.", "a/b/c", "/x", "", 5, "owner/repo", "OWNER/Repo", "-a/b", "a b/c"]) expect(code(() => addRepo(ANN, bad))).toBe("bad-name");
    addRepo(ANN, "acme/app");
    expect(code(() => addRepo(ANN, "ACME/app"))).toBe("duplicate");
    expect(code(() => removeRepo(ANN, "acme/none"))).toBe("not-found");
    expect(code(() => removeRepo(BOB, "acme/app"))).toBe("not-found");
  });

  it("allows 50 repositories and no more", () => {
    for (let i = 0; i < REPO_LIMIT; i++) addRepo(ANN, `acme/r${i}`);
    expect(code(() => addRepo(ANN, "acme/extra"))).toBe("limit");
    expect(listRepos(ANN)).toHaveLength(REPO_LIMIT);
    addRepo(BOB, "acme/r0");
  });

  it("writes the file with mode 0600", () => {
    addRepo(ANN, "acme/app");
    expect(statSync(reposPath()).mode & 0o777).toBe(0o600);
  });
});

describe("a broken repos.json", () => {
  const id = ANN;
  const wrong: [string, unknown][] = [
    ["an extra top key", { version: 1, repos: {}, more: 1 }],
    ["a wrong version", { version: 2, repos: {} }],
    ["a key that is not a UUID", { version: 1, repos: { ann: ["acme/app"] } }],
    ["a bad name", { version: 1, repos: { [id]: ["nope"] } }],
    ["the placeholder", { version: 1, repos: { [id]: ["Owner/Repo"] } }],
    ["51 names", { version: 1, repos: { [id]: Array.from({ length: 51 }, (_, i) => `acme/r${i}`) } }],
    ["two names that differ only in case", { version: 1, repos: { [id]: ["acme/app", "ACME/App"] } }],
  ];
  it.each(wrong)("gives wrong-format for %s", (_name, content) => {
    writeFileSync(reposPath(), JSON.stringify(content));
    for (const fn of [() => listRepos(id), () => ownsRepo(id, "acme/app"), () => addRepo(id, "acme/new")]) {
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

  it("removes one list and keeps the other", () => {
    addRepo(ANN, "acme/app");
    addRepo(BOB, "acme/web");
    expect(withAuthLock(() => removeReposLocked(ANN))).toBe(1);
    expect(listRepos(ANN)).toEqual([]);
    expect(listRepos(BOB)).toEqual(["acme/web"]);
  });

  it("writes nothing when the account has no list", () => {
    expect(withAuthLock(() => removeReposLocked(ANN))).toBe(0);
    expect(() => statSync(reposPath())).toThrow();
  });
});
