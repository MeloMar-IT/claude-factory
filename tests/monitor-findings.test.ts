import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dayOf, loadFindings, mergeFindings, saveFindings, type FindingInput } from "../src/monitor/findings.js";

const HOUR = 3_600_000;
const T0 = new Date("2026-10-01T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const input = (fingerprint: string, over: Partial<FindingInput> = {}): FindingInput => ({
  detector: "d", fingerprint, severity: "major", summary: "s", evidence: {}, about: "foundry", ...over,
});

describe("mergeFindings", () => {
  it("a new finding, then the same one again (count 2, firstSeen kept)", () => {
    const a = mergeFindings([], [input("x")], T0);
    expect(a.fresh).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ count: 1, firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), gone: false });
    const b = mergeFindings(a.findings, [input("x")], at(HOUR));
    expect(b.fresh).toHaveLength(0);
    expect(b.findings[0]).toMatchObject({ count: 2, firstSeen: T0.toISOString(), lastSeen: at(HOUR).toISOString() });
  });

  it("is gone after 24 hours without a sighting, and not before", () => {
    const a = mergeFindings([], [input("x")], T0).findings;
    const early = mergeFindings(a, [], at(24 * HOUR - 1));
    expect(early.findings[0]!.gone).toBe(false);
    const late = mergeFindings(a, [], at(24 * HOUR));
    expect(late.findings[0]!.gone).toBe(true);
    expect(late.gone).toHaveLength(1);
    // it is reported as gone once
    expect(mergeFindings(late.findings, [], at(25 * HOUR)).gone).toHaveLength(0);
  });

  it("a gone finding that is seen again is reopened as new", () => {
    const a = mergeFindings([], [input("x")], T0).findings;
    const gone = mergeFindings(a, [], at(25 * HOUR)).findings;
    const back = mergeFindings(gone, [input("x")], at(30 * HOUR));
    expect(back.fresh).toHaveLength(1);
    expect(back.findings).toHaveLength(1);
    expect(back.findings[0]).toMatchObject({ count: 1, gone: false, firstSeen: at(30 * HOUR).toISOString() });
  });

  it("prunes gone findings after 30 days", () => {
    const a = mergeFindings([], [input("x")], T0).findings;
    const gone = mergeFindings(a, [], at(25 * HOUR)).findings;
    expect(mergeFindings(gone, [], at(29 * 24 * HOUR)).findings).toHaveLength(1);
    expect(mergeFindings(gone, [], at(31 * 24 * HOUR)).findings).toHaveLength(0);
  });

  it("keeps at most 500: gone ones go first", () => {
    const old = mergeFindings([], Array.from({ length: 5 }, (_, i) => input(`gone${i}`)), T0).findings;
    const gone = mergeFindings(old, [], at(25 * HOUR)).findings;
    const many = Array.from({ length: 500 }, (_, i) => input(`f${i}`));
    const r = mergeFindings(gone, many, at(26 * HOUR));
    expect(r.findings).toHaveLength(500);
    expect(r.findings.some((f) => f.gone)).toBe(false);
    expect(r.dropped).toBe(5);
  });

  it("announces only what it stored when the cap drops findings", () => {
    const r = mergeFindings([], Array.from({ length: 510 }, (_, i) => input(`f${i}`)), T0);
    expect(r.findings).toHaveLength(500);
    expect(r.fresh).toHaveLength(500);
    expect(r.fresh.every((f) => r.findings.includes(f))).toBe(true);
  });

  it("with 510 open findings the 10 with the oldest lastSeen go", () => {
    const first = mergeFindings([], Array.from({ length: 10 }, (_, i) => input(`old${i}`)), T0).findings;
    const r = mergeFindings(first, Array.from({ length: 500 }, (_, i) => input(`new${i}`)), at(HOUR));
    expect(r.findings).toHaveLength(500);
    expect(r.dropped).toBe(10);
    expect(r.findings.some((f) => f.fingerprint.startsWith("old"))).toBe(false);
  });
});

describe("bug story state in findings", () => {
  const report = { repo: "a/b", issue: 5, url: "u", at: T0.toISOString(), seen: 1 };
  const day = (n: number) => new Date(2026, 9, 1 + n, 12);
  const base = () => mergeFindings([], [input("x")], T0).findings;

  it("days holds distinct local days, at most 3 (the latest)", () => {
    let f = mergeFindings([], [input("x")], day(0)).findings;
    f = mergeFindings(f, [input("x")], new Date(day(0).getTime() + HOUR)).findings;
    expect(f[0]!.days).toEqual([dayOf(day(0))]);
    for (const n of [1, 2, 3]) f = mergeFindings(f, [input("x")], day(n)).findings;
    expect(f[0]!.days).toEqual([dayOf(day(1)), dayOf(day(2)), dayOf(day(3))]);
  });

  it("report, due and days survive a re-sighting and a gone, reopened finding", () => {
    const f = [{ ...base()[0]!, report, due: T0.toISOString() }];
    const again = mergeFindings(f, [input("x")], at(HOUR)).findings[0]!;
    expect(again).toMatchObject({ report, due: T0.toISOString() });
    const gone = mergeFindings(f, [], at(25 * HOUR)).findings;
    const back = mergeFindings(gone, [input("x")], at(26 * HOUR)).findings[0]!;
    expect(back).toMatchObject({ report, due: T0.toISOString(), count: 1 });
    expect(back.days!.length).toBeGreaterThanOrEqual(1);
  });

  it("skipped survives a re-sighting; one that is not a list of short strings is dropped on load", () => {
    const f = [{ ...base()[0]!, skipped: ["off"] }];
    expect(mergeFindings(f, [input("x")], at(HOUR)).findings[0]!.skipped).toEqual(["off"]);
    const dir = mkdtempSync(join(tmpdir(), "monitor-findings-"));
    try {
      const file = join(dir, "f.json");
      const good = base()[0]!;
      writeFileSync(file, JSON.stringify({ version: 1, findings: [{ ...good, skipped: ["off"] }, { ...good, fingerprint: "m", skipped: "off" }, { ...good, fingerprint: "n", skipped: [5] }, { ...good, fingerprint: "o", skipped: ["x".repeat(41)] }] }));
      const r = loadFindings(file).findings;
      expect(r.map((x) => x.skipped)).toEqual([["off"], undefined, undefined, undefined]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stored finding with a report that is not seen gets missedAt; one without is unchanged", () => {
    const withReport = { ...base()[0]!, report };
    const plain = { ...mergeFindings([], [input("y")], T0).findings[0]! };
    const r = mergeFindings([withReport, plain], [], at(HOUR)).findings;
    expect(r.find((f) => f.fingerprint === "x")!.missedAt).toBe(at(HOUR).toISOString());
    expect(r.find((f) => f.fingerprint === "y")).toEqual({ ...plain, streak: 0 });
    expect(r.find((f) => f.fingerprint === "y")!.missedAt).toBeUndefined();
  });

  it("the streak counts checks in a row and a missed check resets it", () => {
    let f = mergeFindings([], [input("x")], T0).findings;
    expect(f[0]!.streak).toBe(1);
    f = mergeFindings(f, [input("x")], at(HOUR)).findings;
    expect(f[0]).toMatchObject({ streak: 2, count: 2 });
    f = mergeFindings(f, [], at(2 * HOUR)).findings;
    expect(f[0]).toMatchObject({ streak: 0, count: 2 });
    f = mergeFindings(f, [input("x")], at(3 * HOUR)).findings;
    expect(f[0]).toMatchObject({ streak: 1, count: 3 });
  });

  it("keeps a gone finding with a report or an owed story after 30 days, so a long outage loses nothing", () => {
    const gone = (extra: object, fp: string) => ({ ...mergeFindings([], [input(fp)], T0).findings[0]!, gone: true, ...extra });
    const r = mergeFindings([gone({ report }, "r"), gone({ due: T0.toISOString() }, "d"), gone({}, "p")], [], at(45 * 24 * HOUR)).findings;
    expect(r.map((f) => f.fingerprint).sort()).toEqual(["d", "r"]);
  });

  it("the cap drops what has neither a report nor a due first", () => {
    const mk = (fp: string, extra: object, gone = true) => ({ ...mergeFindings([], [input(fp)], T0).findings[0]!, gone, ...extra });
    const stored = [mk("r", { report }), mk("d", { due: T0.toISOString() }), mk("o", {}, false), ...Array.from({ length: 500 }, (_, i) => mk(`g${i}`, {}))];
    const r = mergeFindings(stored, [], at(HOUR));
    expect(r.findings).toHaveLength(502); // 500 plain ones, and the two that hold a story
    const names = r.findings.map((f) => f.fingerprint);
    expect(names).toEqual(expect.arrayContaining(["r", "d", "o"]));
    expect(r.dropped).toBe(1);
  });

  it("findings with a story do not crowd out new findings, and new findings do not evict them", () => {
    const mk = (i: number) => ({ ...mergeFindings([], [input(`r${i}`)], T0).findings[0]!, gone: true, report });
    const stories = Array.from({ length: 500 }, (_, i) => mk(i));
    const fresh = Array.from({ length: 10 }, (_, i) => input(`n${i}`));
    const r = mergeFindings(stories, fresh, at(HOUR));
    expect(r.findings.filter((f) => f.fingerprint.startsWith("r"))).toHaveLength(500);
    expect(r.findings.filter((f) => f.fingerprint.startsWith("n"))).toHaveLength(10);
    expect(r.dropped).toBe(0);
  });

  it("only archived findings with a story go when there are more than 1,000 of them, never an owed one", () => {
    const mk = (i: number, extra: object) => ({ ...mergeFindings([], [input(`r${i}`)], new Date(T0.getTime() + i)).findings[0]!, gone: true, report, ...extra });
    const stored = [...Array.from({ length: 1001 }, (_, i) => mk(i, {})), mk(2000, { due: T0.toISOString() })];
    const r = mergeFindings(stored, [], at(HOUR));
    expect(r.findings).toHaveLength(1000);
    expect(r.findings.some((f) => f.fingerprint === "r2000")).toBe(true);
    expect(r.findings.some((f) => f.fingerprint === "r0")).toBe(false);
  });

  it("a file without the new fields loads; malformed ones are dropped and the file stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-findings-"));
    try {
      const file = join(dir, "f.json");
      const good = base()[0]!;
      const old = { ...good };
      delete (old as { days?: string[] }).days;
      writeFileSync(file, JSON.stringify({ version: 1, findings: [old, { ...good, fingerprint: "m", days: "x", due: 5, report: { issue: "no" }, missedAt: {} }] }));
      const r = loadFindings(file);
      expect(r.broken).toBe(false);
      expect(r.findings).toHaveLength(2);
      const m = r.findings.find((f) => f.fingerprint === "m")!;
      expect(m.days).toBeUndefined();
      expect(m.due).toBeUndefined();
      expect(m.report).toBeUndefined();
      expect(m.missedAt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the findings file", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "monitor-findings-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a missing file loads as empty and leaves nothing behind", () => {
    const file = join(dir, "f.json");
    expect(loadFindings(file)).toEqual({ findings: [], broken: false });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a broken file loads as empty and its bytes are kept in .broken", () => {
    for (const bytes of ["{not json", JSON.stringify({ findings: [{ nope: 1 }] })]) {
      const file = join(dir, "f.json");
      writeFileSync(file, bytes);
      expect(loadFindings(file)).toEqual({ findings: [], broken: true });
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.broken`, "utf8")).toBe(bytes);
    }
  });

  it("save then load gives the same data, and no .tmp file is left", () => {
    const file = join(dir, "sub", "f.json");
    const { findings } = mergeFindings([], [input("x", { evidence: { counts: { n: 2 }, lines: ["l"] } })], T0);
    saveFindings(findings, file);
    expect(loadFindings(file)).toEqual({ findings, broken: false });
    expect(readdirSync(join(dir, "sub")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
