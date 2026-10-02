import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const VAR = "FACTORY_FIRST_[A-Z]+(?:_[A-Z]+)*";

/** Problems of the comments a shell script posts; empty when each prints a first-line variable first. Fails closed: an unknown shape is a problem. */
export function scanShell(run: string): string[] {
  const problems: string[] = [];
  const calls = [...run.matchAll(/\bgh(?:[ \t]|\\\r?\n)+(?:issue|pr)(?:[ \t]|\\\r?\n)+comment\b/g)];
  let prev = 0;
  let usesFirst = false;
  for (const m of calls) {
    const at = m.index!;
    const call = run.slice(at).replace(/\\\r?\n/g, " ").split("\n")[0]!;
    if (!/--body-file\s+-(?=\s|$)/.test(call)) problems.push(`"${call.trim()}" does not read its text from stdin (--body-file -)`);
    const before = run.slice(prev, at);
    prev = at;
    const opens = [...before.matchAll(/^[ \t]*\{/gm)];
    const open = opens.at(-1);
    if (!open) {
      problems.push("no { … } group is piped into it");
      continue;
    }
    const group = before.slice(open.index!).replace(/^[ \t]+/, "");
    // The group must close straight into the comment call.
    if (!/\}[ \t]*(?:\\\r?\n\s*)?\|\s*$/.test(group)) {
      problems.push("the { … } group is not piped straight into it");
      continue;
    }
    const head = new RegExp(`^\\{\\s*echo "\\$(${VAR}|first)";[ \\t]*echo[ \\t]*(?:;|\\r?\\n|$)`).exec(group);
    if (!head) problems.push("does not print a first-line variable first");
    else if (head[1] === "first") usesFirst = true;
  }
  if (usesFirst) {
    const values = [...run.matchAll(/(?<![\w$])first=("[^"\n]*"|[^\s;]*)/g)].map((v) => v[1]!);
    if (!values.length) problems.push("$first is never set");
    for (const v of values) if (!new RegExp(`^"\\$${VAR}"$`).test(v)) problems.push(`first=${v} is not a first-line variable`);
  }
  return problems;
}

/** The same for a Node tool that posts with gh([...], body). */
export function scanNode(source: string): string[] {
  const problems: string[] = [];
  for (const m of source.matchAll(/["'](?:issue|pr)["'],\s*["']comment["']/g)) {
    const i = m.index!;
    if (!/\bgh\(\s*\[\s*$/.test(source.slice(0, i))) {
      problems.push("posts a comment without gh([...], body)");
      continue;
    }
    const call = /^([^\]]*)\]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(source.slice(i));
    if (!call) {
      problems.push("the text is not a variable");
      continue;
    }
    if (!/["']--body-file["'],\s*["']-["']/.test(call[1]!)) problems.push("does not read its text from stdin (--body-file -)");
    const id = call[2]!;
    if (!new RegExp(`(?:const|let)\\s+${id.replace(/\$/g, "\\$")}\\s*=\\s*\\[\\s*\\.\\.\\.\\(first \\? \\[first, ""\\] : \\[\\]\\)`).test(source)) {
      problems.push(`${id} does not start with the first line`);
    }
    const firsts = [...source.matchAll(/(?<![\w$.])first\s*=(?!=)\s*([^;\n]+)/g)];
    if (firsts.length !== 1 || !new RegExp(`^process\\.env\\.${VAR}$`).test(firsts[0]![1]!.trim())) {
      problems.push("first is not read from process.env.FACTORY_FIRST_<NAME>");
    }
  }
  return problems;
}

/** scanNode for a "#!… node" script, else scanShell. */
export function scanTool(source: string): string[] {
  return /^#!.*\bnode\b/.test(source) ? scanNode(source) : scanShell(source);
}

export interface ScanHit { where: string; problems: string[] }

/** Every shell step of blocks/*.yaml and flows/*.yaml and every file in tools/ that has problems. */
export function scanRepo(root = "."): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const dir of ["blocks", "flows"]) {
    for (const f of readdirSync(join(root, dir)).filter((n) => n.endsWith(".yaml")).sort()) {
      const def = parseYaml(readFileSync(join(root, dir, f), "utf8")) as { steps?: { id: string; run?: unknown }[] };
      const name = f.replace(/\.yaml$/, "");
      for (const step of def.steps ?? []) {
        if (typeof step.run !== "string") continue;
        const problems = scanShell(step.run);
        if (problems.length) hits.push({ where: dir === "blocks" ? `blocks/${name}/${step.id}` : `${name}/${step.id}`, problems });
      }
    }
  }
  for (const d of readdirSync(join(root, "tools"), { withFileTypes: true }).filter((e) => e.isFile())) {
    const problems = scanTool(readFileSync(join(root, "tools", d.name), "utf8"));
    if (problems.length) hits.push({ where: `tools/${d.name}`, problems });
  }
  return hits;
}
