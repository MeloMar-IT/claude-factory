import { parseDocument } from "yaml";
import type { Flow } from "./schema.js";

/** What a user sees of one variable of a published flow. */
export interface UserField {
  name: string;
  mode: "fixed" | "input";
  label: string;
  help?: string;
  value: string;
  required: boolean;
}

/** What a user sees of a published flow. */
export interface UserFlow {
  name: string;
  title: string;
  description: string;
  version: number;
  fields: UserField[];
}

export type UserVars = { ok: true; vars: Record<string, string> } | { ok: false; status: 400 | 403; error: string };

export const isPublished = (flow: Flow): boolean => flow.publish?.enabled === true;

/** The user's view of a flow. `base` holds the values the flow and the folder give, before the user fills in anything. */
export function userFlow(name: string, flow: Flow, base: Record<string, string>): UserFlow {
  const fields: UserField[] = [];
  for (const [key, spec] of Object.entries(flow.publish?.vars ?? {})) {
    if (spec.mode === "hidden") continue;
    const field: UserField = {
      name: key,
      mode: spec.mode,
      label: spec.label ?? key,
      value: spec.mode === "input" ? spec.default ?? base[key] ?? "" : base[key] ?? "",
      required: spec.mode === "input" && spec.required === true,
    };
    if (spec.help !== undefined) field.help = spec.help;
    fields.push(field);
  }
  return {
    name,
    title: flow.publish?.name ?? flow.name,
    description: flow.publish?.description ?? flow.description ?? "",
    version: flow.publish?.version ?? 1,
    fields,
  };
}

/** The variables of a run a user starts: only inputs may be set; hidden and fixed ones keep the base value. */
export function userVars(flow: Flow, base: Record<string, string>, given: Record<string, string>): UserVars {
  const specs = flow.publish?.vars ?? {};
  const inputs = (k: string) => Object.hasOwn(specs, k) && specs[k]!.mode === "input";
  for (const key of Object.keys(given)) {
    if (!inputs(key)) return { ok: false, status: 403, error: `you cannot set the var "${key}"` };
  }
  const vars: Record<string, string> = { ...base };
  for (const [key, spec] of Object.entries(specs)) {
    if (spec.mode !== "input") continue;
    vars[key] = given[key] ?? spec.default ?? base[key] ?? "";
    if (spec.required && vars[key]!.trim() === "") return { ok: false, status: 400, error: `fill in "${spec.label ?? key}"` };
  }
  return { ok: true, vars };
}

/** True when two flows differ in nothing but the published version and the order of `vars`. */
export function sameDefinition(a: Flow, b: Flow): boolean {
  const norm = (f: Flow) =>
    JSON.stringify({
      ...f,
      ...(f.publish ? { publish: { ...f.publish, version: 0 } } : {}),
      vars: Object.fromEntries(Object.entries(f.vars).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    });
  return norm(a) === norm(b);
}

/**
 * Sets `publish.version` in the YAML of a flow that is saved. A new definition gets one more than the highest
 * version of the stored copies (all scopes); the file being overwritten (`overwritten`), when unchanged, keeps its
 * number; a higher number given by the author is kept. Returns no version when the flow is not published.
 */
export function stampVersion(yaml: string, incoming: Flow, stored: Flow[], overwritten?: Flow): { yaml: string; version?: number } {
  if (!incoming.publish?.enabled) return { yaml };
  const before = stored.filter((f) => f.publish);
  const own = incoming.publish.version;
  let wanted = own;
  if (overwritten?.publish && sameDefinition(overwritten, incoming)) {
    // Saving the file again without a change keeps its number.
    wanted = Math.max(own, overwritten.publish.version);
  } else if (before.length > 0) {
    wanted = Math.max(own, ...before.map((f) => f.publish!.version + 1));
  }
  const doc = parseDocument(yaml);
  if (doc.getIn(["publish", "version"]) === wanted) return { yaml, version: wanted };
  doc.setIn(["publish", "version"], wanted);
  return { yaml: doc.toString({ lineWidth: 0 }), version: wanted };
}
