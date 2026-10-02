import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
let tmp: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const logs: string[] = [];
const seen: string[] = [];

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "repos-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

/** Calls the API and keeps everything that came back, to check later that no secret leaked. */
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
const list = async (who: TestSession) => (await call(who, "GET", "/api/repos")).json() as { id: string; url: string; method: string; credentialId?: string; username?: string }[];
const creds = async (who: TestSession) => (await call(who, "GET", "/api/credentials")).json() as { id: string; name: string }[];

let rec: { id: string; credentialId: string };

describe("repositories API", () => {
  it("adds a repository with a token and shows only public fields", async () => {
    const r = await call(ann, "POST", "/api/repos", { url: "https://github.com/Acme/App", method: "github-token", token: TOKEN });
    expect(r.status).toBe(201);
    rec = r.json();
    expect(Object.keys(rec).sort()).toEqual(["added", "credentialId", "id", "method", "owner", "url"]);
    expect(await list(ann)).toEqual([rec]);
    expect((await creds(ann)).map((c) => [c.id, c.name])).toEqual([[rec.credentialId, `repo:${rec.id}`]]);
  });

  it("keeps the old {name} call and the {url} short form, with method none", async () => {
    for (const body of [{ name: "acme/web" }, { url: "acme/web2" }]) {
      const r = await call(ann, "POST", "/api/repos", body);
      expect([r.status, r.json().method]).toEqual([201, "none"]);
    }
  });

  it("allows an explicit none for an admin only", async () => {
    expect((await call(ann, "POST", "/api/repos", { url: "acme/nope", method: "none" })).status).toBe(403);
    expect((await call(admin, "POST", "/api/repos", { url: "acme/own", method: "none" })).status).toBe(201);
  });

  it("answers 409 for the same repository in other forms and for another account", async () => {
    expect((await call(ann, "POST", "/api/repos", { url: "git@github.com:ACME/App.git" })).status).toBe(409);
    expect((await call(bob, "POST", "/api/repos", { url: "acme/app" })).status).toBe(409);
    expect(await list(bob)).toEqual([]);
  });

  it("answers 400 for forms that are not allowed", async () => {
    for (const body of [
      { url: "file:///x" }, { url: "/tmp/x" }, { url: "ext::x" }, { url: "https://u:p@github.com/a/b" }, { url: "https://host/a\u0001b" },
      { url: "https://gitlab.com/a/b", method: "github-token", token: TOKEN }, { url: "https://gitlab.com/a/b", method: "https-token", token: TOKEN },
    ]) {
      expect((await call(bob, "POST", "/api/repos", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("changes the token, the user name and the method", async () => {
    const t = await call(ann, "PUT", `/api/repos/${rec.id}/auth`, { token: TOKEN2 });
    expect(t.status).toBe(200);
    expect(t.json()).toMatchObject({ id: rec.id, method: "github-token" });
    expect(t.json().credentialId).not.toBe(rec.credentialId);
    expect((await creds(ann)).map((c) => c.id)).toEqual([t.json().credentialId]);

    const h = await call(ann, "POST", "/api/repos", { url: "https://git.example.com/a/b", method: "https-token", username: "ann", token: TOKEN });
    const same = await call(ann, "PUT", `/api/repos/${h.json().id}/auth`, { username: "ann2" });
    expect(same.json()).toMatchObject({ username: "ann2", credentialId: h.json().credentialId });
    const moved = await call(ann, "PUT", `/api/repos/${h.json().id}/auth`, { method: "https-token", username: "ann3", token: TOKEN2 });
    expect(moved.json().username).toBe("ann3");
    expect((await call(ann, "DELETE", `/api/repos/${h.json().id}`)).status).toBe(200);
  });

  it("answers 400, 403 and 404 for bad changes", async () => {
    const none = (await list(ann)).find((r) => r.method === "none")!;
    expect((await call(ann, "PUT", `/api/repos/${rec.id}/auth`, {})).status).toBe(400);
    expect((await call(ann, "PUT", `/api/repos/${none.id}/auth`, { method: "github-token" })).status).toBe(400);
    const other = await call(bob, "PUT", `/api/repos/${rec.id}/auth`, { token: TOKEN });
    expect([other.status, other.error()]).toEqual([404, "no such repository"]);
    expect((await call(ann, "PUT", `/api/repos/${rec.id}/auth`, { method: "none" })).status).toBe(403);
  });

  it("lets an admin set none and wipes the token", async () => {
    const r = await call(admin, "POST", "/api/repos", { url: "acme/adm", method: "github-token", token: TOKEN });
    expect((await call(admin, "PUT", `/api/repos/${r.json().id}/auth`, { method: "none" })).status).toBe(200);
    expect(await creds(admin)).toEqual([]);
  });

  it("changes the address to another form of the same repository only", async () => {
    const none = (await list(ann)).find((r) => r.method === "none")!;
    const ssh = await call(ann, "PUT", `/api/repos/${none.id}/auth`, { url: `git@github.com:${none.url.slice("https://github.com/".length)}.git` });
    expect([ssh.status, ssh.json().url]).toEqual([200, `git@github.com:${none.url.slice("https://github.com/".length)}.git`]);
    expect((await call(ann, "PUT", `/api/repos/${none.id}/auth`, { url: "acme/else" })).status).toBe(400);
  });

  it("removes a repository and its token; not another account's", async () => {
    expect((await call(bob, "DELETE", `/api/repos/${rec.id}`)).status).toBe(404);
    expect((await call(ann, "DELETE", `/api/repos/${rec.id}`)).status).toBe(200);
    expect(await creds(ann)).toEqual([]);
    expect((await call(ann, "DELETE", "/api/repos/acme/web")).status).toBe(200);
    expect((await call(ann, "DELETE", "/api/repos/acme/web")).status).toBe(404);
  });

  it("keeps repo: for the Foundry and never removes a credential the user stored", async () => {
    expect((await call(ann, "POST", "/api/credentials", { type: "token", name: "repo:x", secret: TOKEN })).status).toBe(400);
    const mine = await call(ann, "POST", "/api/credentials", { type: "token", name: "mine", secret: TOKEN2 });
    const r = await call(ann, "POST", "/api/repos", { url: "acme/keep" });
    await call(ann, "DELETE", `/api/repos/${r.json().id}`);
    expect((await creds(ann)).map((c) => c.id)).toEqual([mine.json().id]);
  });

  it("answers an old key that stays in the Keychain with a 500 after the record is gone", async () => {
    const a = await call(bob, "POST", "/api/repos", { url: "acme/kc1", method: "github-token", token: TOKEN });
    await call(bob, "POST", "/api/repos", { url: "acme/kc2", method: "github-token", token: TOKEN2 });
    logs.length = 0;
    kc.fail("delete");
    const r = await call(bob, "DELETE", `/api/repos/${a.json().id}`);
    kc.fail();
    expect(r.status).toBe(500);
    expect(r.error()).toContain("old key is still in the Keychain");
    expect(logs.some((l) => l.startsWith("repos: 1 old key(s)"))).toBe(true);
    expect((await list(bob)).map((x) => x.url)).toEqual(["https://github.com/acme/kc2"]);
  });

  it("answers a Keychain failure with plain text and adds no record", async () => {
    logs.length = 0;
    kc.fail("find");
    const r = await call(bob, "POST", "/api/repos", { url: "acme/kc3", method: "github-token", token: TOKEN });
    kc.fail();
    expect([r.status, r.error()]).toEqual([500, "the repository list is not working; see the server log"]);
    expect(logs).toContain("repos: keychain failed");
    expect((await list(bob)).map((x) => x.url)).not.toContain("https://github.com/acme/kc3");
  });

  it("never shows a token", () => {
    const all = seen.join("\n") + logs.join("\n");
    for (const t of [TOKEN, TOKEN2]) {
      expect(all).not.toContain(t);
      expect(all).not.toContain(Buffer.from(t).toString("base64"));
    }
  });
});
