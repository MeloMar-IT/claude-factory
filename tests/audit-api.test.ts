import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_ACTIONS, AUDIT_ACTIONS, EVENT_ACTIONS, AuditEntrySchema, auditPath, auditRecord, auditTime, isAccountId, latestAudit, scanAudit, type AuditRecord,
} from "../src/auth/audit.js";
import { StoreError } from "../src/auth/store.js";
import { deleteUser } from "../src/auth/users.js";
import { CANNOT_READ, makeRedactor } from "../src/credentials/redact.js";
import { csvCell, csvLine, redactedCsvLine } from "../src/server/http.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// The audit API: read with filters, export as CSV (#96).

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const ev = (time: string, o: Record<string, unknown> = {}) => ({ time, by: A, action: "run-start", result: "ok", target: "run-1", ...o });
const lines = (...o: unknown[]) => o.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + "\n";
const collect = async (g: AsyncIterable<AuditRecord>) => {
  const out: AuditRecord[] = [];
  for await (const r of g) out.push(r);
  return out;
};

const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

describe("the reader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "audit-read-"));
    process.env.FACTORY_HOME = tmp;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("gives nothing for a missing file", async () => {
    expect(await collect(scanAudit())).toEqual([]);
    expect(await latestAudit({}, 500)).toEqual({ records: [], more: false });
  });

  it("maps the old account lines to ok with the account", () => {
    const base = { time: "2026-10-02T09:00:00.000Z", by: A, userId: B };
    const rec = (o: object) => auditRecord(AuditEntrySchema.parse({ ...base, ...o }));
    expect(rec({ action: "create" })).toEqual({ ...base, action: "create", result: "ok" });
    expect(rec({ action: "role", oldRole: "user", newRole: "admin" }).detail).toBe("user -> admin");
    expect(rec({ action: "block", stopWork: true }).detail).toBe("stop work");
    expect(rec({ action: "block", stopWork: false }).detail).toBeUndefined();
    expect(rec({ action: "block" }).detail).toBeUndefined();
  });

  it("keeps userId, target and detail of event lines", async () => {
    writeFileSync(
      auditPath(),
      lines(
        ev("2026-10-02T09:00:00.000Z", { target: "run-1", detail: "d" }),
        ev("2026-10-02T09:01:00.000Z", { target: undefined, userId: B, action: "sign-in" }),
        { time: "2026-10-02T09:02:00.000Z", by: "anonymous", action: "sign-in", result: "failed" },
      ),
    );
    const r = await collect(scanAudit());
    expect(r[0]).toMatchObject({ target: "run-1", detail: "d" });
    expect(r[1]).toMatchObject({ userId: B });
    expect(r[2]).not.toHaveProperty("userId");
    expect(r[2]).not.toHaveProperty("target");
  });

  it("skips lines that do not parse and keeps a last line without a newline", async () => {
    const good = (t: string) => JSON.stringify(ev(t));
    writeFileSync(
      auditPath(),
      ["{ not json", "", JSON.stringify({ ...ev("2026-10-02T09:00:00.000Z"), action: "run-stop" }), good("2026-10-02T09:01:00.000Z"), good("2026-10-02T09:02:00.000Z").slice(0, 20), good("2026-10-02T09:03:00.000Z")].join("\n"),
    );
    expect((await collect(scanAudit())).map((r) => r.time)).toEqual(["2026-10-02T09:01:00.000Z", "2026-10-02T09:03:00.000Z"]);
  });

  it("keeps file order; latestAudit puts the later line first even with an earlier time", async () => {
    writeFileSync(auditPath(), lines(ev("2026-10-02T10:00:00.000Z"), ev("2026-10-02T09:00:00.000Z")));
    expect((await collect(scanAudit())).map((r) => r.time)).toEqual(["2026-10-02T10:00:00.000Z", "2026-10-02T09:00:00.000Z"]);
    expect((await latestAudit({}, 500)).records.map((r) => r.time)).toEqual(["2026-10-02T09:00:00.000Z", "2026-10-02T10:00:00.000Z"]);
  });

  it("reads a long file in chunks, complete and in order", async () => {
    const all = Array.from({ length: 3000 }, (_, i) => ev("2026-10-02T09:00:00.000Z", { target: `run-é${i}` }));
    writeFileSync(auditPath(), lines(...all));
    const r = await collect(scanAudit());
    expect(r.map((x) => x.target)).toEqual(all.map((x) => x.target));
  });

  it("skips an over-long line", async () => {
    writeFileSync(auditPath(), lines(ev("2026-10-02T09:00:00.000Z"), "x".repeat(200 * 1024), ev("2026-10-02T09:01:00.000Z")));
    expect(await collect(scanAudit())).toHaveLength(2);
  });

  it("keeps the newest 500 and says whether there are more", async () => {
    const all = Array.from({ length: 1201 }, (_, i) => ev("2026-10-02T09:00:00.000Z", { target: `t${i}` }));
    writeFileSync(auditPath(), lines(...all));
    const r = await latestAudit({}, 500);
    expect(r.more).toBe(true);
    expect(r.records.map((x) => x.target)).toEqual(all.slice(-500).reverse().map((x) => x.target));
    writeFileSync(auditPath(), lines(...all.slice(0, 500)));
    expect((await latestAudit({}, 500)).more).toBe(false);
  });

  it("filters", async () => {
    writeFileSync(
      auditPath(),
      lines(
        ev("2026-10-02T09:00:00.000Z", { by: A, userId: B, target: undefined, action: "sign-in" }),
        ev("2026-10-02T10:00:00.000Z", { by: B }),
        ev("2026-10-02T11:00:00.000Z", { by: A, target: "x", detail: B }),
        ev("2026-10-02T12:00:00.000Z", { by: U, target: "u" }),
      ),
    );
    const times = async (f: object) => (await collect(scanAudit(f))).map((r) => r.time.slice(11, 13));
    expect(await times({ user: B })).toEqual(["09", "10"]);
    expect(await times({ action: "sign-in" })).toEqual(["09"]);
    expect(await times({ from: Date.parse("2026-10-02T10:00:00Z") })).toEqual(["10", "11", "12"]);
    expect(await times({ to: Date.parse("2026-10-02T10:00:00Z") })).toEqual(["09", "10"]);
    expect(await times({ user: A, action: "run-start", from: Date.parse("2026-10-02T10:30:00Z"), to: Date.parse("2026-10-02T11:00:00Z") })).toEqual(["11"]);
    expect(await times({ user: U })).toEqual(["12"]);
  });

  it("throws unreadable for a directory and for symlinks", async () => {
    mkdirSync(auditPath());
    await expect(collect(scanAudit())).rejects.toMatchObject({ kind: "unreadable" });
    rmSync(auditPath(), { recursive: true });
    symlinkSync(join(tmp, "nowhere"), auditPath());
    await expect(collect(scanAudit())).rejects.toBeInstanceOf(StoreError);
    rmSync(auditPath());
    writeFileSync(join(tmp, "real"), "");
    symlinkSync(join(tmp, "real"), auditPath());
    await expect(collect(scanAudit())).rejects.toMatchObject({ kind: "unreadable" });
  });

  it("knows every action; checks ids and times", () => {
    for (const a of EVENT_ACTIONS) expect(AUDIT_ACTIONS).toContain(a);
    expect(ACCOUNT_ACTIONS).toHaveLength(8);
    expect(isAccountId(A) && isAccountId(U)).toBe(true);
    for (const s of ["cli", "anonymous", ""]) expect(isAccountId(s)).toBe(false);
    expect(typeof auditTime("2026-10-02T09:00:00Z")).toBe("number");
    expect(typeof auditTime("2026-10-02T09:00:00+02:00")).toBe("number");
    for (const s of ["2026-10-02", "2026-10-02T09:00:00", "yesterday", ""]) expect(auditTime(s)).toBeUndefined();
  });
});

describe("csv", () => {
  it("quotes cells", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
  it("makes formulas harmless", () => {
    for (const c of ["=1+1", "+1", "-x", "@a"]) expect(csvCell(c)).toBe("'" + c);
    expect(csvCell(`'=1+1,"x"`)).toBe(`"'=1+1,""x"""`);
    expect(csvCell(`=1+1,"x"`)).toBe(`"'=1+1,""x"""`);
  });
  it("ends a line with CRLF and redacts each cell first", () => {
    expect(csvLine(["a", "b"])).toBe("a,b\r\n");
    expect(csvLine(["a", 's"x'], (c) => c.replace('s"x', "[redacted]"))).toBe("a,[redacted]\r\n");
  });
});

describe("csv redaction of whole rows", () => {
  it("hides a secret made by the formula guard or spread over cells", () => {
    const r = makeRedactor(["'=1234567", "abcdefgh,,ok,ijklmnop"]);
    expect(redactedCsvLine(["=1234567", "x"], r)).toBe("[redacted],[redacted]\r\n");
    expect(redactedCsvLine(["abcdefgh", "", "ok", "ijklmnop"], r)).not.toContain("abcdefgh");
    expect(redactedCsvLine(["a", "b,c"], r)).toBe('a,"b,c"\r\n');
  });
});

describe("the audit API", () => {
  const open: { tmp: string; close: () => void }[] = [];
  afterAll(() => {
    for (const s of open) s.close();
  });
  interface Srv { base: string; tmp: string; logs: string[]; admin: TestSession; user: TestSession }

  async function boot(): Promise<Srv> {
    const tmp = mkdtempSync(join(tmpdir(), "audit-api-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    process.env.FACTORY_HOME = join(tmp, "home");
    const logs: string[] = [];
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({ repo, runsDir: join(tmp, "runs"), port, claudeBin, watchers: false, log: (m) => logs.push(m), accountSweepMs: 3_600_000 });
        open.push({ tmp, close: () => { started.close(); rmSync(tmp, { recursive: true, force: true }); } });
        const base = `http://127.0.0.1:${port}`;
        const admin = await signInAs(base);
        const user = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
        return { base, tmp, logs, admin, user };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      }
    }
  }
  const get = async (s: Srv, path: string, who: TestSession | null = s.admin) => {
    const r = await fetch(s.base + path, { headers: who ? who.headers() : {} });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) };
  };
  const T = (n: number) => new Date(Date.UTC(2026, 9, 2, 9, 0, n)).toISOString();

  it("reads newest first, with names, forms and a stable file", async () => {
    const s = await boot();
    const ann = s.user.user.id;
    writeFileSync(
      auditPath(),
      lines(
        { time: T(1), by: s.admin.user.id, action: "create", userId: ann },
        ev(T(2), { by: "cli", target: "-flow", detail: "d" }),
        { time: T(3), by: "anonymous", action: "sign-in", result: "failed" },
        ev(T(4), { by: ann, target: undefined, userId: B, action: "sign-in" }),
      ),
    );
    const before = readFileSync(auditPath(), "utf8");
    const r = await get(s, "/api/audit");
    expect(r.status).toBe(200);
    const j = r.json();
    expect(Object.keys(j).sort()).toEqual(["entries", "more"]);
    expect(j.entries.map((e: { time: string }) => e.time)).toEqual([T(4), T(3), T(2), T(1)]);
    expect(Object.keys(j.entries[0]).sort()).toEqual(["action", "actor", "result", "target", "time"]);
    expect(j.entries[2].detail).toBe("d");
    expect(j.entries[0].actor).toEqual({ type: "account", id: ann, name: "Ann" });
    expect(j.entries[0].target).toEqual({ type: "account", id: B, name: "deleted user" });
    expect(j.entries[1]).toMatchObject({ actor: { type: "anonymous" }, target: null, result: "failed" });
    expect(j.entries[2]).toMatchObject({ actor: { type: "cli" }, target: { type: "text", text: "-flow" } });
    expect(j.entries[3]).toMatchObject({ result: "ok", target: { type: "account", id: ann, name: "Ann" } });
    expect(readFileSync(auditPath(), "utf8")).toBe(before);
    deleteUser(ann);
    const after = (await get(s, "/api/audit")).json();
    expect(after.entries[0].actor.name).toBe("deleted user");
    expect(readFileSync(auditPath(), "utf8")).toBe(before);
    expect(before).not.toContain("Ann");
  });

  it("filters over HTTP", async () => {
    const s = await boot();
    writeFileSync(auditPath(), lines(ev(T(1), { by: U }), ev(T(2), { by: B, action: "repo-add" }), ev(T(3), { by: B })));
    const times = async (q: string) => (await get(s, "/api/audit?" + q)).json().entries.map((e: { time: string }) => e.time);
    expect(await times(`user=${B}`)).toEqual([T(3), T(2)]);
    expect(await times(`user=${U}`)).toEqual([T(1)]);
    expect(await times("action=repo-add")).toEqual([T(2)]);
    expect(await times(`from=${encodeURIComponent(T(2))}`)).toEqual([T(3), T(2)]);
    expect(await times(`to=${encodeURIComponent(T(2))}`)).toEqual([T(2), T(1)]);
    expect(await times(`user=${B}&action=run-start&from=${T(2)}`)).toEqual([T(3)]);
  });

  it("answers 400 for bad filters on both calls, without the given value", async () => {
    const s = await boot();
    const bad = ["user=cli", "user=x", "user=", "action=nope", "from=2026-10-02", "to=yesterday", `from=${T(5)}&to=${T(1)}`, `user=${B}&user=${B}`, "limit=5"];
    for (const path of ["/api/audit", "/api/audit/export"]) {
      for (const q of bad) {
        const r = await get(s, `${path}?${q}`);
        expect(r.status, q).toBe(400);
        expect(Object.keys(r.json())).toEqual(["error"]);
        for (const v of ["nope", "yesterday", "limit"]) if (q.includes(v) && v !== "limit") expect(r.text).not.toContain(v === "nope" ? "=nope" : "=yesterday");
      }
    }
  });

  it("limits the answer to 500 and exports all", async () => {
    const s = await boot();
    const all = Array.from({ length: 501 }, (_, i) => ev(T(0), { target: `t${i}` }));
    writeFileSync(auditPath(), lines(...all));
    const j = (await get(s, "/api/audit")).json();
    expect(j.entries).toHaveLength(500);
    expect(j.more).toBe(true);
    expect(j.entries[0].target.text).toBe("t500");
    writeFileSync(auditPath(), lines(...all.slice(0, 500)));
    expect((await get(s, "/api/audit")).json().more).toBe(false);
    writeFileSync(auditPath(), lines(...all));
    expect((await get(s, "/api/audit/export")).text.trimEnd().split("\r\n")).toHaveLength(502);
  });

  it("exports CSV, oldest first, with escaping and filters", async () => {
    const s = await boot();
    writeFileSync(auditPath(), lines(ev(T(1), { by: "cli", target: "-flow" }), ev(T(2), { by: B, action: "repo-add", detail: '=1+1,"x"' })));
    const r = await get(s, "/api/audit/export");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="audit.csv"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.text.split("\r\n")).toEqual([
      "time,actor,actor_name,action,target,target_name,result,detail",
      `${T(1)},cli,,run-start,'-flow,,ok,`,
      `${T(2)},${B},deleted user,repo-add,run-1,,ok,"'=1+1,""x"""`,
      "",
    ]);
    expect((await get(s, "/api/audit/export?action=repo-add")).text.trimEnd().split("\r\n")).toHaveLength(2);
    writeFileSync(auditPath(), "");
    expect((await get(s, "/api/audit/export")).text).toBe("time,actor,actor_name,action,target,target_name,result,detail\r\n");
  });

  it("exports a large log in several pieces", async () => {
    const s = await boot();
    const all = Array.from({ length: 3000 }, (_, i) => ev(T(0), { target: `target-number-${i}` }));
    writeFileSync(auditPath(), lines(...all));
    const rows = (await get(s, "/api/audit/export")).text.trimEnd().split("\r\n");
    expect(rows).toHaveLength(3001);
    expect(rows[1]).toContain("target-number-0");
    expect(rows[3000]).toContain("target-number-2999");
  });

  it("is for admins only", async () => {
    const s = await boot();
    for (const p of ["/api/audit", "/api/audit/export"]) {
      const r = await get(s, p, s.user);
      expect(r.status).toBe(403);
      expect(r.json()).toEqual({ error: "not allowed for your role" });
      expect((await get(s, p, null)).status).toBe(401);
    }
  });

  it("hides stored secrets and fails closed", async () => {
    const s = await boot();
    const secret = fakeToken("Rd1");
    const c = await fetch(s.base + "/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json", ...s.admin.headers("POST") },
      body: JSON.stringify({ type: "token", name: "k", secret }),
    });
    expect(c.status).toBe(201);
    writeFileSync(auditPath(), lines(ev(T(1), { detail: secret })));
    for (const p of ["/api/audit", "/api/audit/export"]) {
      const r = await get(s, p);
      expect(r.text).not.toContain(secret);
      expect(r.text).toContain("[redacted]");
    }
    const file = join(s.tmp, "home", "credentials.json");
    const saved = readFileSync(file);
    writeFileSync(file, "not json");
    for (const p of ["/api/audit", "/api/audit/export"]) {
      const r = await get(s, p);
      expect(r.status).toBe(500);
      expect(r.json()).toEqual({ error: CANNOT_READ });
    }
    writeFileSync(file, saved);
  });

  it("answers a plain 500 for an unreadable log and logs the kind", async () => {
    const s = await boot();
    rmSync(auditPath(), { force: true });
    mkdirSync(auditPath());
    for (const p of ["/api/audit", "/api/audit/export"]) {
      const r = await get(s, p);
      expect(r.status).toBe(500);
      expect(r.json()).toEqual({ error: "the audit log is not working; see the server log" });
      expect(r.text).not.toContain(s.tmp);
    }
    expect(s.logs).toContain("audit: audit.jsonl unreadable");
    expect(s.logs.join("\n")).not.toContain(s.tmp);
    rmSync(auditPath(), { recursive: true });
    expect((await get(s, "/api/audit")).status).toBe(200);
  });
});
