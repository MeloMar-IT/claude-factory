import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { FlowSchema, type Flow } from "./schema.js";

export const FACTORY_HOME = process.env.FACTORY_HOME ?? join(homedir(), ".claude-factory");
const BUILTIN_FLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../../flows");

/** Directories searched for flows by name, most specific first. */
export function flowDirs(repo: string): string[] {
  return [join(repo, ".claude-factory", "flows"), join(FACTORY_HOME, "flows"), BUILTIN_FLOWS];
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
  description?: string;
  error?: string;
}

/** List flows; a name found in a more specific dir shadows later ones. */
export function listFlows(repo: string): FlowListing[] {
  const seen = new Map<string, FlowListing>();
  for (const dir of flowDirs(repo)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (![".yaml", ".yml"].includes(extname(file))) continue;
      const name = basename(file, extname(file));
      if (seen.has(name)) continue;
      const path = join(dir, file);
      try {
        const flow = parseFlow(readFileSync(path, "utf8"), path);
        seen.set(name, { name, path, description: flow.description });
      } catch (e) {
        seen.set(name, { name, path, error: (e as Error).message });
      }
    }
  }
  return [...seen.values()];
}
