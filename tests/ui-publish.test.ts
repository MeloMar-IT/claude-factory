import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let editor: any;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  editor = await import("../ui/editor.js" as string);
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const STEPS = [{ id: "a", type: "shell", run: "echo" }];
const make = (extra: Record<string, unknown> = {}): any => ({ name: "t", steps: structuredClone(STEPS), vars: { x: "vx", y: "" }, ...extra });

/** Renders the panel; `changes` counts onChange calls and `draws` counts rerender calls. */
function panel(flow: any) {
  const count = { changes: 0, draws: 0 };
  const el: FakeElement = editor.publishPanel(flow, () => count.changes++, () => count.draws++);
  return { el, count };
}
const input = (el: FakeElement, placeholder: string) => el.all("input").find((i) => i.attrs.placeholder === placeholder)!;
const box = (el: FakeElement, label: string) =>
  el.all("label").find((l) => l.textContent.includes(label))!.all("input")[0] as any;
const type = (i: FakeElement, v: string) => { i.value = v; i.fire("input", { target: i }); };
const toggle = (i: any, on: boolean) => { i.checked = on; i.fire("change", { target: i }); };
const pick = (el: FakeElement, n: number, v: string) => { const s = el.all("select")[n]!; s.value = v; s.fire("change", { target: s }); };

describe("publishPanel", () => {
  it("sets enabled with its checkbox", () => {
    const flow = make();
    const { el, count } = panel(flow);
    expect(el.all("summary")[0]!.textContent).toBe("Publish to users");
    toggle(box(el, "Available to users"), true);
    expect(flow.publish.enabled).toBe(true);
    expect(count.draws).toBe(1);
    toggle(box(el, "Available to users"), false);
    expect(flow.publish.enabled).toBeUndefined();
  });

  it("shows the version when enabled", () => {
    const { el } = panel(make({ publish: { enabled: true, version: 3 } }));
    expect(el.all("summary")[0]!.textContent).toBe("Publish to users — version 3");
  });

  it("has a row for every variable", () => {
    const { el } = panel(make());
    expect(el.all("select")).toHaveLength(2);
  });

  it("shows no label or help controls for an explicit hidden entry", () => {
    const { el } = panel(make({ publish: { vars: { x: { mode: "hidden" } } } }));
    expect(input(el, "x")).toBeUndefined();
    expect(el.all("input").filter((i) => i.attrs.type !== "checkbox" && i.attrs.placeholder !== "t" && i.attrs.placeholder !== "")).toHaveLength(0);
  });

  it("creates an input, and removes the entry for hidden", () => {
    const flow = make();
    const { el } = panel(flow);
    pick(el, 0, "input");
    expect(flow.publish.vars.x).toEqual({ mode: "input" });
    pick(el, 0, "hidden");
    expect(flow.publish.vars.x).toBeUndefined();
  });

  it("writes label and required through", () => {
    const flow = make({ publish: { vars: { x: { mode: "input" } } } });
    const { el } = panel(flow);
    type(input(el, "x"), "Name");
    expect(flow.publish.vars.x.label).toBe("Name");
    toggle(box(el, "Required"), true);
    expect(flow.publish.vars.x.required).toBe(true);
  });

  it("keeps an empty own default", () => {
    const flow = make({ publish: { vars: { x: { mode: "input" } } } });
    const { el, count } = panel(flow);
    expect(el.textContent).toContain("Uses the flow's value: vx");
    toggle(box(el, "Own default"), true);
    expect(flow.publish.vars.x.default).toBe("");
    expect(count.draws).toBe(1);

    const shown = panel(flow).el;
    const own = input(shown, "default value");
    type(own, "hello");
    expect(flow.publish.vars.x.default).toBe("hello");
    type(own, "");
    expect(flow.publish.vars.x).toHaveProperty("default", "");
    toggle(box(shown, "Own default"), false);
    expect(flow.publish.vars.x).not.toHaveProperty("default");
  });
});

describe("setPublishMode", () => {
  it("drops default and required when an input becomes fixed, and keeps the label", () => {
    const flow = make({ publish: { vars: { x: { mode: "input", label: "L", default: "d", required: true } } } });
    editor.setPublishMode(flow, "x", "fixed");
    expect(flow.publish.vars.x).toEqual({ mode: "fixed", label: "L" });
  });
});

describe("movePublishVar", () => {
  it("follows a rename and keeps the order", () => {
    const flow = make({ publish: { vars: { x: { mode: "fixed" }, y: { mode: "fixed" } } } });
    editor.movePublishVar(flow, "x", "z");
    expect(Object.keys(flow.publish.vars)).toEqual(["z", "y"]);
  });
  it("removes an entry", () => {
    const flow = make({ publish: { vars: { x: { mode: "fixed" } } } });
    editor.movePublishVar(flow, "x", undefined);
    expect(flow.publish.vars).toEqual({});
    editor.movePublishVar(make(), "x", undefined);
  });
});

describe("cleanFlow", () => {
  it("keeps empty values in vars and in publish defaults", () => {
    const out = editor.cleanFlow(make({ vars: { issue: "" }, publish: { enabled: true, vars: { issue: { mode: "input", default: "" } } } }));
    expect(out.vars).toEqual({ issue: "" });
    expect(out.publish.vars.issue.default).toBe("");
    expect(parseFlow(JSON.stringify(out)).publish?.vars.issue).toEqual({ mode: "input", default: "" });
  });
  it("drops an empty publish and empty vars", () => {
    const out = editor.cleanFlow(make({ vars: {}, publish: { vars: {} } }));
    expect(out).not.toHaveProperty("publish");
    expect(out).not.toHaveProperty("vars");
  });
});

describe("versionRow", () => {
  it("is null without publish and shows the number with it", () => {
    expect(runs.versionRow({ flowDef: make() })).toBeNull();
    expect(runs.versionRow({ flowDef: make({ publish: { enabled: false, version: 2 } }) })).toBeNull();
    const row = runs.versionRow({ flowDef: make({ publish: { enabled: true, version: 4 } }) });
    expect(row.map((e: FakeElement) => e.textContent)).toEqual(["Flow version", "4"]);
  });
});
