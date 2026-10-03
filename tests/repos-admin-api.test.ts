import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { setStatus } from "../src/auth/users.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
let tmp: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let cat: TestSession;
const logs: string[] = [];
const seen: string[] = [];

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "repos-admin-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  cat = await signInAs(base, { name: "Cat", email: "cat@example.com", role: "user" });
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
type Row = { id: string; url: string; method: string; owner: string; settings: Record<string, unknown>; account: { name: string; email: string; role: string; status: string } | null };
const all = async () => (await call(admin, "GET", "/api/admin/repos")).json() as Row[];
const mine = async (who: TestSession) => (await call(who, "GET", "/api/repos")).json() as Record<string, unknown>[];
const creds = async (who: TestSession) => (await call(who, "GET", "/api/credentials")).json() as unknown[];
const addFor = async (who: TestSession, url: string, token?: string) =>
  (await call(who, "POST", "/api/repos", token ? { url, method: "github-token", token } : { url })).json() as { id: string };

let annRepo: { id: string };
let bobRepo: { id: string };

describe("admin repositories API", () => {
  it("answers 403 to a user on all three routes", async () => {
    for (const [m, p, b] of [["GET", "/api/admin/repos"], ["PUT", `/api/admin/repos/${UNKNOWN}/settings`, {}], ["POST", `/api/admin/repos/${UNKNOWN}/transfer`, { email: "a@b.io" }]] as const) {
      const r = await call(ann, m, p, b);
      expect([r.status, r.error()]).toEqual([403, "not allowed for your role"]);
    }
  });

  it("lists the repositories of all accounts with the owner and empty settings", async () => {
    annRepo = await addFor(ann, "acme/app", TOKEN);
    bobRepo = await addFor(bob, "acme/web");
    const adminRepo = await addFor(admin, "acme/own");
    const rows = await all();
    expect(rows.map((r) => r.id).sort()).toEqual([annRepo.id, bobRepo.id, adminRepo.id].sort());
    const a = rows.find((r) => r.id === annRepo.id)!;
    expect(a.account).toEqual({ name: "Ann", email: "ann@example.com", role: "user", status: "active" });
    expect(a.settings).toEqual({});
    expect(rows.find((r) => r.id === adminRepo.id)!.account?.role).toBe("admin");
  });

  it("sets settings; a user's list never has them", async () => {
    const S = { testCommand: "make secret-test-command", docs: ["docs/CHANGELOG.md"], protectedBranches: ["release/*"], mainBranch: "main", developBranch: "develop" };
    const r = await call(admin, "PUT", `/api/admin/repos/${annRepo.id}/settings`, S);
    expect(r.status).toBe(200);
    expect(r.json().settings).toEqual(S);
    const text = (await call(ann, "GET", "/api/repos")).text;
    expect(text).not.toContain("settings");
    expect(text).not.toContain("testCommand");
    expect(text).not.toContain("secret-test-command");
    expect((await all()).find((x) => x.id === annRepo.id)!.settings).toEqual(S);
  });

  it("keeps the settings when the user changes the authentication, and does not show them", async () => {
    const r = await call(ann, "PUT", `/api/repos/${annRepo.id}/auth`, { token: TOKEN2 });
    expect(r.status).toBe(200);
    expect(r.json()).not.toHaveProperty("settings");
    expect((await all()).find((x) => x.id === annRepo.id)!.settings).toMatchObject({ mainBranch: "main" });
  });

  it("answers 400 for bad settings, 404 for an unknown id, and clears with {}", async () => {
    for (const body of [{ nope: 1 }, { testCommand: "a\nb" }, { docs: "x" }, { protectedBranches: ["a[b]"] }, { mainBranch: "a b" }]) {
      expect((await call(admin, "PUT", `/api/admin/repos/${bobRepo.id}/settings`, body)).status).toBe(400);
    }
    expect((await call(admin, "PUT", `/api/admin/repos/${UNKNOWN}/settings`, {})).status).toBe(404);
    await call(admin, "PUT", `/api/admin/repos/${bobRepo.id}/settings`, { mainBranch: "trunk" });
    expect((await call(admin, "PUT", `/api/admin/repos/${bobRepo.id}/settings`, {})).json().settings).toEqual({});
    expect((await all()).find((x) => x.id === bobRepo.id)!.settings).toEqual({});
  });

  it("transfers a token repository by e-mail in upper case: wiped, settings kept, lists updated", async () => {
    const r = await call(admin, "POST", `/api/admin/repos/${annRepo.id}/transfer`, { email: "  BOB@EXAMPLE.COM " });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ method: "none", account: { email: "bob@example.com" }, settings: { mainBranch: "main" } });
    expect((await mine(bob)).find((x) => x.id === annRepo.id)).toMatchObject({ method: "none" });
    expect((await mine(ann)).some((x) => x.id === annRepo.id)).toBe(false);
    expect(await creds(ann)).toEqual([]);
    expect(await creds(bob)).toEqual([]);
  });

  it("transfers a token repository to the admin: method none, token gone", async () => {
    const repo = await addFor(cat, "acme/cat", TOKEN);
    const r = await call(admin, "POST", `/api/admin/repos/${repo.id}/transfer`, { email: "admin@example.com" });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ method: "none", account: { role: "admin" } });
    expect(await creds(cat)).toEqual([]);
  });

  it("refuses with a clear message and leaves the list unchanged", async () => {
    const before = JSON.stringify(await all());
    const t = (id: string, body: unknown) => call(admin, "POST", `/api/admin/repos/${id}/transfer`, body);
    const missing = await t(bobRepo.id, {});
    expect([missing.status, missing.error()]).toEqual([400, "give the e-mail of the new owner"]);
    const bad = await t(bobRepo.id, { email: "not-an-email" });
    expect([bad.status, bad.error()]).toEqual([400, "that is not a valid e-mail address"]);
    expect((await t(bobRepo.id, { email: "nobody@example.com" })).status).toBe(404);
    expect((await t(UNKNOWN, { email: "cat@example.com" })).status).toBe(404);
    await setStatus(cat.user.id, "blocked");
    const blocked = await t(bobRepo.id, { email: "cat@example.com" });
    expect([blocked.status, blocked.error()]).toEqual([409, "that account is blocked"]);
    await setStatus(cat.user.id, "active");
    for (let i = 0; i < 50; i++) addRepo(cat.user.id, `acme/full${i}`);
    const full = await t(bobRepo.id, { email: "cat@example.com" });
    expect(full.status).toBe(400);
    expect(full.error()).toContain("50");
    const now = (await all()).filter((r) => !r.url.includes("/full"));
    expect(JSON.stringify(now)).toBe(JSON.stringify(JSON.parse(before).filter((r: Row) => !r.url.includes("/full"))));
  });

  it("reports an old key that stays: the record has moved, and the repeat answers 200", async () => {
    const repo = await addFor(bob, "acme/keyed", TOKEN);
    kc.fail("delete");
    const r = await call(admin, "POST", `/api/admin/repos/${repo.id}/transfer`, { email: "ann@example.com" });
    kc.fail();
    expect(r.status).toBe(500);
    expect(r.error()).toContain("the repository was transferred, but an old key is still in the Keychain");
    expect((await mine(ann)).some((x) => x.id === repo.id)).toBe(true);
    expect((await call(admin, "POST", `/api/admin/repos/${repo.id}/transfer`, { email: "ann@example.com" })).status).toBe(200);
  });

  it("never holds a token in an answer or in the log", () => {
    for (const t of [...seen, ...logs]) {
      expect(t).not.toContain(TOKEN);
      expect(t).not.toContain(TOKEN2);
    }
  });
});
