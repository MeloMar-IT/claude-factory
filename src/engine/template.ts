const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export type TemplateContext = Record<string, unknown>;

function lookup(ctx: TemplateContext, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Render {{path.to.value}} placeholders.
 * - `allowed` restricts which top-level roots may be referenced (used to keep
 *   untrusted text like step output out of shell commands).
 * - A step that has not run yet renders as "" so loops can reference later steps.
 */
export function render(template: string, ctx: TemplateContext, allowed?: readonly string[]): string {
  return template.replace(PLACEHOLDER, (_m, path: string) => {
    const root = path.split(".")[0]!;
    if (allowed && !allowed.includes(root)) {
      throw new Error(
        `{{${path}}} is not allowed here (allowed: ${allowed.join(", ")}). ` +
          `In shell steps use env vars like $FACTORY_TASK or $FACTORY_OUT_<STEP_ID> instead.`,
      );
    }
    const v = lookup(ctx, path);
    if (v === undefined) {
      if (root === "steps") return "";
      throw new Error(`unknown template variable {{${path}}}`);
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

const envSuffix = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** Env var name for a step's output, e.g. "run-tests" -> FACTORY_OUT_RUN_TESTS. */
export function outputEnvName(stepId: string): string {
  return "FACTORY_OUT_" + envSuffix(stepId);
}

/** Env var name for a flow variable, e.g. "github_repo" -> FACTORY_VAR_GITHUB_REPO. */
export function varEnvName(name: string): string {
  return "FACTORY_VAR_" + envSuffix(name);
}

/** Returns a copy of env where every FACTORY_X is also set as SCF_X. */
export function withScfAliases<T extends Record<string, string | undefined>>(env: T): T {
  const out: Record<string, string | undefined> = { ...env };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("FACTORY_")) out["SCF_" + k.slice(8)] = v;
  return out as T;
}

/** In place: SCF_X → FACTORY_X (SCF_ wins), then FACTORY_X → SCF_X where SCF_X is missing. Returns env. */
export function mirrorEnvPrefixes(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const k of Object.keys(env)) {
    if (k.startsWith("SCF_") && env[k] !== undefined) env["FACTORY_" + k.slice(4)] = env[k];
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith("FACTORY_") && env["SCF_" + k.slice(8)] === undefined) env["SCF_" + k.slice(8)] = env[k];
  }
  return env;
}
