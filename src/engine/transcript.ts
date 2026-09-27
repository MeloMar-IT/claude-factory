import { existsSync, readFileSync } from "node:fs";

export type TranscriptEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }
  | { kind: "result"; text: string; costUsd?: number; turns?: number; isError?: boolean }
  | { kind: "raw"; text: string };

const MAX_RESULT = 4000;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

/**
 * Turn a claude step's stream-json log into readable events (text, tool calls with
 * their results, final result). Shell step logs come back as one raw event.
 */
export function readTranscript(logFile: string): TranscriptEvent[] {
  if (!existsSync(logFile)) return [];
  const text = readFileSync(logFile, "utf8");
  const events: TranscriptEvent[] = [];
  const tools = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();
  let sawJson = false;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
      sawJson = true;
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "text" && c.text?.trim()) events.push({ kind: "text", text: c.text });
        if (c.type === "tool_use") {
          const t = { kind: "tool" as const, id: c.id, name: c.name, input: c.input ?? {} };
          tools.set(c.id, t);
          events.push(t);
        }
      }
    } else if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const t = tools.get(c.tool_use_id);
        if (!t) continue;
        const r = resultText(c.content);
        t.result = r.length > MAX_RESULT ? r.slice(0, MAX_RESULT) + `\n… (${r.length - MAX_RESULT} more chars)` : r;
        t.isError = !!c.is_error;
      }
    } else if (ev.type === "result") {
      events.push({ kind: "result", text: ev.result ?? "", costUsd: ev.total_cost_usd, turns: ev.num_turns, isError: ev.is_error });
    }
  }
  if (!sawJson) return [{ kind: "raw", text: text.slice(-200_000) }];
  return events;
}
