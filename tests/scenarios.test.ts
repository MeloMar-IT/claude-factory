import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { firstLine } from "../src/next-step.js";
import { sampleClarity } from "../src/server/clarity.js";
import { turnFor } from "../src/server/your-turn.js";
import { needsUser } from "../src/your-turn.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { NOW, SCENARIOS, scenarioCtx, run, type Scenario, type World } from "./helpers/scenarios.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Real situations against the next-step module and the Your turn page.

let restoreDom: () => void;
let ui: any;
beforeAll(async () => {
  restoreDom = installFakeDom();
  ui = await import("../ui/turn.js" as string);
});
afterAll(() => restoreDom());

let home: string;
const savedHome = process.env.FACTORY_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scenarios-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const listed = (s: Scenario, world: World = s.world) => {
  const data = turnFor(scenarioCtx(world), NOW).data;
  const items = data.groups.flatMap((g) => g.items);
  return { data, items, item: items.find((i) => i.next.kind === s.record().kind) };
};

describe("the list", () => {
  it("has unique ids, at least 12 scenarios, exactly 5 for the check sheet, and a real case and source for each", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(12);
    expect(SCENARIOS.filter((s) => s.sheet)).toHaveLength(5);
    for (const s of SCENARIOS) {
      expect(s.realCase.trim(), s.id).not.toBe("");
      expect(s.source.trim(), s.id).not.toBe("");
    }
  });
});

describe("the check sheet", () => {
  const sheet = readFileSync("docs/USABILITY_CHECK.md", "utf8");

  it("shows the action and the reason of the five sheet scenarios, and names every scenario with its source", () => {
    for (const s of SCENARIOS.filter((x) => x.sheet)) {
      expect(sheet, s.id).toContain(s.expect.action);
      expect(sheet, s.id).toContain(s.record().why);
    }
    for (const s of SCENARIOS) {
      expect(sheet).toContain(`\`${s.id}\``);
      expect(sheet).toContain(s.source);
    }
    expect(sheet).toContain("Next step 11b — Usability check with the owner: 5 scenarios, 10 seconds each");
  });
});

describe.each(SCENARIOS.map((s) => [s.id, s] as const))("scenario %s", (_id, s) => {
  it("the record has the expected who, action and sentence", () => {
    const r = s.record();
    expect({ who: r.who, action: r.action, text: r.text }).toEqual({ who: s.expect.who, action: s.expect.action, text: s.expect.text });
  });

  it("the first line of a comment says what to do, or that nothing is needed", () => {
    const r = s.record();
    if (needsUser(r)) expect(firstLine(r)).toBe(`**What you need to do:** ${r.action}.`);
    else expect(firstLine(r)).toMatch(/^\*\*Nothing needed from you\*\*/);
  });

  it("the action starts with Nothing exactly when the user has nothing to do", () => {
    const r = s.record();
    expect(r.action.startsWith("Nothing")).toBe(!needsUser(r));
    expect(needsUser(r)).toBe(s.expect.yourTurn);
  });

  it("Your turn lists it exactly when expected, with the same words and buttons", () => {
    const { item } = listed(s);
    expect(!!item).toBe(s.expect.yourTurn);
    if (!item) return;
    expect(item.next.action).toBe(s.expect.action);
    expect(item.next.text).toBe(s.expect.text);
    if (s.expect.dismissable !== undefined) expect(item.dismissable).toBe(s.expect.dismissable);
  });

  it("the page shows the action and the reason, the buttons and the link", () => {
    const data = JSON.parse(JSON.stringify(turnFor(scenarioCtx(s.world), NOW).data));
    const root = new FakeElement("div");
    root.append(...(ui.turnView(data, { onDismiss: vi.fn(), onRestore: vi.fn(), onLeave: vi.fn(), onAct: vi.fn() }) as unknown[]).filter(Boolean) as FakeElement[]);
    const item = listed(s).item;
    if (!item) {
      if (data.count === 0) expect(root.textContent).toContain(data.empty);
      return;
    }
    const box = root.all("div").find((d) => d.attrs.class === "turn-item" && d.textContent.includes(item.next.why))!;
    expect(box.textContent).toContain(s.expect.action);
    expect(box.textContent).toContain(item.next.why);
    expect(box.all("button").map((b) => b.textContent).filter((t) => t !== "Dismiss")).toEqual(s.expect.buttons);
    expect(box.all("a").find((a) => a.attrs.class?.includes("btn"))?.textContent).toBe(s.expect.link);
  });

  it("the measure sees nothing missing", () => {
    const ctx = scenarioCtx(s.world);
    sampleClarity(ctx, NOW);
    const state = sampleClarity(ctx, new Date(NOW.getTime() + 60_000))!;
    expect(state.missed).toBe(0);
  });
});

describe("details", () => {
  const by = (id: string) => SCENARIOS.find((s) => s.id === id)!;

  it("waits-for-stories: the waiting story is not listed, the stories it waits for are", () => {
    const { items } = listed(by("waits-for-stories"));
    const issues = items.map((i) => i.next.issue);
    expect(issues).not.toContain(21);
    expect(issues).toEqual(expect.arrayContaining([61, 11, 64]));
  });

  it("closed-while-working: listed while the run works, gone when it ends, and it can be dismissed", () => {
    const s = by("closed-while-working");
    expect(listed(s).item?.next.runId).toBe("r8");
    expect(listed(s).item?.dismissable).toBe(true);
    const ended = { ...s.world, runs: [run("r8", { vars: { github_repo: "acme/app", issue: "8" }, status: "succeeded" })], active: [] };
    expect(listed(s, ended).item).toBeUndefined();
  });

  it("closed-while-working: also listed while the run waits for approval", () => {
    const s = by("closed-while-working");
    const waiting = { ...s.world, runs: [run("r8", { vars: { github_repo: "acme/app", issue: "8" }, status: "waiting", finishedAt: undefined })], active: [] };
    expect(listed(s, waiting).item?.next.runId).toBe("r8");
  });

  it("closed-while-working: a queued run has no run page, so the link goes to the Runs page, and the measure sees it", () => {
    const s = by("closed-while-working");
    const queued = { ...s.world, runs: [], active: [], pending: ["r8"] };
    const item = listed(s, queued).item!;
    expect(item.next.runId).toBe("r8");
    expect(item.next.where).toEqual({ label: "Runs page", url: "#/runs" });
    // Your turn dropped it: the measure counts the omission.
    const ctx = scenarioCtx(queued);
    const turn = turnFor(ctx, NOW);
    const cut = { all: [] as typeof turn.all, data: { ...turn.data, count: 0, groups: [], continuing: [] } };
    sampleClarity(ctx, NOW, cut);
    expect(sampleClarity(ctx, new Date(NOW.getTime() + 60_000), cut)!.missed).toBe(1);
  });

  it("watcher-error: cannot be dismissed", () => {
    expect(listed(by("watcher-error")).item?.dismissable).toBe(false);
  });

  it("release-pr: one item for the pull request, named by its title", () => {
    const { items } = listed(by("release-pr"));
    expect(items).toHaveLength(1);
    expect(items[0]!.what).toBe("Release 2 Oct");
  });

  it("working: the empty page says what is being built", () => {
    expect(listed(by("working")).data.empty).toBe("Nothing needs you. 1 story is being built.");
  });
});
