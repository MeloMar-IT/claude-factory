#!/usr/bin/env node
// Stand-in for `codex exec --json`: reads the prompt from stdin, emits Codex JSONL events.
// Prompt directives: "WRITE <file> <text>" writes a file; "SAY <text>" sets the answer;
// "LIMIT" fails with a rate limit. Args are echoed into the answer for assertions.
import { writeFileSync } from "node:fs";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const resumeAt = args.indexOf("resume");
const thread = resumeAt >= 0 ? args[args.indexOf("-") - 1] : `thread-${Math.random().toString(36).slice(2, 8)}`;

emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
if (prompt.includes("CODEX_LIMIT")) {
  emit({ type: "turn.failed", error: { message: "You've hit your usage limit (429 rate limit)" } });
  process.exit(1);
}
let answer = `codex ok args=${args.join(" ")}\nPROMPT<<${prompt}>>`;
let n = 0;
for (const line of prompt.split("\n")) {
  const w = line.match(/^WRITE (\S+) (.*)$/);
  if (w) {
    writeFileSync(w[1], w[2]);
    emit({ type: "item.completed", item: { id: `item_${n++}`, type: "file_change", changes: [{ path: w[1], kind: "add" }], status: "completed" } });
  }
  const s = line.match(/^SAY (.*)$/);
  if (s) answer = s[1];
}
emit({ type: "item.completed", item: { id: `item_${n++}`, type: "command_execution", command: "git status", aggregated_output: "clean\n", exit_code: 0, status: "completed" } });
if (prompt.includes("VERDICT: APPROVE")) answer = process.env.FAKE_CODEX_VERDICT ?? "Fine.\nVERDICT: APPROVE";
if (prompt.includes("VERDICT: APPROVE") && prompt.includes("RISK_SCORE:") && process.env.FAKE_CODEX_RISK) {
  answer = answer.replace(/(\n?VERDICT:)/, `\nRISK_SCORE: ${process.env.FAKE_CODEX_RISK}$1`);
}
emit({ type: "item.completed", item: { id: `item_${n++}`, type: "agent_message", text: answer } });
emit({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 } });
