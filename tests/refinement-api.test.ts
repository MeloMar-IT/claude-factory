import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { refinementSweeper } from "../src/server/api-refinement.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { DROP_KEEP_MS, refinementsPath } from "../src/refinement/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let saved: string | undefined;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let logs: string[];

async function boot(extra: Partial<ServerOptions> = {}) {
  started = await startServer({
    repo: tmp,
    runsDir: join(tmp, "runs"),
    port,
    claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
    watchers: false,
    log: (m) => void logs.push(m),
    refinementSweepMs: 3_600_000,
    ...extra,
  });
}

beforeEach(async () => {
  logs = [];
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "refinement-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  await boot();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, "acme/app");
  addRepo(ann.user.id, "https://gitlab.com/acme/web");
  addRepo(bob.user.id, "other/thing");
});
afterEach(() => {
  started?.close();
  started = undefined;
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown, raw?: string) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const make = async (who = ann, extra: object = {}) => (await call(who, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea", ...extra })).json();
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const old = () => new Date(Date.now() - DROP_KEEP_MS - 24 * 3600_000).toISOString();

describe("list and create", () => {
  it("lists the repositories a session can use", async () => {
    const r = await call(ann, "GET", "/api/refinement");
    expect(r.json()).toEqual({ sessions: [], repos: ["acme/app"] });
  });

  it("creates a session", async () => {
    const r = await call(ann, "POST", "/api/refinement", { repo: "ACME/App.git", idea: "An idea" });
    expect(r.status).toBe(201);
    const s = r.json();
    expect(Object.keys(s).sort()).toEqual(["created", "drafts", "id", "idea", "log", "mine", "repo", "repoAvailable", "state", "title", "updated"]);
    expect(s).toMatchObject({ repo: "acme/app", state: "exploring", mine: true, repoAvailable: true, drafts: [], title: "An idea" });
    expect(s.log).toEqual([{ at: expect.any(String), what: "created", who: "Ann" }]);
  });

  it("refuses bad input", async () => {
    const status = async (body: unknown) => (await call(ann, "POST", "/api/refinement", body)).status;
    expect(await status({ idea: "x" })).toBe(400);
    expect(await status({ repo: 5, idea: "x" })).toBe(400);
    expect(await status({ repo: "other/thing", idea: "x" })).toBe(403);
    expect(await status({ repo: "acme/web", idea: "x" })).toBe(403);
    expect(await status({ repo: "acme/app", idea: "  " })).toBe(400);
    expect(await status({ repo: "acme/app", idea: "x", title: "t".repeat(121) })).toBe(400);
    expect((await call(ann, "POST", "/api/refinement", undefined, "{nope")).status).toBe(400);
    const noType = await fetch(`${base}/api/refinement`, { method: "POST", headers: ann.headers("POST"), body: "{}" });
    expect(noType.status).toBe(415);
    const gone = listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
    removeRepo(ann.user.id, gone.id);
    expect(await status({ repo: "acme/app", idea: "x" })).toBe(403);
    expect(existsSync(refinementsPath())).toBe(false);
  });
});

describe("who may do what", () => {
  it("hides a session from other users", async () => {
    const s = await make();
    const miss = { error: "no such refinement session" };
    for (const [m, p, b] of [
      ["GET", `/api/refinement/${s.id}`, undefined],
      ["PUT", `/api/refinement/${s.id}`, { title: "x" }],
      ["POST", `/api/refinement/${s.id}/drop`, {}],
      ["POST", `/api/refinement/${s.id}/restore`, {}],
      ["GET", "/api/refinement/00000000-0000-4000-8000-000000000000", undefined],
    ] as const) {
      const r = await call(bob, m, p, b);
      expect(r.status).toBe(404);
      expect(r.json()).toEqual(miss);
    }
    expect((await call(bob, "GET", "/api/refinement")).json().sessions).toEqual([]);
  });

  it("lets an admin read and drop but not rename or restore", async () => {
    const s = await make();
    const list = (await call(admin, "GET", "/api/refinement")).json().sessions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ owner: ann.user.id, ownerName: "Ann", mine: false });
    expect((await call(admin, "GET", `/api/refinement/${s.id}`)).status).toBe(200);
    const put = await call(admin, "PUT", `/api/refinement/${s.id}`, { title: "x" });
    expect(put.status).toBe(403);
    expect(put.error()).toBe("only the owner can change this session");
    expect((await call(admin, "POST", `/api/refinement/${s.id}/drop`, {})).status).toBe(200);
    const annView = (await call(ann, "GET", `/api/refinement/${s.id}`)).json();
    expect(annView.log.at(-1)).toMatchObject({ what: "dropped", who: "an administrator" });
    const adminView = (await call(admin, "GET", `/api/refinement/${s.id}`)).json();
    expect(adminView.log.at(-1)).toMatchObject({ what: "dropped", who: "Test Admin" });
    expect((await call(admin, "POST", `/api/refinement/${s.id}/restore`, {})).status).toBe(403);
    const back = await call(ann, "POST", `/api/refinement/${s.id}/restore`, {});
    expect(back.status).toBe(200);
    expect(back.json().state).toBe("exploring");
  });

  it("renames, and refuses conflicts", async () => {
    const s = await make();
    const r = await call(ann, "PUT", `/api/refinement/${s.id}`, { title: "Better" });
    expect(r.status).toBe(200);
    expect((await call(ann, "GET", "/api/refinement")).json().sessions[0].title).toBe("Better");
    expect((await call(ann, "PUT", `/api/refinement/${s.id}`, { title: " " })).status).toBe(400);
    expect((await call(ann, "POST", `/api/refinement/${s.id}/restore`, {})).status).toBe(409);
    expect((await call(ann, "POST", `/api/refinement/${s.id}/drop`, {})).status).toBe(200);
    expect((await call(ann, "POST", `/api/refinement/${s.id}/drop`, {})).status).toBe(409);
    expect((await call(ann, "PUT", `/api/refinement/${s.id}`, { title: "Again" })).status).toBe(409);
  });

  it("says when the repository is gone", async () => {
    const s = await make();
    const rec = listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
    removeRepo(ann.user.id, rec.id);
    const got = await call(ann, "GET", `/api/refinement/${s.id}`);
    expect(got.status).toBe(200);
    expect(got.json().repoAvailable).toBe(false);
    expect((await call(ann, "GET", "/api/refinement")).json().repos).toEqual([]);
    addRepo(ann.user.id, "acme/app");
    expect((await call(ann, "GET", `/api/refinement/${s.id}`)).json().repoAvailable).toBe(true);
  });
});

describe("keeping and removing", () => {
  it("survives a restart", async () => {
    await make();
    const before = (await call(ann, "GET", "/api/refinement")).text;
    started!.close();
    await wait(50);
    await boot();
    const again = await signInAs(base, { email: "ann@example.com", name: "Ann", role: "user" });
    expect((await call(again, "GET", "/api/refinement")).text).toBe(before);
  });

  it("removes an expired session on read and at start", async () => {
    const s = await make();
    await call(ann, "POST", `/api/refinement/${s.id}/drop`, {});
    const f = stored();
    f.sessions[0].droppedAt = old();
    writeFileSync(refinementsPath(), JSON.stringify(f));
    expect((await call(ann, "GET", "/api/refinement")).json().sessions).toEqual([]);
    expect((await call(ann, "GET", `/api/refinement/${s.id}`)).status).toBe(404);
    started!.close();
    await wait(50);
    await boot();
    expect(readFileSync(refinementsPath(), "utf8")).not.toContain(s.id);
  });

  it("removes expired sessions on a timer that stops with the server", async () => {
    started!.close();
    await wait(50);
    await boot({ refinementSweepMs: 50 });
    const s = await make();
    await call(ann, "POST", `/api/refinement/${s.id}/drop`, {});
    const expire = () => {
      const f = stored();
      f.sessions[0].droppedAt = old();
      writeFileSync(refinementsPath(), JSON.stringify(f));
    };
    expire();
    const until = Date.now() + 3000;
    while (readFileSync(refinementsPath(), "utf8").includes(s.id) && Date.now() < until) await wait(50);
    expect(readFileSync(refinementsPath(), "utf8")).not.toContain(s.id);
    // a session kept in the file by hand, after the server is closed
    const s2 = await make();
    await call(ann, "POST", `/api/refinement/${s2.id}/drop`, {});
    started!.close();
    await wait(100);
    const f = stored();
    f.sessions.find((x: any) => x.id === s2.id).droppedAt = old();
    writeFileSync(refinementsPath(), JSON.stringify(f));
    await wait(300);
    expect(readFileSync(refinementsPath(), "utf8")).toContain(s2.id);
  });

  it("removes the sessions of a deleted account", async () => {
    await make(bob, { repo: "other/thing" });
    await make();
    expect((await call(admin, "GET", "/api/refinement")).json().sessions).toHaveLength(2);
    expect((await call(admin, "DELETE", `/api/users/${bob.user.id}`)).status).toBe(200);
    const left = (await call(admin, "GET", "/api/refinement")).json().sessions;
    expect(left.map((s: any) => s.ownerName)).toEqual(["Ann"]);
    expect(stored().sessions).toHaveLength(1);
  });
});

describe("the sweeper", () => {
  it("logs a broken file once until it is repaired", () => {
    const lines: string[] = [];
    const sweep = refinementSweeper((m) => lines.push(m));
    writeFileSync(refinementsPath(), "{");
    sweep();
    sweep();
    expect(lines).toEqual(["! refinement: refinements.json not-json"]);
    writeFileSync(refinementsPath(), JSON.stringify({ version: 1, sessions: [] }));
    sweep();
    expect(lines).toHaveLength(1);
    writeFileSync(refinementsPath(), "{");
    sweep();
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(tmp);
  });
});

describe("a broken file", () => {
  it("answers a plain 500 and logs the kind only", async () => {
    await make();
    writeFileSync(refinementsPath(), "{");
    const r = await call(ann, "GET", "/api/refinement");
    expect(r.status).toBe(500);
    expect(r.error()).toBe("the refinement sessions are not working; see the server log");
    expect(logs.join("\n")).toContain("refinement: refinements.json not-json");
    expect(r.text + logs.join("\n")).not.toContain(tmp);
  });
});

describe("no agent, no GitHub", () => {
  it("starts no work", async () => {
    const s = await make();
    await call(ann, "PUT", `/api/refinement/${s.id}`, { title: "x" });
    await call(ann, "POST", `/api/refinement/${s.id}/drop`, {});
    expect(started!.ctx.scheduler.briefs()).toEqual([]);
    const runs = join(tmp, "runs");
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  });
});
