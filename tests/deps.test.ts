import { describe, expect, it } from "vitest";
import { dependencies, dependencyText, openDependencies } from "../src/queue/deps.js";

const all = [
  { number: 1, title: "Story 1 — Publish update metadata", state: "CLOSED" },
  { number: 2, title: "Story 2 — Check for updates", state: "CLOSED" },
  { number: 12, title: "Story 12 — Audit and monitor updates", state: "OPEN" },
  { number: 6, title: "Story 6 — Prepare for installation", state: "OPEN", labels: [{ name: "Factory_done" }] },
  { number: 7, title: "Story 7 — Install the update", state: "OPEN" },
];

describe("issue dependencies", () => {
  it("reads a Depends on section up to the next heading", () => {
    expect(dependencyText("x\n### Depends on\nStory 4.\n\n### Notes\nabc")).toBe("Story 4.");
    expect(dependencyText("Depends on: #3, #4\nmore")).toContain("#3, #4");
    expect(dependencyText("Blocked by #9")).toBe("#9");
    expect(dependencyText("nothing here")).toBe("");
  });

  it("matches #N references and issue titles, not prefixes of other numbers", () => {
    const body = "### Depends on\nStory 6 — Prepare for installation; Story 7 — Install the update; #2\n";
    expect(dependencies(body, 12, all)).toEqual([2, 6, 7]);
    expect(dependencies("### Depends on\nStory 1 — Publish update metadata.", 5, all)).toEqual([1]);
    expect(dependencies("### Depends on\nStory 2 — Check for updates (for status to reflect against).", 5, all)).toEqual([2]);
    expect(dependencies("### Depends on\nNone", 5, all)).toEqual([]);
    expect(dependencies("### Depends on\n#12", 12, all)).toEqual([]); // not itself
  });

  it("finds a dependency named by a shortened title inside a longer one", () => {
    const web = [
      ...all,
      { number: 91, title: "Website Story 1 — Website source lives in this repo", state: "OPEN" },
      { number: 97, title: "Website Story 7 — Daily check for new GitHub releases", state: "OPEN" },
      { number: 99, title: "Website Story 9 — Deployment script to the web server", state: "OPEN" },
    ];
    expect(dependencies("### Depends on\nStory 7 — Daily check for new GitHub releases; Story 9 — Deployment script.", 100, web)).toEqual([97, 99]);
    // A title that starts with the text still wins (no extra matches): "Story 7 — Install the update" is #7 here.
    expect(dependencies("### Depends on\nStory 7 — Install the update", 5, web)).toEqual([7]);
    expect(dependencies("### Depends on\nStory 1 — Website source lives in this repo.", 93, web)).toEqual([91]);
    // Reworded title: the same story number in the issue's own epic.
    const web2 = [...web, { number: 95, title: "Website Story 5 — Public changelog page", state: "OPEN" },
      { number: 96, title: "Website Story 6 — Automatically generate the changelog from releases", state: "OPEN" }];
    expect(dependencies("### Depends on\nStory 6 — Automatically generate the changelog from new releases.", 95, web2)).toEqual([96]);
  });

  it("counts closed issues and done labels as done; ignores unknown issues", () => {
    expect(openDependencies([1, 6, 7, 99], all, ["Factory_done"])).toEqual([7]);
    expect(openDependencies([6], all, [])).toEqual([6]);
  });
});
