#!/usr/bin/env node
// Stand-in for the `claude` CLI: reads the prompt from stdin, emits stream-json.
// Prompt directives: "WRITE <file> <text>" writes a file; "SAY <text>" sets the result;
// "ERROR" returns an error result; "DENY <Tool> <text>" adds a refused tool call to the result's
// permission_denials (command for Bash, file_path otherwise). Args are echoed into the result for assertions.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

let result = `ok args=${args.join(" ")}`;
const denials = [];
for (const line of prompt.split("\n")) {
  const dn = line.match(/^DENY (\S+) (.*)$/);
  if (dn) denials.push({ tool_name: dn[1], tool_use_id: `toolu_${denials.length}`, tool_input: dn[1] === "Bash" ? { command: dn[2] } : { file_path: dn[2] } });
  const w = line.match(/^WRITE (\S+) (.*)$/);
  if (w) {
    emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: w[1] } }] } });
    writeFileSync(w[1], w[2]);
  }
  const s = line.match(/^SAY (.*)$/);
  if (s) result = s[1];
  if (line === "SHOWENV") result = `base=${process.env.ANTHROPIC_BASE_URL ?? ""} token=${process.env.ANTHROPIC_AUTH_TOKEN ?? ""} haiku=${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? ""} args=${args.join(" ")}`;
}
if (prompt.includes("CLAUDE_SIGNED_OUT")) {
  emit({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed", session_id: "s", total_cost_usd: 0, num_turns: 1 });
  process.exit(1);
}
if (prompt.includes("CLAUDE_LIMIT")) {
  emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3:50pm (Europe/Amsterdam)", session_id: "s", total_cost_usd: 0, num_turns: 1 });
  process.exit(1);
}
// Canned answers for the built-in blocks, so whole flows can run offline.
let canned;
let cost = 0.01;
if (prompt.includes("You triage tickets")) canned = process.env.FAKE_TRIAGE ?? "Small change.\nROUTE: SMALL";
else if (prompt.includes("PLAN_STATUS: NEEDS_INFO")) canned = process.env.FAKE_PLAN ?? "1. change feature.txt\nPLAN_STATUS: READY";
else if (prompt.includes("VERDICT: APPROVE")) canned = "Looks good.\nVERDICT: APPROVE";
else if (prompt.includes("CI failed on this branch")) {
  writeFileSync("ci-fix.txt", "fixed\n");
  canned = "fixed the failing assertion";
} else if (prompt.includes("CI is failing on the default branch")) {
  writeFileSync("main-fix.txt", "fixed\n");
  canned = "Cause: off-by-one in app.js. Fixed it.";
} else if (prompt.includes("Recurring maintenance task")) {
  if (prompt.includes("SKIP_CHORE")) canned = "NOTHING_TO_DO";
  else {
    writeFileSync("chore.txt", "done\n");
    canned = "- bumped a dependency";
  }
} else if (prompt.includes("decisions that only the owner can make")) {
  // Epic check: questions for the issues in FAKE_QUESTIONS_FOR ("6 7"), none for the others.
  const ask = (process.env.FAKE_QUESTIONS_FOR ?? "").split(" ");
  canned = [...prompt.matchAll(/ISSUE #(\d+)/g)].map(([, n]) =>
    ask.includes(n) ? `### #${n}\n**Q1. Which package format?**\ndmg or pkg\n**Recommendation:** dmg — no admin prompt` : `### #${n}\nNO_QUESTIONS`).join("\n");
} else if (prompt.includes("Your plan is over the size limit")) {
  canned = process.env.FAKE_FORCED_SPLIT ?? "## Split\n### ISSUE 1: Small part one\nDEPENDS_ON: none\nDo one.\n### ISSUE 2: Small part two\nDEPENDS_ON: 1\nDo two.\nSPLIT_RISK: 20\nPLAN_STATUS: TOO_BIG";
} else if (prompt.includes("Your finished change is being merged into the develop branch")) {
  // Resolve by keeping both sides: drop the conflict markers from every conflicted file.
  const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join("\n"));
    execFileSync("git", ["add", f]);
  }
  canned = files.map((f) => `- ${f}: kept both`).join("\n") || "nothing to resolve";
} else if (prompt.includes("Check each review point in the code")) {
  if (process.env.FAKE_REVISE_COST) cost = Number(process.env.FAKE_REVISE_COST);
  canned = process.env.FAKE_REVISE ?? "## Goal\nAdd feature.txt (revised)\n## Review notes\n- adopted: add an edge-case test\nPLAN_STATUS: READY";
} else if (prompt.includes("architect for this repository")) {
  canned = process.env.FAKE_ISSUE_PLAN ?? "## Goal\nAdd feature.txt\n## Tests\nfeature test\nPLAN_STATUS: READY";
} else if (prompt.includes("Implement GitHub issue below")) {
  const issue = /# #(\d+):/.exec(prompt)?.[1] ?? "?";
  writeFileSync("feature.txt", process.env.FAKE_IMPL_BUG ? "BUG\n" : `implemented #${issue}\n`);
  canned = "- added feature.txt";
} else if (prompt.includes("The tests fail. Fix the code")) {
  if (!process.env.FAKE_FIX_NOOP) writeFileSync("feature.txt", "fixed\n");
  canned = "fixed feature.txt";
} else if (prompt.includes("A reviewer (Codex) looked at your changes")) {
  writeFileSync("review-fix.txt", "addressed\n");
  canned = "- addressed the review";
} else if (prompt.includes("Now document the change")) {
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/CHANGELOG.md", `- feature.txt added for #${/# #(\d+):/.exec(prompt)?.[1] ?? "?"}\n`);
  canned = "- documented in docs/CHANGELOG.md";
} else if (prompt.includes("reusable lessons")) canned = process.env.FAKE_LEARN ?? "- CI runs tests that expect 2";
else if (prompt.includes("Address the review feedback")) {
  writeFileSync("review-fix.txt", "done\n");
  canned = "- renamed the variable as requested";
} else if (prompt.includes("Implement the work")) {
  writeFileSync("feature.txt", "implemented\n");
  canned = "- added feature.txt";
}

// Plans asked for their size and code areas get them (FAKE_SIZE, FAKE_AREAS; areas default per issue).
if (canned && prompt.includes("SIZE: <number of files changed>") && /PLAN_STATUS: READY/.test(canned) && !/^SIZE:/m.test(canned)) {
  const issue = /# #(\d+):/.exec(prompt)?.[1] ?? "x";
  canned = canned.replace(/PLAN_STATUS: READY/, `SIZE: ${process.env.FAKE_SIZE ?? "3 files, 120 lines"}\nAREAS: ${process.env.FAKE_AREAS ?? `src/area${issue}`}\nPLAN_STATUS: READY`);
}
// Plans asked for a risk score get one (FAKE_RISK, default 20) before the PLAN_STATUS line.
if (canned && prompt.includes("RISK_SCORE: <0-100>") && /PLAN_STATUS: READY/.test(canned) && !/RISK_SCORE/.test(canned)) {
  canned = canned.replace(/PLAN_STATUS: READY/, `## Risk\nsmall\nRISK_SCORE: ${process.env.FAKE_RISK ?? 20}\nRISK_REASON: ${process.env.FAKE_RISK_REASON ?? "small local change"}\nPLAN_STATUS: READY`);
}
const resumed = args[args.indexOf("--resume") + 1];
const isError = prompt.includes("ERROR");
emit({
  type: "result",
  subtype: isError ? "error_during_execution" : "success",
  is_error: isError,
  result: canned ?? `${result}\nPROMPT<<${prompt}>>`,
  session_id: args.includes("--resume") ? resumed : `sess-${Math.random().toString(36).slice(2, 8)}`,
  total_cost_usd: cost,
  num_turns: 1,
  ...(denials.length ? { permission_denials: denials } : {}),
});
process.exit(isError ? 1 : 0);
