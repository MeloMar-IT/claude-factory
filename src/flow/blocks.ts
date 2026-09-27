import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FACTORY_HOME, flowDir, type FlowScope } from "./load.js";
import { checkStepRefs, StepSchema } from "./schema.js";

/**
 * A block is a reusable set of steps ("model") you can drop into any flow,
 * e.g. "pull GitHub ticket" or "code review with fix loop". Jumps inside a
 * block may only target the block's own steps or reserved targets, so it
 * works wherever it is inserted.
 */
export const BlockSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().default("Custom"),
    /** Variables the block needs; added to the flow's vars if missing. */
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).default({}),
    steps: z.array(StepSchema).min(1),
  })
  .strict()
  .superRefine((block, ctx) => {
    // Blocks must be self-contained: references may only point at the block's own steps.
    const ids = new Set(block.steps.map((s) => s.id));
    checkStepRefs(block.steps, ids, (path, message) =>
      ctx.addIssue({ code: "custom", path, message: message.replace(/^unknown step/, "blocks may only jump to their own steps, got") }));
  });

export type Block = z.infer<typeof BlockSchema>;

export function blockDir(scope: FlowScope, repo: string): string {
  if (scope === "global") return join(FACTORY_HOME, "blocks");
  return join(flowDir(scope, repo), "..", "blocks");
}

export function parseBlock(text: string, source = "<block>"): Block {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new Error(`${source}: invalid YAML: ${(e as Error).message}`);
  }
  const res = BlockSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${source}: invalid block\n${issues}`);
  }
  return res.data;
}

export interface BlockListing {
  id: string;
  scope: FlowScope;
  path: string;
  yaml: string;
  block?: Block;
  error?: string;
}

/** All blocks; a more specific scope shadows a less specific one with the same id. */
export function listBlocks(repo: string): BlockListing[] {
  const seen = new Map<string, BlockListing>();
  for (const scope of ["repo", "global", "builtin"] as const) {
    const dir = blockDir(scope, repo);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (![".yaml", ".yml"].includes(extname(file))) continue;
      const id = basename(file, extname(file));
      if (seen.has(id)) continue;
      const path = join(dir, file);
      const yaml = readFileSync(path, "utf8");
      try {
        seen.set(id, { id, scope, path, yaml, block: parseBlock(yaml, path) });
      } catch (e) {
        seen.set(id, { id, scope, path, yaml, error: (e as Error).message });
      }
    }
  }
  return [...seen.values()];
}
