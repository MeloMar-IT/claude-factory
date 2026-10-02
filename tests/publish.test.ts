import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { sameDefinition, stampVersion, userFlow, userVars } from "../src/flow/publish.js";

const STEP = "steps:\n  - {id: a, type: shell, run: echo}\n";
const flow = (head: string, steps = STEP) => parseFlow(`name: t\n${head}${steps}`);
const fail = (head: string, steps = STEP) => {
  try {
    flow(head, steps);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the flow to be refused");
};

describe("publish schema", () => {
  it("leaves publish out of a flow without it", () => {
    expect(flow("").publish).toBeUndefined();
  });

  it("fills in version and vars", () => {
    expect(flow("publish: {enabled: true}\n").publish).toEqual({ enabled: true, version: 1, vars: {} });
  });

  it("refuses what is not valid", () => {
    expect(fail("publish: {enabled: true, other: 1}\n")).toContain("publish");
    expect(fail("vars: {x: a}\npublish: {vars: {x: {mode: secret}}}\n")).toContain("publish.vars.x");
    expect(fail("vars: {x: a}\npublish: {vars: {x: {mode: hidden, label: L}}}\n")).toContain("publish.vars.x");
    expect(fail("vars: {x: a}\npublish: {vars: {x: {mode: fixed, required: true}}}\n")).toContain("publish.vars.x");
    expect(fail("publish: {version: 0}\n")).toContain("publish.version");
    const unknown = fail("publish: {vars: {x: {mode: fixed}}}\n");
    expect(unknown).toContain("publish.vars.x");
    expect(unknown).toContain('unknown variable "x"');
  });

  it("refuses names and labels of spaces only", () => {
    expect(fail("publish: {name: '   '}\n")).toContain("publish.name");
    expect(fail("vars: {x: a}\npublish: {vars: {x: {mode: fixed, label: ' '}}}\n")).toContain("publish.vars.x.label");
    expect(flow("publish: {name: ' Hi '}\n").publish?.name).toBe("Hi");
  });

  it("refuses an input that is pasted into a shell command", () => {
    const head = "vars: {topic: a, other: b}\npublish: {vars: {topic: {mode: input}}}\n";
    const run = (cmd: string) => `steps:\n  - {id: a, type: shell, run: '${cmd}'}\n`;
    expect(fail(head, run("echo {{ vars.topic }}"))).toContain("$FACTORY_VAR_TOPIC");
    expect(flow(head, run('echo "$FACTORY_VAR_TOPIC"')).steps).toHaveLength(1);
    expect(flow(head, run("echo {{vars.other}}")).steps).toHaveLength(1);
    expect(flow("vars: {topic: a}\npublish: {vars: {topic: {mode: fixed}}}\n", run("echo {{vars.topic}}")).steps).toHaveLength(1);
  });

  it("refuses an approval message that shows a variable users do not see", () => {
    const vars = "vars: {h: a, f: b, i: c, u: d, github_repo: x/y, issue: '1'}\n";
    const pub = `${vars}publish: {enabled: true, vars: {h: {mode: hidden}, f: {mode: fixed}, i: {mode: input}}}\n`;
    const ask = (msg: string) => `steps:\n  - {id: ok, type: approval, message: '${msg}'}\n`;
    expect(fail(pub, ask("Go with {{vars.h}}?"))).toContain('"h" is hidden');
    expect(fail(pub, ask("Go with {{ vars.u }}?"))).toContain('"u"');
    expect(fail(pub, ask("All: {{vars}}"))).toContain("{{vars}}");
    for (const ok of ["{{vars.f}}", "{{vars.i}}", "{{vars.github_repo}}", "{{vars.issue}}", "{{task}}", "{{steps.a.output}}"]) {
      expect(flow(pub, ask(`Go with ${ok}?`)).steps).toHaveLength(1);
    }
    for (const bad of ["{{workdir}}", "{{run.dir}}", "{{learnings}}", "{{steps}}", "{{steps.a}}", "{{steps.a.agent}}", "{{steps.a.session_id}}", "{{steps.a.output.x}}"]) {
      expect(fail(pub, ask(`Go ${bad}?`)), bad).toContain("shown to users");
    }
    // The same flow, not published, is fine.
    expect(flow(`${vars}publish: {enabled: false, vars: {h: {mode: hidden}}}\n`, ask("Go with {{vars.h}}?")).steps).toHaveLength(1);
  });

  it("refuses names that give the same environment variable", () => {
    const head = (mode: string) => `vars: {foo-bar: a, foo_bar: b}\npublish: {vars: {foo-bar: {mode: ${mode}}}}\n`;
    expect(fail(head("input"))).toContain("FACTORY_VAR_FOO_BAR");
    expect(flow(head("fixed")).publish?.vars["foo-bar"]?.mode).toBe("fixed");
    expect(flow("vars: {foo-bar: a, other: b}\npublish: {vars: {foo-bar: {mode: input}}}\n").vars).toHaveProperty("other");
  });

  it("wants a plain name for an input", () => {
    const head = (mode: string) => `vars: {"issue.number": "1"}\npublish: {vars: {"issue.number": {mode: ${mode}}}}\n`;
    expect(fail(head("input"))).toContain("letters, digits, _ or -");
    expect(flow(head("fixed")).publish?.vars["issue.number"]?.mode).toBe("fixed");
  });

  it("refuses sub-flow steps only in an enabled flow", () => {
    const sub = "steps:\n  - {id: s, type: flow, flow: other}\n";
    expect(fail("publish: {enabled: true}\n", sub)).toContain("cannot have sub-flow steps");
    expect(flow("publish: {enabled: false}\n", sub).steps).toHaveLength(1);
    expect(flow("", sub).steps).toHaveLength(1);
  });

  it("turns a default into text and keeps an empty one", () => {
    const f = flow("vars: {a: x, b: y}\npublish: {vars: {a: {mode: input, default: 5}, b: {mode: input, default: ''}}}\n");
    expect(f.publish?.vars.a).toEqual({ mode: "input", default: "5" });
    expect(f.publish?.vars.b).toEqual({ mode: "input", default: "" });
  });

  it("still parses the built-in flows", () => {
    for (const file of readdirSync("flows").filter((n) => n.endsWith(".yaml"))) {
      expect(() => parseFlow(readFileSync(`flows/${file}`, "utf8"), file), file).not.toThrow();
    }
  });
});

const PUBLISHED = flow(
  `description: own text
vars: {a: va, b: vb, c: vc, d: vd}
publish:
  enabled: true
  vars:
    c: {mode: input, label: C, help: help c, required: true}
    b: {mode: fixed}
    a: {mode: hidden}
    d: {mode: input, default: ""}
`,
);
const BASE = { a: "ba", b: "bb", c: "bc", d: "bd" };

describe("userFlow", () => {
  it("falls back to the flow's name and description, leaves out hidden vars and follows the order", () => {
    const u = userFlow("file", PUBLISHED, BASE);
    expect([u.name, u.title, u.description, u.version]).toEqual(["file", "t", "own text", 1]);
    expect(u.fields.map((f) => f.name)).toEqual(["c", "b", "d"]);
    const named = flow("publish: {enabled: true, name: Nice, description: Fine}\n");
    expect(userFlow("f", named, {})).toMatchObject({ title: "Nice", description: "Fine" });
    expect(userFlow("f", flow("publish: {enabled: true}\n"), {}).description).toBe("");
  });

  it("takes a fixed value from base and an input value from default, else base", () => {
    const u = userFlow("file", PUBLISHED, BASE);
    expect(u.fields[0]).toEqual({ name: "c", mode: "input", label: "C", help: "help c", value: "bc", required: true });
    expect(u.fields[1]).toEqual({ name: "b", mode: "fixed", label: "b", value: "bb", required: false });
    expect(u.fields[2]!.value).toBe("");
  });
});

describe("userVars", () => {
  it("refuses a var that is hidden, fixed, undeclared or inherited", () => {
    for (const key of ["a", "b", "zzz", "constructor"]) {
      expect(userVars(PUBLISHED, BASE, { c: "x", [key]: "y" })).toEqual({ ok: false, status: 403, error: `you cannot set the var "${key}"` });
    }
  });

  it("wants a required input, and names it by its label", () => {
    const cases: Record<string, string>[] = [{}, { c: "" }, { c: "  " }];
    for (const given of cases) {
      expect(userVars(PUBLISHED, { ...BASE, c: "" }, given)).toEqual({ ok: false, status: 400, error: 'fill in "C"' });
    }
  });

  it("lets a given value beat default, and default beat base", () => {
    const r = userVars(PUBLISHED, BASE, { c: "given", d: "mine" });
    expect(r).toEqual({ ok: true, vars: { a: "ba", b: "bb", c: "given", d: "mine" } });
    expect(userVars(PUBLISHED, BASE, { c: "x" })).toMatchObject({ ok: true, vars: { d: "" } });
    expect(userVars(PUBLISHED, BASE, { c: "x" })).toMatchObject({ vars: { a: "ba", b: "bb" } });
  });
});

describe("sameDefinition", () => {
  const f = (vars: string, pub = "") => flow(`vars: ${vars}\npublish: {enabled: true${pub}}\n`);
  it("ignores the order of vars and the version", () => {
    expect(sameDefinition(f("{a: '1', b: '2'}"), f("{b: '2', a: '1'}"))).toBe(true);
    expect(sameDefinition(f("{a: '1'}", ", version: 4"), f("{a: '1'}"))).toBe(true);
  });
  it("sees another order of publish.vars", () => {
    const p = (order: string) => flow(`vars: {a: '1', b: '2'}\npublish: {enabled: true, vars: {${order}}}\n`);
    expect(sameDefinition(p("a: {mode: fixed}, b: {mode: fixed}"), p("b: {mode: fixed}, a: {mode: fixed}"))).toBe(false);
  });
});

describe("stampVersion", () => {
  const yaml = (cmd = "echo", publish = "  enabled: true\n") => `# note\nname: t\npublish:\n${publish}steps:\n  - {id: a, type: shell, run: ${cmd}}\n`;
  const parsed = (cmd = "echo", publish = "  enabled: true\n") => parseFlow(yaml(cmd, publish));
  const stamp = (y: string, stored: ReturnType<typeof parsed>[], overwritten?: ReturnType<typeof parsed>) => stampVersion(y, parseFlow(y), stored, overwritten);

  it("writes version 1 on the first publish", () => {
    const r = stamp(yaml(), []);
    expect(r.version).toBe(1);
    expect(parseFlow(r.yaml).publish?.version).toBe(1);
  });

  it("returns the same text for the same definition", () => {
    const y = yaml("echo", "  enabled: true\n  version: 2\n");
    const same = parsed("echo", "  enabled: true\n  version: 2\n");
    expect(stamp(y, [same], same)).toEqual({ yaml: y, version: 2 });
  });

  it("does not go back when a change matches an older copy in another scope", () => {
    const repoCopy = parsed("echo two", "  enabled: true\n  version: 5\n");
    const globalCopy = parsed("echo one", "  enabled: true\n  version: 1\n");
    const r = stamp(yaml("echo one"), [repoCopy, globalCopy], repoCopy);
    expect(r.version).toBe(6);
  });

  it("raises a changed definition by one and keeps comments", () => {
    const r = stamp(yaml("echo two"), [parsed("echo one", "  enabled: true\n  version: 2\n")]);
    expect(r.version).toBe(3);
    expect(parseFlow(r.yaml).publish?.version).toBe(3);
    expect(r.yaml).toContain("# note");
  });

  it("keeps an author's version above the stored one", () => {
    const r = stamp(yaml("echo two", "  enabled: true\n  version: 9\n"), [parsed("echo one", "  enabled: true\n  version: 2\n")]);
    expect(r.version).toBe(9);
  });

  it("gives no version when not enabled, and bumps when enabled again", () => {
    const off = "  enabled: false\n  version: 3\n";
    const y = yaml("echo", off);
    expect(stamp(y, [parsed("echo", "  enabled: true\n  version: 3\n")])).toEqual({ yaml: y });
    expect(stamp(yaml("echo", "  enabled: true\n  version: 3\n"), [parsed("echo", off)]).version).toBe(4);
  });

  it("goes above every predecessor and ignores one without publish", () => {
    const stored = [parsed("a", "  enabled: true\n  version: 2\n"), parsed("b", "  enabled: true\n  version: 5\n"), parseFlow("name: t\nsteps:\n  - {id: a, type: shell, run: x}\n")];
    expect(stamp(yaml("c"), stored).version).toBe(6);
  });

  it("gives no version for a flow without publish", () => {
    const y = "name: t\nsteps:\n  - {id: a, type: shell, run: x}\n";
    expect(stamp(y, [])).toEqual({ yaml: y });
  });
});
