import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteUser } from "../src/auth/users.js";
import { CredentialError, addCredential, credentialsPath } from "../src/credentials/store.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let kc: FakeKeychain;
let saved: string | undefined;
let ann: TestSession;
let bob: TestSession;
const logs: string[] = [];
const seen: string[] = [];

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "creds-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  ({ close, ctx } = await startServer({
    repo: tmp,
    runsDir: join(tmp, "runs"),
    port,
    claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
    watchers: false,
    log: (m) => void logs.push(m),
  }));
  ann = await signInAs(base);
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
async function call(who: TestSession, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  seen.push(text, JSON.stringify([...r.headers.entries()]));
  return { status: r.status, text, json: () => JSON.parse(text) };
}

const token = fakeToken();
let id: string;

describe("credentials API", () => {
  it("stores a token and shows only the public fields", async () => {
    const r = await call(ann, "POST", "/api/credentials", { type: "token", name: "gh", secret: token });
    expect(r.status).toBe(201);
    const rec = r.json();
    expect(Object.keys(rec).sort()).toEqual(["created", "fingerprint", "id", "lastUsed", "name", "type"]);
    id = rec.id;
    expect((await call(ann, "GET", "/api/credentials")).json()).toEqual([rec]);
  });

  it("shows nothing to another user", async () => {
    expect((await call(bob, "GET", "/api/credentials")).json()).toEqual([]);
    expect((await call(bob, "DELETE", `/api/credentials/${id}`)).status).toBe(404);
  });

  it("answers bad input with the right status", async () => {
    const post = (b: unknown) => call(ann, "POST", "/api/credentials", b).then((r) => r.status);
    expect(await post({ name: "x", secret: fakeToken("Qq7") })).toBe(400);
    expect(await post({ type: "nope", name: "x", secret: fakeToken("Qq7") })).toBe(400);
    expect(await post({ type: "token", name: "", secret: fakeToken("Qq7") })).toBe(400);
    expect(await post({ type: "token", name: "x", secret: 12345678 })).toBe(400);
    expect(await post({ type: "token", name: "x", secret: "short" })).toBe(400);
    expect(await post({ type: "token", name: "x", secret: "abcdefghé" })).toBe(400);
    expect(await post({ type: "token", name: "gh", secret: fakeToken("Qq7") })).toBe(409);
    const wrong = await fetch(base + "/api/credentials", { method: "POST", headers: ann.headers("POST", { "content-type": "text/plain" }), body: "x" });
    expect(wrong.status).toBe(415);
    const noCsrf = await fetch(base + "/api/credentials", { method: "POST", headers: { cookie: ann.cookie, "content-type": "application/json" }, body: "{}" });
    expect(noCsrf.status).toBe(403);
    expect((await call(ann, "PUT", "/api/credentials", {})).status).toBe(404);
  });

  it("never leaks a secret when the store fails", async () => {
    kc.fail("find");
    const bad = await call(ann, "POST", "/api/credentials", { type: "token", name: "second", secret: fakeToken("Rr8") });
    expect(bad.status).toBe(500);
    expect(bad.json().error).toBe("the credential store is not working; see the server log");
    kc.fail();
    expect(logs).toContain("credentials: keychain failed");

    const good = readFileSync(credentialsPath(), "utf8");
    writeFileSync(credentialsPath(), "not json");
    expect((await call(ann, "GET", "/api/credentials")).status).toBe(500);
    expect(logs).toContain("credentials: credentials.json not-json");
    writeFileSync(credentialsPath(), good);

    const two = (await call(ann, "POST", "/api/credentials", { type: "token", name: "second", secret: fakeToken("Rr8") })).json();
    kc.fail("delete");
    const incomplete = await call(ann, "DELETE", `/api/credentials/${two.id}`);
    expect(incomplete.status).toBe(500);
    expect(incomplete.json().error).toContain("old key is still in the Keychain");
    kc.fail();
    expect(logs.some((l) => l.includes("old key(s)"))).toBe(true);
    // a user gets the same answer without the setup (Keychain, the command line)
    const mine = (await call(bob, "POST", "/api/credentials", { type: "token", name: "bobs", secret: fakeToken("Bb2") })).json();
    kc.fail("delete");
    const bobs = await call(bob, "DELETE", `/api/credentials/${mine.id}`);
    kc.fail();
    expect(bobs.status).toBe(500);
    expect(bobs.json().error).toBe("the credential was removed, but the clean-up is not complete; try again, or ask the administrator");
    expect(bobs.text).not.toMatch(/Keychain|scf/);
    // a retry cleans the old key, although the credential is already gone
    expect((await call(ann, "DELETE", `/api/credentials/${two.id}`)).status).toBe(404);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8")).retiredKeyIds).toEqual([]);

    const key = Object.values(kc.items())[0]!;
    const all = [...seen, ...logs].join("\n");
    for (const s of [token, fakeToken("Rr8"), fakeToken("Qq7"), key]) {
      expect(all).not.toContain(s);
      expect(all).not.toContain(Buffer.from(s).toString("base64"));
    }
  });

  it("hides the token in a run that prints it", async () => {
    writeFileSync(join(tmp, "token.txt"), token);
    const yaml = `name: leak\nworkspace: inplace\nsteps:\n  - {id: show, type: shell, run: "cat ${join(tmp, "token.txt")}"}\n`;
    const r = await call(ann, "POST", "/api/runs", { yaml, task: "t" });
    expect(r.status).toBe(201);
    const runId = r.json().runId as string;
    await ctx.scheduler.wait(runId);
    const out = [
      (await call(ann, "GET", `/api/runs/${runId}`)).text,
      (await call(ann, "GET", `/api/runs/${runId}/transcript/0`)).text,
      (await call(ann, "GET", "/api/runs")).text,
      (await call(ann, "GET", "/api/your-turn")).text,
    ];
    const events = await fetch(`${base}/api/runs/${runId}/events`, { headers: ann.headers() });
    const reader = events.body!.getReader();
    let replay = "";
    for (let i = 0; i < 20 && !replay.includes('"status":"succeeded"'); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      replay += new TextDecoder().decode(value);
    }
    await reader.cancel();
    out.push(replay);
    expect(out.join("\n")).not.toContain(token);
    expect(out[0]).toContain("[redacted]");
  });

  it("hides a stored token in an error answer and in server log lines", async () => {
    const t = fakeToken("zq5");
    const rec = (await call(ann, "POST", "/api/credentials", { type: "token", name: "echo", secret: t })).json();
    const bad = await call(ann, "GET", `/api/runs/${t}`);
    expect(bad.text).not.toContain(t);
    ctx.opts.log?.(`something failed with ${t}`);
    expect(logs.join("\n")).not.toContain(t);
    expect(logs.at(-1)).toContain("[redacted]");
    await call(ann, "DELETE", `/api/credentials/${rec.id}`);
    seen.length = 0;
  });

  it("hides a token in saved run data that was logged before the token was stored", async () => {
    const late = fakeToken("Lt4");
    writeFileSync(join(tmp, "late.txt"), late);
    const yaml = `name: late\nworkspace: inplace\nsteps:\n  - {id: show, type: shell, run: "cat ${join(tmp, "late.txt")}"}\n`;
    const runId = (await call(ann, "POST", "/api/runs", { yaml, task: "t" })).json().runId as string;
    await ctx.scheduler.wait(runId);
    expect((await call(ann, "GET", `/api/runs/${runId}`)).text).toContain(late); // not stored yet
    const lateId = (await call(ann, "POST", "/api/credentials", { type: "token", name: "late", secret: late })).json().id as string;
    const after = [
      (await call(ann, "GET", `/api/runs/${runId}`)).text,
      (await call(ann, "GET", `/api/runs/${runId}/transcript/0`)).text,
      (await call(ann, "GET", "/api/runs")).text,
      // every other authenticated answer passes the same boundary
      ...(await Promise.all(["/api/your-turn", "/api/board", "/api/since", "/api/queue", "/api/next", "/api/watchers", "/api/nope"].map((p) => call(ann, "GET", p).then((r) => r.text)))),
    ];
    expect(after.join("\n")).not.toContain(late);
    expect(after[0]).toContain("[redacted]");
    const events = await fetch(`${base}/api/runs/${runId}/events`, { headers: ann.headers() });
    const reader = events.body!.getReader();
    let replay = "";
    for (let i = 0; i < 20 && !replay.includes('"status":"succeeded"'); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      replay += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(replay).not.toContain(late);
    expect((await call(ann, "DELETE", `/api/credentials/${lateId}`)).status).toBe(200);
    seen.length = 0; // this token is not part of the leak check above
  });

  it("deletes the owner's credential and replaces the key", async () => {
    const before = Object.keys(kc.items());
    expect((await call(ann, "DELETE", `/api/credentials/${id}`)).status).toBe(200);
    expect((await call(ann, "GET", "/api/credentials")).json()).toEqual([]);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8")).credentials).toEqual([]);
    expect(Object.keys(kc.items()).length).toBeLessThanOrEqual(before.length);
  });

  it("ends the sessions and wipes the credentials of a deleted user", async () => {
    const c = (await call(bob, "POST", "/api/credentials", { type: "token", name: "mine", secret: fakeToken("Ss9") })).json();
    expect(c.id).toBeTruthy();
    deleteUser(bob.user.id);
    expect((await call(bob, "GET", "/api/credentials")).status).toBe(401);
    expect(() => addCredential({ userId: bob.user.id, type: "token", name: "x", secret: fakeToken("Tt1") }, { ownerOk: () => false })).toThrow(CredentialError);
    mkdirSync(tmp, { recursive: true });
  });
});
