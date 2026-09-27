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
