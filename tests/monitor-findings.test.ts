import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFindings, mergeFindings, saveFindings, type FindingInput } from "../src/monitor/findings.js";

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
