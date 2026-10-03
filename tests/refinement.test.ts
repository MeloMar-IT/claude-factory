import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, removeRepo } from "../src/auth/repos.js";
import { StoreError, authLockHeld, withAuthLock } from "../src/auth/store.js";
import { createUser, deleteUser, hashPassword, type User } from "../src/auth/users.js";
import { jsonFiles } from "../src/home-migrate.js";
import {
  DROP_KEEP_MS,
  RefinementError,
  checkRefinements,
  createSession,
  dropSession,
  getSession,
  listSessions,
  purgeDropped,
  refinementsPath,
  removeRefinementsLocked,
  renameSession,
  restoreSession,
} from "../src/refinement/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
// close to the real clock, because calls without `now` use it
const T0 = new Date();
const at = (ms: number) => ({ now: () => new Date(T0.getTime() + ms) });
const owner = (id: string) => ({ id, admin: false });
const admin = { id: ADMIN, admin: true };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-"));
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
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};
const make = (o = ANN, extra: object = {}, opts = {}) => createSession(o, { repo: "acme/app", idea: "An idea", ...extra }, { ...OK, ...at(0), ...opts });
const file = () => readFileSync(refinementsPath(), "utf8");
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};

describe("create", () => {
  it("starts exploring with one log entry", () => {
    const s = make();
    expect(s).toMatchObject({ owner: ANN, repo: "acme/app", state: "exploring", drafts: [], title: "An idea", idea: "An idea" });
    expect(s.log).toEqual([{ at: T0.toISOString(), by: ANN, what: "created" }]);
    expect(s.created).toBe(s.updated);
    expect(JSON.parse(file()).version).toBe(1);
    expect(statSync(refinementsPath()).mode & 0o777).toBe(0o600);
  });

  it("makes the title", () => {
    expect(make(ANN, { title: "  Mine  " }).title).toBe("Mine");
    expect(make(ANN, { title: "  ", idea: "\n\n First line \nsecond" }).title).toBe("First line");
    expect(make(ANN, { idea: "x".repeat(300) }).title).toBe("x".repeat(120));
    expect(make(ANN, { idea: "a\tb" }).title).toBe("a b");
    expect(make(ANN, { idea: "a\r\nb" }).idea).toBe("a\nb");
  });

  it("refuses bad input and writes nothing", () => {
    for (const idea of [undefined, 5, "   ", "x".repeat(10_001), "a\u0001b"]) expect(code(() => make(ANN, { idea }))).toBe("bad-idea");
    for (const title of ["x".repeat(121), "a\u0001b", 5]) expect(code(() => make(ANN, { title }))).toBe("bad-title");
    for (const repo of ["nope", 5]) expect(code(() => make(ANN, { repo }))).toBe("bad-repo");
    expect(existsSync(refinementsPath())).toBe(false);
  });

  it("checks the account and the repository under the lock", () => {
    const seen: boolean[] = [];
    expect(code(() => make(ANN, {}, { ownerOk: () => (seen.push(authLockHeld()), false) }))).toBe("no-owner");
    expect(code(() => make(ANN, {}, { repoName: () => (seen.push(authLockHeld()), undefined) }))).toBe("not-yours");
    expect(seen).toEqual([true, true]);
    expect(existsSync(refinementsPath())).toBe(false);
    expect(make(ANN, { repo: "ACME/App.git" }, { repoName: () => "acme/app" }).repo).toBe("acme/app");
  });

  it("limits the sessions of one owner", () => {
    const sessions = Array.from({ length: 200 }, (_, i) => {
      const s = make(ANN, {}, at(i));
      return s;
    });
    expect(sessions).toHaveLength(200);
    expect(code(() => make(ANN))).toBe("limit");
    expect(make(BOB).owner).toBe(BOB);
    // one dropped session that is past its 30 days frees a place
    dropSession(owner(ANN), sessions[0]!.id, at(10));
    expect(code(() => make(ANN))).toBe("limit");
    expect(make(ANN, {}, at(10 + DROP_KEEP_MS)).owner).toBe(ANN);
  });

  it("lists newest change first", () => {
    const a = make(ANN, {}, at(1));
    const b = make(ANN, {}, at(2));
    expect(listSessions().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(getSession("nope")).toBeUndefined();
    expect(listSessions(BOB)).toEqual([]);
  });
});

describe("default checks", () => {
  let kc: FakeKeychain;
  let ann: User;
  let bob: User;
  beforeAll(async () => void (await hashPassword("test-password-12345")));
  beforeEach(async () => {
    kc = fakeKeychain();
    ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345", role: "admin" });
    bob = await createUser({ name: "Bob", email: "bob@example.com", password: "test-password-12345" });
  });
  afterEach(() => kc.remove());
  afterAll(() => {});

  it("uses the account and the repository record", () => {
    const rec = addRepo(ann.id, "acme/app");
    addRepo(ann.id, "https://gitlab.com/acme/web");
    addRepo(bob.id, "other/thing");
    expect(createSession(ann.id, { repo: "ACME/App.git", idea: "x" }).repo).toBe("acme/app");
    expect(code(() => createSession(ann.id, { repo: "acme/web", idea: "x" }))).toBe("not-yours");
    expect(code(() => createSession(ann.id, { repo: "other/thing", idea: "x" }))).toBe("not-yours");
    removeRepo(ann.id, rec.id);
    expect(code(() => createSession(ann.id, { repo: "acme/app", idea: "x" }))).toBe("not-yours");
    addRepo(bob.id, "bob/own");
    deleteUser(bob.id);
    expect(code(() => createSession(bob.id, { repo: "bob/own", idea: "x" }))).toBe("no-owner");
  });
});

describe("rename, drop, restore", () => {
  it("renames", () => {
    const s = make(ANN, {}, at(0));
    const r = renameSession(owner(ANN), s.id, " New ", at(5));
    expect(r.title).toBe("New");
    expect(r.updated).toBe(new Date(T0.getTime() + 5).toISOString());
    expect(r.log.at(-1)).toMatchObject({ what: "renamed", detail: "New", by: ANN });
    const before = file();
    renameSession(owner(ANN), s.id, "New", at(9));
    expect(file()).toBe(before);
    expect(code(() => renameSession(owner(BOB), s.id, "x"))).toBe("not-found");
    expect(code(() => renameSession(admin, s.id, "x"))).toBe("not-owner");
    expect(code(() => renameSession(owner(ANN), s.id, "  "))).toBe("bad-title");
    dropSession(owner(ANN), s.id, at(10));
    expect(code(() => renameSession(owner(ANN), s.id, "y"))).toBe("bad-state");
  });

  it("drops and restores", () => {
    const s = make(ANN, {}, at(0));
    const d = dropSession(owner(ANN), s.id, at(5));
    expect(d).toMatchObject({ state: "dropped", stateBefore: "exploring", droppedAt: new Date(T0.getTime() + 5).toISOString() });
    expect(code(() => dropSession(owner(ANN), s.id))).toBe("bad-state");
    expect(code(() => restoreSession(admin, s.id))).toBe("not-owner");
    expect(code(() => restoreSession(owner(BOB), s.id))).toBe("not-found");
    const r = restoreSession(owner(ANN), s.id, at(6));
    expect(r.state).toBe("exploring");
    const stored = JSON.parse(file()).sessions[0];
    expect(stored).not.toHaveProperty("stateBefore");
    expect(stored).not.toHaveProperty("droppedAt");
    expect(r.log.map((l) => l.what)).toEqual(["created", "dropped", "restored"]);
    expect(code(() => restoreSession(owner(ANN), s.id))).toBe("bad-state");
  });

  it("lets an admin drop another's session", () => {
    const s = make(ANN);
    const d = dropSession(admin, s.id, at(1));
    expect(d.log.at(-1)).toMatchObject({ what: "dropped", by: ADMIN });
    expect(code(() => dropSession(owner(BOB), make(ANN).id))).toBe("not-found");
  });
});

describe("thirty days", () => {
  it("removes a dropped session at the limit", () => {
    const s = make(ANN);
    dropSession(owner(ANN), s.id, at(0));
    expect(getSession(s.id, at(DROP_KEEP_MS - 1))).toBeDefined();
    expect(listSessions(ANN, at(DROP_KEEP_MS - 1))).toHaveLength(1);
    expect(getSession(s.id, at(DROP_KEEP_MS))).toBeUndefined();
    expect(listSessions(ANN, at(DROP_KEEP_MS))).toEqual([]);
    expect(code(() => restoreSession(owner(ANN), s.id, at(DROP_KEEP_MS)))).toBe("not-found");
    expect(purgeDropped(at(DROP_KEEP_MS))).toBe(1);
    expect(JSON.parse(file()).sessions).toEqual([]);
  });

  it("a write for another session also removes it", () => {
    const s = make(ANN);
    const other = make(BOB);
    dropSession(owner(ANN), s.id, at(0));
    renameSession(owner(BOB), other.id, "Later", at(DROP_KEEP_MS));
    expect(JSON.parse(file()).sessions.map((x: any) => x.id)).toEqual([other.id]);
  });

  it("purges nothing from a missing file and creates no lock", () => {
    expect(purgeDropped()).toBe(0);
    expect(existsSync(refinementsPath())).toBe(false);
    expect(existsSync(join(home, "auth.lock"))).toBe(false);
  });
});

describe("the log", () => {
  it("loses nothing and stops when full", () => {
    const s = make();
    for (let i = 0; i < 20; i++) renameSession(owner(ANN), s.id, `T${i}`);
    const got = getSession(s.id)!;
    expect(got.log).toHaveLength(21);
    expect(got.log[0]!.what).toBe("created");

    edit((f) => {
      f.sessions[0].log = Array.from({ length: 999 }, () => ({ at: T0.toISOString(), by: ANN, what: "renamed", detail: "x" }));
    });
    const bytes = file();
    expect(code(() => renameSession(owner(ANN), s.id, "Another"))).toBe("limit");
    expect(file()).toBe(bytes);
    expect(dropSession(owner(ANN), s.id).log).toHaveLength(1000);
    expect(code(() => restoreSession(owner(ANN), s.id))).toBe("limit");
    edit((f) => f.sessions[0].log.push({ at: T0.toISOString(), by: ANN, what: "renamed" }));
    expect(() => listSessions()).toThrow(StoreError);
  });
});

describe("a broken file", () => {
  it("is not JSON", () => {
    writeFileSync(refinementsPath(), "nope");
    const kind = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof StoreError ? e.kind : e;
      }
    };
    expect(kind(() => listSessions())).toBe("not-json");
    expect(kind(() => make())).toBe("not-json");
    expect(kind(() => checkRefinements())).toBe("not-json");
  });

  it("has the wrong format", () => {
    const s = make();
    dropSession(owner(ANN), make().id);
    const good = JSON.parse(file());
    const cases: ((f: any) => void)[] = [
      (f) => (f.extra = 1),
      (f) => (f.version = 2),
      (f) => (f.sessions[1].id = f.sessions[0].id),
      (f) => delete f.sessions[1].droppedAt,
      (f) => (f.sessions[0].droppedAt = T0.toISOString()),
      (f) => (f.sessions[0].drafts = [{}]),
      (f) => (f.sessions[0].repo = "nope"),
      (f) => (f.sessions[0].state = "unknown"),
    ];
    for (const c of cases) {
      const f = structuredClone(good);
      c(f);
      writeFileSync(refinementsPath(), JSON.stringify(f));
      try {
        listSessions();
        expect.unreachable();
      } catch (e) {
        expect((e as StoreError).kind).toBe("wrong-format");
      }
    }
    expect(s.id).toBeTruthy();
  });

  it("checkRefinements accepts a missing and a good file and writes nothing", () => {
    checkRefinements();
    expect(existsSync(refinementsPath())).toBe(false);
    make();
    const bytes = file();
    checkRefinements();
    expect(file()).toBe(bytes);
  });
});

describe("removeRefinementsLocked", () => {
  it("needs the lock, removes one owner's sessions and writes nothing when there are none", () => {
    expect(() => removeRefinementsLocked(ANN)).toThrow();
    make(ANN);
    make(BOB);
    expect(withAuthLock(() => removeRefinementsLocked(ANN))).toBe(1);
    expect(listSessions().map((s) => s.owner)).toEqual([BOB]);
    const bytes = file();
    expect(withAuthLock(() => removeRefinementsLocked(ANN))).toBe(0);
    expect(file()).toBe(bytes);
  });
});

describe("moving the data folder", () => {
  it("copies refinements.json unchanged but not other json files at the top", () => {
    mkdirSync(join(home, "runs", "x"), { recursive: true });
    writeFileSync(join(home, "refinements.json"), "{}");
    writeFileSync(join(home, "runs", "x", "refinements.json"), "{}");
    expect(jsonFiles(home)).toEqual([join(home, "runs", "x", "refinements.json")]);
  });
});
