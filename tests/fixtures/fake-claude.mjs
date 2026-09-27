#!/usr/bin/env node
// Stand-in for the `claude` CLI: reads the prompt from stdin, emits stream-json.
// Prompt directives: "WRITE <file> <text>" writes a file; "SAY <text>" sets the result;
// "ERROR" returns an error result. Args are echoed into the result for assertions.
import { writeFileSync } from "node:fs";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

let result = `ok args=${args.join(" ")}`;
for (const line of prompt.split("\n")) {
  const w = line.match(/^WRITE (\S+) (.*)$/);
  if (w) {
    emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: w[1] } }] } });
    writeFileSync(w[1], w[2]);
  }
  const s = line.match(/^SAY (.*)$/);
  if (s) result = s[1];
}
// Canned answers for the built-in blocks, so whole flows can run offline.
let canned;
if (prompt.includes("You triage tickets")) canned = process.env.FAKE_TRIAGE ?? "Small change.\nROUTE: SMALL";
else if (prompt.includes("PLAN_STATUS: NEEDS_INFO")) canned = process.env.FAKE_PLAN ?? "1. change feature.txt\nPLAN_STATUS: READY";
else if (prompt.includes("VERDICT: APPROVE")) canned = "Looks good.\nVERDICT: APPROVE";
else if (prompt.includes("CI failed on this branch")) {
  writeFileSync("ci-fix.txt", "fixed\n");
  canned = "fixed the failing assertion";
} else if (prompt.includes("reusable lessons")) canned = process.env.FAKE_LEARN ?? "- CI runs tests that expect 2";
else if (prompt.includes("Address the review feedback")) {
  writeFileSync("review-fix.txt", "done\n");
  canned = "- renamed the variable as requested";
} else if (prompt.includes("Implement the work")) {
  writeFileSync("feature.txt", "implemented\n");
  canned = "- added feature.txt";
}

const resumed = args[args.indexOf("--resume") + 1];
const isError = prompt.includes("ERROR");
emit({
  type: "result",
  subtype: isError ? "error_during_execution" : "success",
  is_error: isError,
  result: canned ?? `${result}\nPROMPT<<${prompt}>>`,
  session_id: args.includes("--resume") ? resumed : `sess-${Math.random().toString(36).slice(2, 8)}`,
  total_cost_usd: 0.01,
  num_turns: 1,
});
process.exit(isError ? 1 : 0);
