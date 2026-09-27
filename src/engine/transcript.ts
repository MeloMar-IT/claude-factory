import { existsSync, readFileSync } from "node:fs";

export type TranscriptEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }
  | { kind: "result"; text: string; costUsd?: number; turns?: number; tokens?: number; isError?: boolean }
  | { kind: "raw"; text: string };

const MAX_RESULT = 4000;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

function clip(r: string): string {
  return r.length > MAX_RESULT ? r.slice(0, MAX_RESULT) + `\n… (${r.length - MAX_RESULT} more chars)` : r;
}

/** One finished Codex item (from `codex exec --json`) as transcript events. */
function codexItem(item: Record<string, any>, events: TranscriptEvent[]) {
  const id = String(item.id ?? events.length);
  switch (item.type) {
    case "agent_message":
      if (item.text?.trim()) events.push({ kind: "text", text: item.text });
      break;
    case "command_execution":
      events.push({ kind: "tool", id, name: "Bash", input: { command: item.command }, result: clip(String(item.aggregated_output ?? "")), isError: item.exit_code !== undefined && item.exit_code !== 0 });
      break;
    case "file_change":
      events.push({ kind: "tool", id, name: "Edit", input: { file_path: (item.changes ?? []).map((c: { path?: string }) => c.path).join(", ") }, result: (item.changes ?? []).map((c: { path?: string; kind?: string }) => `${c.kind ?? "update"} ${c.path}`).join("\n") });
      break;
    case "mcp_tool_call":
      events.push({ kind: "tool", id, name: `${item.server}.${item.tool}`, input: item.arguments ?? {}, result: clip(typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? item.error ?? "")) });
      break;
    case "web_search":
      events.push({ kind: "tool", id, name: "WebSearch", input: { query: item.query } });
      break;
    case "todo_list":
      events.push({ kind: "text", text: (item.items ?? []).map((t: { text?: string; completed?: boolean }) => `${t.completed ? "☑" : "☐"} ${t.text}`).join("\n") });
      break;
    case "error":
      events.push({ kind: "text", text: `⚠ ${item.message}` });
      break;
  }
}

/**
 * Turn an agent step's log (Claude stream-json or Codex JSONL) stream-json log into readable events (text, tool calls with
 * their results, final result). Shell step logs come back as one raw event.
 */
export function readTranscript(logFile: string): TranscriptEvent[] {
  if (!existsSync(logFile)) return [];
  const text = readFileSync(logFile, "utf8");
  const events: TranscriptEvent[] = [];
  const tools = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();
  let sawJson = false;
  let lastCodexMessage = "";

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
        t.result = clip(r);
        t.isError = !!c.is_error;
      }
    } else if (ev.type === "item.completed" && ev.item) {
      codexItem(ev.item, events);
      if (ev.item.type === "agent_message") lastCodexMessage = ev.item.text ?? "";
    } else if (ev.type === "turn.completed") {
      const u = ev.usage ?? {};
      events.push({ kind: "result", text: lastCodexMessage, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) });
    } else if (ev.type === "turn.failed" || (ev.type === "error" && ev.message)) {
      events.push({ kind: "result", text: ev.error?.message ?? ev.message ?? "failed", isError: true });
    } else if (ev.type === "result") {
      events.push({ kind: "result", text: ev.result ?? "", costUsd: ev.total_cost_usd, turns: ev.num_turns, isError: ev.is_error });
    }
  }
  if (!sawJson) return [{ kind: "raw", text: text.slice(-200_000) }];
  return events;
}
