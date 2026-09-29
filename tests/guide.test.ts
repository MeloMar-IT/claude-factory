import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { StepSchema } from "../src/flow/schema.js";
import { flowGuide } from "../src/server/generate.js";

// docs/FLOW_AUTHORING.md is what AI assistants (and "Draft flow with Claude") write flows from,
// so every example in it must be valid.
const guide = readFileSync("docs/FLOW_AUTHORING.md", "utf8");
const blocks = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);

describe("flow authoring guide", () => {
  it("is what the flow drafter and `factory flow-guide` use", () => {
    expect(flowGuide()).toBe(guide);
  });

  it("has a complete example flow that is valid", () => {
    const flows = blocks.filter((b) => /^name: /m.test(b) && /^steps:\n/m.test(b)); // not the field outline (steps: [...])
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) expect(() => parseFlow(f)).not.toThrow();
  });

  it("has step snippets that are valid steps", () => {
    const snippets = blocks.filter((b) => /^- id: /m.test(b) || /^steps:\n\s+- id:/m.test(b));
    expect(snippets.length).toBeGreaterThan(5);
    for (const b of snippets) {
      const doc = parse(b) as unknown;
      const list = Array.isArray(doc) ? doc : (doc as { steps: unknown[] }).steps;
      for (const step of list) {
        const r = StepSchema.safeParse(step);
        expect(r.success, `${JSON.stringify(step).slice(0, 80)}: ${r.error?.message}`).toBe(true);
      }
    }
  });
});
