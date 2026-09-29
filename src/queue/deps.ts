/** "Depends on" / "Blocked by" in an issue body: which other issues must be done first. */

export interface DepIssue {
  number: number;
  title: string;
  state?: string;
  labels?: { name: string }[];
}

const HEADER = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:depends[ \t]+on|blocked[ \t]+by)\b[*:\s]*(.*)$/im;

/** The text of the "Depends on" line or section (up to the next heading), or "". */
export function dependencyText(body: string): string {
  const m = HEADER.exec(body ?? "");
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length).split("\n");
  const lines = [m[1] ?? ""];
  for (const line of rest.slice(1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim().slice(0, 1000);
}

const norm = (s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Issue numbers this body depends on: "#12" references, and items matching another issue's title. */
export function dependencies(body: string, self: number, all: DepIssue[]): number[] {
  const text = dependencyText(body);
  if (!text) return [];
  const found = new Set<number>();
  for (const m of text.matchAll(/(?<![\w/])#(\d+)\b/g)) found.add(Number(m[1]));
  const titles = all.map((i) => ({ n: i.number, t: norm(i.title) })).filter((i) => i.t.length >= 3);
  for (const raw of text.split(/[;\n]/)) {
    const item = norm(raw.replace(/^\s*[-*+]\s*(\[[ x]\]\s*)?/i, "").replace(/#\d+/g, ""));
    if (item.length < 3 || /^(none|n a|nothing|no)$/.test(item)) continue;
    for (const { n, t } of titles) {
      if (item === t || item.startsWith(t + " ") || t.startsWith(item + " ")) found.add(n);
    }
  }
  found.delete(self);
  return [...found].sort((a, b) => a - b);
}

/** Dependencies that are not done yet: still open, and without one of the done labels. */
export function openDependencies(deps: number[], all: DepIssue[], doneLabels: string[]): number[] {
  return deps.filter((n) => {
    const i = all.find((x) => x.number === n);
    if (!i) return false; // unknown issue (other repo, typo): don't block on it
    if (i.state && i.state.toUpperCase() !== "OPEN") return false;
    return !(i.labels ?? []).some((l) => doneLabels.includes(l.name));
  });
}
