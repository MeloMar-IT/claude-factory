import { describe, expect, it } from "vitest";
import { Throttle, retryAfter, throttleText, verdictText, waitAfter, worst } from "../src/server/sign-in-throttle.js";

const S = 1000;
const MIN = 60 * S;

function make(opts: { lock?: boolean; cap?: number } = {}) {
  const clock = { now: 1_000_000 };
  const t = new Throttle({ ...opts, now: () => clock.now });
  return { t, clock };
}
const countN = (t: Throttle, key: string, n: number, keep = false) => {
  for (let i = 0; i < n; i++) t.count(key, { keep });
};

describe("waitAfter", () => {
  it("is 0 for 1 to 4, doubles from 1 s for 5 to 10, and stays at 60 s", () => {
    expect([1, 2, 3, 4].map(waitAfter)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10].map(waitAfter)).toEqual([1, 2, 4, 8, 16, 32].map((s) => s * S));
    expect(waitAfter(11)).toBe(60 * S);
    expect(waitAfter(19)).toBe(60 * S);
  });
});

describe("check and count", () => {
  it("is open, then waits, then is open again when the wait is over", () => {
    const { t, clock } = make();
    countN(t, "a", 4);
    expect(t.check("a")).toEqual({ kind: "open" });
    t.count("a");
    expect(t.check("a")).toEqual({ kind: "wait", waitMs: 1 * S });
    clock.now += 400;
    expect(t.check("a")).toEqual({ kind: "wait", waitMs: 600 });
    clock.now += 600;
    expect(t.check("a")).toEqual({ kind: "open" });
    t.count("a");
    expect(t.check("a")).toEqual({ kind: "wait", waitMs: 2 * S });
  });

  it("locks for 30 minutes at the 20th count, and forgets the entry after that", () => {
    const { t, clock } = make();
    countN(t, "a", 19);
    expect(t.lockedUntilOf("a")).toBeUndefined();
    const at = clock.now;
    t.count("a");
    expect(t.lockedUntilOf("a")).toBe(at + 30 * MIN);
    expect(t.check("a")).toEqual({ kind: "locked", waitMs: 30 * MIN });
    clock.now += 30 * MIN;
    expect(t.check("a")).toEqual({ kind: "open" });
    expect(t.countOf("a")).toBe(0);
    expect(t.size).toBe(0);
  });

  it("does not lock without `lock`: 25 counts keep the wait at 60 s", () => {
    const { t } = make({ lock: false });
    countN(t, "a", 25);
    expect(t.lockedUntilOf("a")).toBeUndefined();
    expect(t.check("a")).toEqual({ kind: "wait", waitMs: 60 * S });
  });

  it("clear unlocks, and an entry is forgotten 30 minutes after its last try", () => {
    const { t, clock } = make();
    countN(t, "a", 20);
    t.clear("a");
    expect(t.check("a")).toEqual({ kind: "open" });
    expect(t.size).toBe(0);
    countN(t, "b", 3);
    clock.now += 30 * MIN - 1;
    expect(t.countOf("b")).toBe(3);
    clock.now += 1;
    expect(t.countOf("b")).toBe(0);
  });
});

describe("giving a try back", () => {
  it("leaves no entry after one count", () => {
    const { t } = make();
    t.count("a").giveBack();
    expect(t.size).toBe(0);
  });

  it("keeps the earlier state when a later count is given back", () => {
    const { t, clock } = make();
    countN(t, "a", 7);
    const before = t.check("a");
    clock.now += 100;
    t.count("a").giveBack();
    expect(t.countOf("a")).toBe(7);
    expect(t.check("a")).toEqual({ kind: "wait", waitMs: (before as { waitMs: number }).waitMs - 100 });
  });

  it("does not extend the life of earlier tries", () => {
    const { t, clock } = make();
    countN(t, "a", 2);
    clock.now += 30 * MIN - 10;
    t.count("a").giveBack();
    clock.now += 10;
    expect(t.countOf("a")).toBe(0);
    expect(t.size).toBe(0);
  });

  it("leaves no entry after five counts given back in any order", () => {
    const { t } = make();
    const tries = Array.from({ length: 5 }, () => t.count("a"));
    for (const i of [3, 0, 4, 1, 2]) tries[i]!.giveBack();
    expect(t.size).toBe(0);
    expect(t.check("a")).toEqual({ kind: "open" });
  });

  it("does nothing the second time, after clear, and on a locked entry", () => {
    const { t } = make();
    countN(t, "a", 2);
    const one = t.count("a");
    one.giveBack();
    one.giveBack();
    expect(t.countOf("a")).toBe(2);

    const two = t.count("b");
    t.clear("b");
    t.count("b");
    two.giveBack();
    expect(t.countOf("b")).toBe(1);

    countN(t, "c", 19);
    const last = t.count("c");
    last.giveBack();
    expect(t.lockedUntilOf("c")).toBeDefined();
    expect(t.countOf("c")).toBe(20);
  });
});

describe("cap pressure", () => {
  it("keeps a kept entry with 19 counts, and its 20th count locks", () => {
    const { t } = make({ cap: 3 });
    countN(t, "kept", 19, true);
    for (let i = 0; i < 20; i++) t.count(`new-${i}`);
    expect(t.countOf("kept")).toBe(19);
    t.count("kept", { keep: true });
    expect(t.lockedUntilOf("kept")).toBeDefined();
  });

  it("keeps a kept locked entry locked", () => {
    const { t } = make({ cap: 3 });
    countN(t, "kept", 20, true);
    for (let i = 0; i < 20; i++) t.count(`new-${i}`);
    expect(t.check("kept").kind).toBe("locked");
  });

  it("never drops kept entries, also when the cap holds only kept ones", () => {
    const { t } = make({ cap: 3 });
    countN(t, "k1", 20, true);
    countN(t, "k2", 20, true);
    countN(t, "k3", 5, true);
    t.count("new-1");
    t.count("new-2");
    expect(["k1", "k2"].map((k) => t.check(k).kind)).toEqual(["locked", "locked"]);
    expect(t.countOf("k3")).toBe(5);
    expect(t.countOf("new-2")).toBe(1);
    expect(t.countOf("new-1")).toBe(0);
  });

  it("drops the oldest unlocked entry without `keep` first", () => {
    const { t } = make({ cap: 3 });
    t.count("a");
    t.count("b");
    t.count("c");
    t.count("d");
    expect([t.countOf("a"), t.countOf("b"), t.countOf("c"), t.countOf("d")]).toEqual([0, 1, 1, 1]);
  });

  it("drops an unlocked entry before two locked ones", () => {
    const { t } = make({ cap: 3 });
    countN(t, "l1", 20);
    countN(t, "u", 1);
    countN(t, "l2", 20);
    t.count("new");
    expect(t.countOf("u")).toBe(0);
    expect(t.check("l1").kind).toBe("locked");
    expect(t.check("l2").kind).toBe("locked");
    expect(t.countOf("new")).toBe(1);
  });

  it("drops the oldest locked entry when all are locked", () => {
    const { t } = make({ cap: 3 });
    countN(t, "l1", 20);
    countN(t, "l2", 20);
    countN(t, "l3", 20);
    t.count("l4");
    expect(t.size).toBe(3);
    expect(t.check("l1").kind).toBe("open");
    expect(t.check("l2").kind).toBe("locked");
    expect(t.check("l3").kind).toBe("locked");
    expect(t.countOf("l4")).toBe(1);
  });

  it("drops entries that are over when a new one is added", () => {
    const { t, clock } = make({ cap: 3 });
    t.count("a");
    t.count("b");
    clock.now += 30 * MIN - 1;
    t.count("c");
    clock.now += 1;
    t.count("d");
    expect(t.size).toBe(2);
    expect([t.countOf("c"), t.countOf("d")]).toEqual([1, 1]);
  });
});

describe("worst, text and Retry-After", () => {
  it("ranks locked over wait over open, and the longer of two", () => {
    const open = { kind: "open" } as const;
    expect(worst(open, open)).toEqual(open);
    expect(worst(open, { kind: "wait", waitMs: 5 })).toEqual({ kind: "wait", waitMs: 5 });
    expect(worst({ kind: "wait", waitMs: 5 }, { kind: "wait", waitMs: 9 })).toEqual({ kind: "wait", waitMs: 9 });
    expect(worst({ kind: "wait", waitMs: 99 }, { kind: "locked", waitMs: 5 })).toEqual({ kind: "locked", waitMs: 5 });
    expect(worst({ kind: "locked", waitMs: 5 }, { kind: "locked", waitMs: 9 })).toEqual({ kind: "locked", waitMs: 9 });
  });

  it("writes singular and plural, seconds and minutes", () => {
    expect([1 * S, 8 * S, 60 * S, 61 * S, 30 * MIN].map(throttleText)).toEqual(["1 second", "8 seconds", "1 minute", "2 minutes", "30 minutes"]);
    expect(verdictText({ kind: "wait", waitMs: 1000 })).toBe("too many tries; try again in 1 second");
    expect(verdictText({ kind: "locked", waitMs: 30 * MIN })).toBe("too many wrong tries; this account is locked for 30 minutes");
  });

  it("gives Retry-After as at least 1", () => {
    expect(retryAfter(1)).toBe(1);
    expect(retryAfter(0)).toBe(1);
    expect(retryAfter(1500)).toBe(2);
  });
});
