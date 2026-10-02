import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { FlowSchema, type Flow } from "./schema.js";

import { FACTORY_HOME } from "../home.js";

export { FACTORY_HOME };
const BUILTIN_FLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../../flows");

export type FlowScope = "repo" | "global" | "builtin";

export function flowDir(scope: FlowScope, repo: string): string {
  if (scope === "repo") return join(repo, ".claude-factory", "flows");
  if (scope === "global") return join(FACTORY_HOME, "flows");
  return BUILTIN_FLOWS;
}

const SCOPES: FlowScope[] = ["repo", "global", "builtin"];

/** Directories searched for flows by name, most specific first. */
export function flowDirs(repo: string): string[] {
  return SCOPES.map((s) => flowDir(s, repo));
}

export function resolveFlowPath(nameOrPath: string, repo: string): string {
  if (existsSync(nameOrPath) && [".yaml", ".yml"].includes(extname(nameOrPath))) return resolve(nameOrPath);
  for (const dir of flowDirs(repo)) {
    for (const ext of [".yaml", ".yml"]) {
      const p = join(dir, nameOrPath + ext);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`Flow "${nameOrPath}" not found. Searched: ${flowDirs(repo).join(", ")}`);
}

/** Every existing `<name>.yaml` / `<name>.yml` in the three scope folders, most specific first. */
export function flowFiles(name: string, repo: string): string[] {
  const out: string[] = [];
  for (const dir of flowDirs(repo)) {
    for (const ext of [".yaml", ".yml"]) {
      const p = join(dir, name + ext);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

export function parseFlow(text: string, source = "<flow>"): Flow {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new Error(`${source}: invalid YAML: ${(e as Error).message}`);
  }
  const res = FlowSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${source}: invalid flow\n${issues}`);
  }
  return res.data;
}

export function loadFlow(nameOrPath: string, repo: string): { flow: Flow; path: string } {
  const path = resolveFlowPath(nameOrPath, repo);
  return { flow: parseFlow(readFileSync(path, "utf8"), path), path };
}

export interface FlowListing {
  name: string;
  path: string;
  scope: FlowScope;
  description?: string;
  /** True when the flow is published to users. */
  published?: boolean;
  error?: string;
}

/** List flows; a name found in a more specific dir shadows later ones. */
export function listFlows(repo: string): FlowListing[] {
  const seen = new Map<string, FlowListing>();
  for (const scope of SCOPES) {
    const dir = flowDir(scope, repo);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (![".yaml", ".yml"].includes(extname(file))) continue;
      const name = basename(file, extname(file));
      if (seen.has(name)) continue;
      const path = join(dir, file);
      try {
        const flow = parseFlow(readFileSync(path, "utf8"), path);
        seen.set(name, { name, path, scope, description: flow.description, ...(flow.publish?.enabled ? { published: true } : {}) });
      } catch (e) {
        seen.set(name, { name, path, scope, error: (e as Error).message });
      }
    }
  }
  return [...seen.values()];
}
