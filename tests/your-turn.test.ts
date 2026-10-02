import { describe, expect, it } from "vitest";
import { nextStep, type NextKind, type NextStep } from "../src/next-step.js";
import { actsFor, buildTurn, emptyText, needsUser, runOrigin, soonestAt, type TurnSource } from "../src/your-turn.js";

const rec = (kind: NextKind, base: { repo?: string; issue?: number; title?: string; runId?: string } = {}, data = {}) =>
  nextStep(kind, { repo: "o/a", ...base }, { watched: true, issueUrl: base.issue ? `https://github.com/o/a/issues/${base.issue}` : undefined, ...data });

const src = (next: NextStep, over: Partial<TurnSource> = {}): TurnSource => ({
  key: `${next.repo}#${next.issue ?? ""}|${next.kind}|${next.runId ?? ""}`, next, stamp: over.since ?? "", dismissable: true, ...over,
});

describe("needsUser", () => {
  it("is true for what waits for the user", () => {
    for (const k of ["questions", "approval", "failed", "stopped"] as NextKind[]) expect(needsUser(rec(k, { issue: 1, runId: "r" })), k).toBe(true);
    expect(needsUser(rec("release", {}, { pr: { number: 4, url: "https://github.com/o/a/pull/4" } }))).toBe(true);
  });
  it("is false for running, queued, waiting and finished work", () => {
    for (const k of ["running", "queued", "dependency", "usage_limit", "daily_budget", "done", "superseded", "cancelled"] as NextKind[]) {
      expect(needsUser(rec(k, { issue: 1, runId: "r" })), k).toBe(false);
    }
    expect(needsUser(rec("release", { issue: 1 }, { releaseAt: "17:00" }))).toBe(false);
  });
});

describe("runOrigin", () => {
  it("tells who started a run", () => {
    for (const s of ["ui", "ui approve", "cli"]) expect(runOrigin(s)).toBe("hand");
    expect(runOrigin("watcher a issue #7")).toBe("watcher");
    expect(runOrigin("eval smoke")).toBe("eval");
    expect(runOrigin(undefined)).toBe("unknown");
    expect(runOrigin("x")).toBe("unknown");
  });
});

describe("buildTurn", () => {
  it("lists nothing when nothing needs the user", () => {
    const t = buildTurn([src(rec("running", { issue: 1 })), src(rec("queued", { issue: 2 }))]);
    expect(t.data.count).toBe(0);
    expect(t.data.groups).toEqual([]);
  });

  it("counts the stories an item holds back, through other stories, and survives a cycle", () => {
    const dep = (issue: number, on: number) => rec("dependency", { issue }, { blockers: [{ issue: on }] });
    const sources = [
      src(rec("questions", { issue: 3, title: "Three" }), { since: "2026-10-01T10:00:00Z" }),
      src(dep(5, 3)), src(dep(7, 5)), src(dep(9, 3)),
      src(rec("approval", { issue: 20, title: "Old" }), { since: "2026-09-01T10:00:00Z" }),
    ];
    const items = buildTurn(sources).data.groups[0]!.items;
    expect(items.map((i) => [i.next.issue, i.unblocks])).toEqual([[3, 3], [20, 0]]);
    const cycle = [src(rec("questions", { issue: 1 })), src(dep(2, 1)), src(dep(1, 2))];
    expect(buildTurn(cycle).data.groups[0]!.items[0]!.unblocks).toBe(1);
  });

  it("puts the older item first, and an item without a time last", () => {
    const items = buildTurn([
      src(rec("questions", { issue: 1 })),
      src(rec("questions", { issue: 2 }), { since: "2026-10-01T10:00:00Z" }),
      src(rec("questions", { issue: 3 }), { since: "2026-09-30T10:00:00Z" }),
    ]).data.groups[0]!.items;
    expect(items.map((i) => i.next.issue)).toEqual([3, 2, 1]);
  });

  it("groups by repository, ordered by the top item, and names an empty one Other", () => {
    const b = (issue: number, repo: string, since: string) => src(rec("questions", { issue, repo }), { since });
    const t = buildTurn([b(1, "o/b", "2026-10-01T10:00:00Z"), b(2, "o/a", "2026-09-01T10:00:00Z"), b(3, "", "2026-09-15T10:00:00Z")]);
    expect(t.data.groups.map((g) => g.repo)).toEqual(["o/a", "Other", "o/b"]);
  });

  it("counts stories that depend on release-held stories too", () => {
    const pr = { number: 9, url: "https://github.com/o/a/pull/9" };
    const dep = (issue: number, on: number) => rec("dependency", { issue }, { blockers: [{ issue: on }] });
    const sources = [src(rec("release", { issue: 1 }, { pr })), src(rec("release", { issue: 2 }, { pr })), src(dep(3, 1)), src(dep(4, 3)), src(dep(5, 2)), src(dep(6, 5))];
    expect(buildTurn(sources).data.groups[0]!.items[0]!.unblocks).toBe(6);
  });

  it("joins the release records of one pull request into one item", () => {
    const pr = { number: 9, url: "https://github.com/o/a/pull/9" };
    const sources = [
      src(rec("release", { issue: 1 }, { pr }), { since: "2026-09-30T08:00:00Z", prTitle: "Daily 30 Sep" }),
      src(rec("release", { issue: 2 }, { pr }), { since: "2026-09-30T09:00:00Z" }),
      src(rec("release", { issue: 3 }, { pr })),
      src(rec("release", {}, { pr }), { since: "2026-09-29T08:00:00Z", prTitle: "Daily 30 Sep" }),
    ];
    const t = buildTurn(sources).data;
    expect(t.count).toBe(1);
    const item = t.groups[0]!.items[0]!;
    expect(item.what).toBe("Daily 30 Sep");
    expect(item.next.issue).toBeUndefined();
    expect(item.unblocks).toBe(3);
    expect(item.since).toBe("2026-09-29T08:00:00Z");
    const other = rec("release", { issue: 4 }, { pr: { number: 10, url: "https://github.com/o/a/pull/10" } });
    expect(buildTurn([...sources, src(other)]).data.count).toBe(2);
  });

  it("shows one item for the same key from an issue and a run", () => {
    const n = rec("failed", { issue: 4, runId: "r" });
    expect(buildTurn([src(n), src(n)]).data.count).toBe(1);
  });

  it("hides what was dismissed while its time is the same", () => {
    const s = src(rec("questions", { issue: 1 }), { since: "2026-10-01T10:00:00Z" });
    expect(buildTurn([s], { dismissed: { [s.key]: { since: "2026-10-01T10:00:00Z" } } }).data).toMatchObject({ count: 0, dismissed: 1 });
    expect(buildTurn([s], { dismissed: { [s.key]: { since: "2026-09-01T10:00:00Z" } } }).data).toMatchObject({ count: 1, dismissed: 0 });
    const fixed = src(rec("watcher_error", {}), { since: "2026-10-01T10:00:00Z", dismissable: false });
    expect(buildTurn([fixed], { dismissed: { [fixed.key]: { since: "2026-10-01T10:00:00Z" } } }).data.count).toBe(1);
  });

  it("a source without a real time stays hidden when only its shown time changes", () => {
    const n = rec("failed", { issue: 8 });
    const a = src(n, { since: "2026-10-01T10:00:00Z", stamp: "" });
    const b = src(n, { since: "2026-10-01T11:00:00Z", stamp: "" });
    expect(buildTurn([b], { dismissed: { [a.key]: { since: "" } } }).data.count).toBe(0);
  });

  it("sets the empty text only when nothing is listed, also when all is dismissed", () => {
    expect(buildTurn([src(rec("questions", { issue: 1 }))]).data.empty).toBeUndefined();
    const s = src(rec("questions", { issue: 1 }));
    const t = buildTurn([s], { dismissed: { [s.key]: { since: "" } }, building: 2 }).data;
    expect(t.empty).toBe("Nothing needs you. 2 stories are being built.");
  });
});

describe("actsFor and acted items", () => {
  const w = (n: NextStep) => src(n, { watcher: "a" });
  it("gives the actions per kind, and none without a watcher, an issue or for a joined release", () => {
    expect(actsFor("questions", "a", 1)).toEqual(["defaults", "answer"]);
    expect(actsFor("planner_questions", "a", 1)).toEqual(["answer"]);
    for (const k of ["approve_plan", "approve_split", "approval"] as NextKind[]) expect(actsFor(k, "a", 1)).toEqual(["approve", "reject"]);
    expect(actsFor("failed", "a", 1)).toEqual(["retry", "retry_hint"]);
    expect(actsFor("questions", undefined, 1)).toEqual([]);
    expect(actsFor("questions", "a", undefined)).toEqual([]);
    expect(actsFor("stopped", "a", 1)).toEqual([]);
    const pr = { number: 4, url: "https://github.com/o/a/pull/4" };
    const t = buildTurn([w(rec("release", { issue: 1 }, { pr })), w(rec("release", {}, { pr }))]);
    expect(t.data.groups[0]!.items[0]!.acts).toEqual([]);
  });

  it("moves an item acted on at the same stamp to continuing", () => {
    const s = w(rec("questions", { issue: 1 }));
    const other = w(rec("questions", { issue: 2 }));
    const t = buildTurn([s], { acted: { [s.key]: { since: "" } } }).data;
    expect(t.count).toBe(0);
    expect(t.groups).toEqual([]);
    expect(t.dismissed).toBe(0);
    expect(t.empty).toBeDefined();
    expect(t.continuing!.map((i) => i.key)).toEqual([s.key]);
    const two = buildTurn([s, other], { acted: { [s.key]: { since: "" } } }).data;
    expect(two.count).toBe(1);
    expect(two.empty).toBeUndefined();
  });

  it("keeps the item when its stamp changed", () => {
    const s = w(rec("questions", { issue: 1 }));
    const t = buildTurn([{ ...s, stamp: "2026-10-01T10:00:00Z" }], { acted: { [s.key]: { since: "2026-10-01T09:00:00Z" } } }).data;
    expect(t.count).toBe(1);
    expect(t.continuing).toBeUndefined();
  });
});

describe("emptyText", () => {
  it("has four forms", () => {
    expect(emptyText(0)).toBe("Nothing needs you.");
    expect(emptyText(0, "17:00")).toBe("Nothing needs you.");
    expect(emptyText(1)).toBe("Nothing needs you. 1 story is being built.");
    expect(emptyText(4)).toBe("Nothing needs you. 4 stories are being built.");
    expect(emptyText(4, "17:00")).toBe("Nothing needs you. 4 stories are being built; the next thing for you is expected around 17:00 (release pull request).");
    expect(emptyText(1, "17:00")).toContain("1 story is being built;");
  });
});

describe("soonestAt", () => {
  it("picks the next time after now", () => {
    const now = new Date("2026-10-01T14:00:00Z"); // 16:00 in Amsterdam (summer time), 10:00 in New York
    const t = (at: string, timezone?: string) => ({ at, timezone });
    expect(soonestAt([t("09:00", "Europe/Amsterdam"), t("17:00", "Europe/Amsterdam")], now)).toBe("17:00");
    expect(soonestAt([t("09:00", "Europe/Amsterdam"), t("x")], now)).toBe("09:00");
    expect(soonestAt([], now)).toBeUndefined();
    // 12:00 in New York is in 2 hours; 17:00 in Amsterdam is in 1 hour; 16:30 Amsterdam is in 30 minutes.
    expect(soonestAt([t("17:00", "Europe/Amsterdam"), t("12:00", "America/New_York")], now)).toBe("17:00");
    expect(soonestAt([t("11:00", "America/New_York"), t("19:00", "Europe/Amsterdam")], now)).toBe("11:00");
  });
});
