import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { outputEnvName, render } from "../src/engine/template.js";

const minimal = (steps: string) => `name: t\nsteps:\n${steps}`;

describe("flow schema", () => {
  it("parses the built-in flows", () => {
    for (const f of ["feature", "quick"]) {
      const flow = parseFlow(readFileSync(`flows/${f}.yaml`, "utf8"), f);
      expect(flow.name).toBe(f);
    }
  });

  it("applies defaults", () => {
    const flow = parseFlow(minimal("  - {id: a, type: shell, run: echo}"));
    expect(flow.workspace).toBe("worktree");
    expect(flow.vars).toEqual({});
  });

  it("rejects unknown jump targets", () => {
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x, on_failure: nope}"))).toThrow(/unknown step "nope"/);
  });

  it("rejects duplicate ids and reserved ids", () => {
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x}\n  - {id: a, type: shell, run: y}"))).toThrow(/duplicate/);
    expect(() => parseFlow(minimal("  - {id: end, type: shell, run: x}"))).toThrow(/reserved/);
  });

  it("rejects resume pointing at a non-claude step", () => {
    const y = minimal("  - {id: a, type: shell, run: x}\n  - {id: b, type: claude, prompt: hi, resume: a}");
    expect(() => parseFlow(y)).toThrow(/resume must reference a claude step/);
  });

  it("rejects unknown fields and bad regex", () => {
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x, bogus: 1}"))).toThrow(/invalid flow/);
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x, pass_if: '('}"))).toThrow(/invalid regex/);
  });
});

describe("template", () => {
  const ctx = { task: "do it", vars: { a: "1" }, steps: { x: { output: "out" } } };

  it("renders values and blanks steps that have not run", () => {
    expect(render("{{task}} {{vars.a}} {{steps.x.output}} [{{steps.y.output}}]", ctx)).toBe("do it 1 out []");
  });

  it("throws on unknown variables", () => {
    expect(() => render("{{vars.missing}}", ctx)).toThrow(/unknown template variable/);
  });

  it("enforces allowed roots", () => {
    expect(() => render("echo {{task}}", ctx, ["vars"])).toThrow(/not allowed/);
    expect(render("echo {{vars.a}}", ctx, ["vars"])).toBe("echo 1");
  });

  it("builds env names", () => {
    expect(outputEnvName("run-tests")).toBe("FACTORY_OUT_RUN_TESTS");
  });
});
