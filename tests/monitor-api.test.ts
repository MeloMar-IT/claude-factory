import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveFindings, type Finding } from "../src/monitor/findings.js";
import { markerHash } from "../src/monitor/story.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let close: () => void;
let session: TestSession;
const home = () => join(tmp, "home");
const SECRET = "restart-loop|distinctive-secret-fingerprint";
const A = "restart-loop|a";
const B = "restart-loop|b";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "monitor-api-"));
  process.env.FACTORY_HOME = home();
  const { startServer } = await import("../src/server/server.js");
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs") }));
  session = await signInAs(base);
  const cfg = (await (await call("GET", "/api/config")).json()) as { watchers: unknown[] };
  expect((await call("PUT", "/api/config", { ...cfg, watchers: [{ id: "mon", source: "monitor", every: "1h" }] })).status).toBe(200);
  expect((await call("POST", "/api/watchers/mon/tick", {})).status).toBe(200); // the first check is over: the next one is an hour away
});
afterAll(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, headers = session?.headers(method)) =>
  fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
const finding = (fingerprint: string, over: Partial<Finding> = {}): Finding => ({
  detector: "restart-loop", fingerprint, severity: "critical", summary: `sentence of ${markerHash(fingerprint)}`, about: "foundry", evidence: {},
  firstSeen: new Date(Date.now() - 3_600_000).toISOString(), lastSeen: new Date().toISOString(), count: 3, gone: false, ...over,
});
const seed = (list: Finding[]) => saveFindings(list, join(home(), "monitor-findings.json"));
const get = async () => (await (await call("GET", "/api/monitor")).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const log = () => (existsSync(join(home(), "monitor-log.jsonl")) ? readFileSync(join(home(), "monitor-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : []); // eslint-disable-line @typescript-eslint/no-explicit-any
const guard = () => JSON.parse(readFileSync(join(home(), "monitor-guard.json"), "utf8")) as { mutes?: Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const activity = async () => {
  const list = (await (await call("GET", "/api/watchers")).json()) as { id: string; status?: { lastActions: string[] } }[];
  return list.find((w) => w.id === "mon")?.status?.lastActions ?? [];
};

beforeEach(() => {
  rmSync(join(home(), "monitor-guard.json"), { force: true });
  rmSync(join(home(), "monitor-log.jsonl"), { force: true });
  seed([]);
});

describe("GET /api/monitor", () => {
  it("on a fresh folder has empty lists and the detector names", async () => {
    const m = await get();
    expect(m.findings).toEqual([]);
    expect(m.mutes).toEqual([]);
    const names = m.detectors.map((d: { name: string }) => d.name);
    expect(names).toEqual(expect.arrayContaining(["slow-step", "detector-failed"]));
  });

  it("lists the findings by hash with the story, and never the fingerprint", async () => {
    seed([finding(SECRET, { report: { repo: "acme/app", issue: 7, url: "https://github.com/acme/app/issues/7", at: new Date().toISOString(), seen: 1, closedAt: new Date().toISOString() } })]);
    const res = await call("GET", "/api/monitor");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const m = JSON.parse(text);
    expect(m.findings[0]).toMatchObject({ id: markerHash(SECRET), detector: "restart-loop", severity: "critical", count: 3, story: { issue: 7, url: "https://github.com/acme/app/issues/7", state: "closed" } });
  });

  it("answers all of 250 findings", async () => {
    seed(Array.from({ length: 250 }, (_, i) => finding(`restart-loop|n${i}`)));
    expect((await get()).findings).toHaveLength(250);
  });

  it("a broken findings file: 200 with an empty list, and the file is not renamed", async () => {
    const f = join(home(), "monitor-findings.json");
    writeFileSync(f, "{broken");
    const res = await call("GET", "/api/monitor");
    expect(res.status).toBe(200);
    expect((await res.json()).findings).toEqual([]);
    expect(existsSync(f)).toBe(true);
    expect(readdirSync(home()).some((n) => n.includes(".broken"))).toBe(false);
  });
});

describe("POST /api/monitor/mutes", () => {
  it("mutes a detector: 201, the account id in the file, the log and the activity; the lists show it", async () => {
    seed([finding(A)]);
    const res = await call("POST", "/api/monitor/mutes", { detector: "restart-loop", reason: "known noise" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mute).toMatchObject({ kind: "detector", detector: "restart-loop", reason: "known noise", by: session.user.id });
    expect(guard().mutes![0]).toMatchObject({ by: session.user.id, kind: "detector" });
    expect(log()).toMatchObject([{ event: "mute-made", by: session.user.id, detector: "restart-loop", text: "known noise" }]);
    expect((await activity())[0]).toContain("muted restart-loop for good: known noise");
    const m = await get();
    expect(m.mutes).toHaveLength(1);
    expect(m.findings[0].mute).toMatchObject({ id: body.mute.id, kind: "detector", reason: "known noise" });
  });

  it("mutes a finding for 2 hours; the answer names it by hash and has no fingerprint", async () => {
    seed([finding(SECRET)]);
    const res = await call("POST", "/api/monitor/mutes", { finding: markerHash(SECRET), reason: "r", hours: 2 });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const { mute } = JSON.parse(text);
    expect(mute.finding).toBe(markerHash(SECRET));
    expect("fingerprint" in mute).toBe(false);
    expect(Math.abs(Date.parse(mute.until) - (Date.now() + 2 * 3_600_000))).toBeLessThan(60_000);
    expect(await (await call("GET", "/api/monitor")).text()).not.toContain(SECRET);
    const del = await call("DELETE", `/api/monitor/mutes/${mute.id}`);
    expect(await del.text()).not.toContain(SECRET);
  });

  it("two findings of one detector can both be muted; the same one again is 409", async () => {
    seed([finding(A), finding(B)]);
    expect((await call("POST", "/api/monitor/mutes", { finding: markerHash(A), reason: "r" })).status).toBe(201);
    expect((await call("POST", "/api/monitor/mutes", { finding: markerHash(B), reason: "r" })).status).toBe(201);
    expect((await call("POST", "/api/monitor/mutes", { finding: markerHash(A), reason: "r" })).status).toBe(409);
  });

  it("refuses bad input with 400", async () => {
    seed([finding(A)]);
    const ok = { detector: "restart-loop", reason: "r" };
    const bad: Record<string, unknown>[] = [
      { detector: "restart-loop" },
      { ...ok, reason: "a\nb" },
      { ...ok, reason: "known noise\n" },
      { ...ok, reason: "\tknown noise" },
      { ...ok, reason: "x".repeat(201) },
      { ...ok, reason: "   " },
      { ...ok, finding: markerHash(A) },
      { reason: "r" },
      { ...ok, detector: "nope" },
      { reason: "r", finding: "0123456789abcdef" },
      { reason: "r", finding: "x" },
      { ...ok, hours: 0 },
      { ...ok, hours: -1 },
      { ...ok, hours: "2" },
      { ...ok, hours: 9000 },
    ];
    for (const b of bad) expect(((await call("POST", "/api/monitor/mutes", b)).status), JSON.stringify(b)).toBe(400);
    expect(existsSync(join(home(), "monitor-guard.json"))).toBe(false);
  });

  it("stores a trimmed reason", async () => {
    expect((await call("POST", "/api/monitor/mutes", { detector: "slow-step", reason: "  noise  " })).status).toBe(201);
    expect(guard().mutes![0]!.reason).toBe("noise");
  });

  it("a second mute of the same detector is 409", async () => {
    expect((await call("POST", "/api/monitor/mutes", { detector: "slow-step", reason: "r" })).status).toBe(201);
    expect((await call("POST", "/api/monitor/mutes", { detector: "slow-step", reason: "r" })).status).toBe(409);
  });

  it("without the CSRF token it is 403", async () => {
    const res = await call("POST", "/api/monitor/mutes", { detector: "slow-step", reason: "r" }, { cookie: session.cookie });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/monitor/mutes/:id", () => {
  it("ends the mute, logs who did it, and a second call is 404", async () => {
    const { mute } = await (await call("POST", "/api/monitor/mutes", { detector: "slow-step", reason: "r" })).json();
    const res = await call("DELETE", `/api/monitor/mutes/${mute.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).mutes).toEqual([]);
    expect(log().filter((l) => l.event === "mute-ended")).toMatchObject([{ by: session.user.id, mute: mute.id }]);
    expect((await activity())[0]).toContain("mute ended");
    const again = await call("DELETE", `/api/monitor/mutes/${mute.id}`);
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: string }).error).toBe("mute not found");
  });
});
