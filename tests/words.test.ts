import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NextKind } from "../src/next-step.js";
import { KINDS, LABEL_WORDS, statusHelp, statusName, watcherState, type WordFacts } from "../src/words.js";

const BANNED = ["hold", "precheck", "area lock", "jump_only"];
const EXPLAIN = "how risky it is to create the smaller issues without you looking, 0–100";

describe("glossary", () => {
  it("has 25 distinct kinds", () => {
    expect(new Set(KINDS).size).toBe(25);
  });

  const rows: [NextKind, WordFacts, string][] = [
    ["questions", {}, "waiting for you — questions"],
    ["planner_questions", {}, "waiting for you — questions"],
    ["approve_plan", {}, "waiting for you — risky plan"],
    ["approve_split", {}, "waiting for you — split"],
    ["approval", {}, "waiting for you — approval"],
    ["stopped", {}, "waiting for you — stopped"],
    ["release", {}, "waiting for you — release pull request"],
    ["release", { releaseAt: "17:00" }, "in develop (ships with the 17:00 release)"],
    ["dependency", { blockers: [88] }, "waiting for #88"],
    ["one_at_a_time", {}, "waiting for another run"],
    ["area_lock", {}, "waiting for another run in the same code"],
    ["usage_limit", {}, "paused — usage limit"],
    ["daily_budget", {}, "paused — daily budget"],
    ["checking", {}, "checking for questions"],
    ["starting", {}, "starting soon"],
    ["queued", {}, "queued"],
    ["running", {}, "working"],
    ["interrupted", {}, "interrupted"],
    ["cancelled", {}, "cancelled"],
    ["failed", {}, "failed"],
    ["watcher_error", {}, "watcher error"],
    ["restart", {}, "restarting soon"],
    ["superseded", {}, "replaced by a newer run"],
    ["done", {}, "done"],
  ];
  it.each(rows)("status of %s %j", (kind, facts, name) => {
    expect(statusName(kind, facts)).toBe(name);
  });

  it("names several or no blockers", () => {
    expect(statusName("dependency", { blockers: [87, 88] })).toBe("waiting for #87, #88");
    expect(statusName("dependency", { blockers: [] })).toBe("waiting for another story");
    expect(statusName("dependency")).toBe("waiting for another story");
  });

  it("has two sentences of help for every kind", () => {
    for (const facts of [{}, { blockers: [87, 88] }, { blockers: [] }, { releaseAt: "17:00" }, { factory: true }] as WordFacts[]) {
      for (const k of KINDS) expect(statusHelp(k, facts), k).toMatch(/^[^.!?]+[.!?] [^.!?]+[.!?]$/);
    }
  });

  it("has its own help for a failure of the Foundry", () => {
    expect(statusHelp("failed")).toMatch(/^A step failed/);
    expect(statusHelp("failed", { factory: true })).toMatch(/^The Foundry itself failed, not the code/);
    expect(statusName("failed", { factory: true })).toBe("failed");
  });

  it("uses no banned word", () => {
    for (const k of KINDS) {
      for (const t of [statusName(k, { blockers: [88] }), statusHelp(k, { blockers: [88] }), statusName(k, { releaseAt: "17:00" }), statusHelp(k, { releaseAt: "17:00" }), statusHelp(k, { factory: true })]) {
        for (const w of BANNED) expect(t.toLowerCase(), `${k}: ${t}`).not.toContain(w);
        if (/split risk/i.test(t)) expect(t).toContain(EXPLAIN);
      }
    }
  });
});

describe("user guide", () => {
  const guide = readFileSync(new URL("../docs/USER_GUIDE.md", import.meta.url), "utf8");
  it("has the glossary with every status name and help", () => {
    expect(guide).toContain("Words the Foundry uses");
    expect(guide).toContain(EXPLAIN);
    for (const k of KINDS) {
      const all: WordFacts[] = k === "release" ? [{}, { releaseAt: "17:00" }] : k === "failed" ? [{}, { factory: true }] : [{ blockers: [88] }];
      for (const f of all) {
        expect(guide, statusName(k, f)).toContain(`| ${statusName(k, f)} |`);
        expect(guide, statusHelp(k, f)).toContain(statusHelp(k, f));
      }
    }
  });
});

describe("label words", () => {
  it("are short, say Foundry and use no banned word", () => {
    expect(Object.keys(LABEL_WORDS)).toHaveLength(8);
    for (const t of Object.values(LABEL_WORDS)) {
      expect(t.length, t).toBeLessThanOrEqual(100);
      expect(t).toContain("Foundry");
      for (const w of BANNED) expect(t.toLowerCase()).not.toContain(w);
      if (/split risk/i.test(t)) expect(t).toContain(EXPLAIN);
    }
  });
});

describe("watcher state words", () => {
  it("are two sentences without banned words", () => {
    for (const name of ["active", "disabled"] as const) {
      const s = watcherState(name);
      expect(s.status).toBe(name);
      expect(s.help).toMatch(/^[^.!?]+[.!?] [^.!?]+[.!?]$/);
      for (const w of BANNED) expect(s.help.toLowerCase()).not.toContain(w);
    }
    expect(watcherState("error")).toEqual({ name: "error", status: statusName("watcher_error"), help: statusHelp("watcher_error") });
  });

  it("are in the guide, which mentions the ? in section 3", () => {
    const guide = readFileSync(new URL("../docs/USER_GUIDE.md", import.meta.url), "utf8");
    for (const name of ["active", "disabled"] as const) expect(guide).toContain(watcherState(name).help);
    const section = guide.slice(guide.indexOf("## 3."), guide.indexOf("## 4."));
    expect(section).toContain("**?**");
  });
});

const shown = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
  .replace(/(^|\s)\/\/.*$/gm, "$1") // line comments (not the // of a URL or a regex)
  .replace(/<!--[\s\S]*?-->/g, "") // HTML comments
  .replace(/class(?:=|: )(?:"[^"]*"|`[^`]*`)/g, "") // class names
  .replace(/\bplaceholder\b/g, "") // the attribute name
  .replace(/\.holds\b|\.jump_only\b|setKey\(step, "jump_only"/g, ""); // property names and the flow key passed to setKey

describe("words in the app", () => {
  const dir = new URL("../ui/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js") || f === "index.html");

  it("scan helper keeps real text and drops names", () => {
    expect(shown('h("li", { class: "holds" }, w.status?.holds, step.jump_only, "On hold")').toLowerCase()).toContain("hold");
    const none = shown('{ class: "hold-link", placeholder: "x" } // hold').toLowerCase();
    for (const w of BANNED) expect(none).not.toContain(w);
    expect(shown('h("span", {}, "jump_only")').toLowerCase()).toContain("jump_only");
  });

  it.each(files)("%s has no internal words", (f) => {
    const src = shown(readFileSync(new URL(f, dir), "utf8")).toLowerCase();
    for (const w of BANNED) expect(src, `${f}: ${w}`).not.toContain(w);
  });

  it("ui/ has no glossary text of its own", () => {
    const all = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    const texts = [...KINDS.map((k) => statusHelp(k)), ...KINDS.map((k) => statusName(k)).filter((n) => n.includes(" ")), watcherState("active").help, watcherState("disabled").help];
    for (const t of texts) expect(all, t).not.toContain(t);
  });
});
