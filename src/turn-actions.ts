import { createHash } from "node:crypto";
import { isBot, type Comment } from "./github.js";
import type { CommentKind } from "./next-step.js";

/** Reading the Foundry's comments on an issue, and writing the answers to them. Pure: no GitHub, no files. */

const ANY_KIND: readonly string[] = ["questions", "planner_questions", "approve_plan", "approve_split", "approval"];
export const isCommentKind = (k: string): k is CommentKind => ANY_KIND.includes(k);

const QUESTION_KINDS: readonly string[] = ["questions", "planner_questions"];

/**
 * The Foundry comment an item is about: found by its marker, since a newer Foundry comment may follow it.
 * The marker can be copied by anyone, so with `author` (the GitHub login the Foundry posts as) only that account's comments count.
 */
export function findComment(comments: Comment[], kind: string, runId?: string, author?: string): Comment | undefined {
  const newest = (match: (c: Comment) => boolean) => [...comments].reverse().find((c) => (author === undefined || c.author.login === author) && match(c));
  const marked = (re: RegExp) => newest((c) => isBot(c) && re.test(c.body));
  let found: Comment | undefined;
  if (kind === "questions") found = marked(/<!-- [\w-]+ run=\S* questions -->/);
  else if (kind === "planner_questions") found = runId ? newest((c) => isBot(c) && c.body.includes(`run=${runId} -->`)) : undefined;
  else if (runId) found = newest((c) => isBot(c) && c.body.includes(`run=${runId} approval`));
  if (!found && QUESTION_KINDS.includes(kind)) found = newest(isBot);
  return found;
}

/** Identifies the exact comment a person looked at: when it was posted and what it said (an edit changes the digest). */
export function commentDigest(c: Pick<Comment, "createdAt" | "body">): string {
  return createHash("sha256").update(`${c.createdAt}\n${c.body}`).digest("hex").slice(0, 32);
}

export interface Question {
  n: number;
  title: string;
  /** What is asked, options included. */
  text: string;
  recommendation?: string;
}

const MARKER_LINE = /^\s*<!-- (?:claude-factory|spaghetti-code-foundry)[^>]*-->\s*$/;
const FIRST_LINE = /^\*\*(?:What you need to do:|Nothing needed from you)/;
const CLOSING = /^_[^_].*_$/;

/** The comment as a person reads it: without the bold first line, the closing sentence and the marker. */
export function visibleText(body: string): string {
  const lines = body.replace(/\r/g, "").split("\n").filter((l) => !MARKER_LINE.test(l));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  if (lines.length && FIRST_LINE.test(lines[0]!.trim())) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (lines.length && CLOSING.test(lines.at(-1)!.trim())) lines.pop();
  return lines.join("\n").trim();
}

const Q_HEAD = /^\*\*Q(\d+)\.\s*([^*\n]*)\*\*[ \t]*/;
const RECOMMENDATION = /\*\*Recommendation:?\*\*:?\s*/i;

/** The numbered questions of a comment as `tools/post-questions` writes them; empty for free prose. */
export function parseQuestions(body: string): Question[] {
  const out: Question[] = [];
  let cur: { n: number; title: string; lines: string[] } | undefined;
  const done = () => {
    if (!cur || out.some((q) => q.n === cur!.n)) return;
    const text = cur.lines.join("\n").trim();
    const m = RECOMMENDATION.exec(text);
    out.push({
      n: cur.n, title: cur.title,
      text: (m ? text.slice(0, m.index) : text).trim(),
      ...(m ? { recommendation: text.slice(m.index + m[0].length).trim() } : {}),
    });
  };
  for (const line of visibleText(body).split("\n")) {
    const m = Q_HEAD.exec(line);
    if (m) {
      done();
      cur = { n: Number(m[1]), title: m[2]!.trim(), lines: [line.slice(m[0].length)] };
    } else if (cur) cur.lines.push(line);
  }
  done();
  return out;
}

export interface Proposal {
  /** The risk score (a split's score when `split`). */
  risk?: number;
  split?: boolean;
  reason?: string;
  /** Why the owner decides. */
  gate?: string;
  /** The plan or split, without the lines above. */
  text: string;
}

/** The plan, split or request of an approval comment: its risk score, reason and gate, and the rest as text. */
export function parseProposal(body: string): Proposal {
  const p: Proposal = { text: "" };
  const keep: string[] = [];
  for (const line of visibleText(body).split("\n")) {
    const risk = /^\*\*Risk: (\d+)\/100\*\*(?:\s*—\s*(.*))?$/.exec(line.trim());
    const gate = /^✋ \*\*A human decides before coding starts:\*\*\s*(.*?)\.?$/.exec(line.trim()) ?? /^✋ \*\*You decide\*\*\s*\((.*)\)\.?$/.exec(line.trim());
    if (risk) {
      p.risk = Number(risk[1]);
      if (risk[2]) p.reason = risk[2].trim();
    } else if (gate) p.gate = gate[1]!.trim();
    else {
      const split = /\(\*\*split risk: (\d+)\/100\*\*\)/.exec(line);
      if (split && p.risk === undefined) {
        p.risk = Number(split[1]);
        p.split = true;
      }
      keep.push(line);
    }
  }
  p.text = keep.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return p;
}

export type ComposeAction = "defaults" | "answer" | "approve" | "reject" | "retry_hint";

export interface ComposeInput {
  /** Who is signed in (a name, one line). */
  name: string;
  /** Approve notes, the reject reason, or the hint. */
  text?: string;
  /** The answers of `answer`; `n` is the question number, absent for one free answer. */
  answers?: { n?: number; text: string }[];
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

/** The comment an action posts. The last line says who acted; the first line of /approve and /reject is what the watcher reads. */
export function composeComment(action: ComposeAction, i: ComposeInput): string {
  const sign = `— ${oneLine(i.name)}, via Spaghetti Code Foundry`;
  let body: string;
  switch (action) {
    case "defaults": body = "/defaults"; break;
    case "approve": case "reject": body = `/${action}${i.text && oneLine(i.text) ? ` ${oneLine(i.text)}` : ""}`; break;
    case "retry_hint": body = (i.text ?? "").trim(); break;
    case "answer":
      body = (i.answers ?? []).map((a) => (a.n === undefined ? a.text.trim() : `**Q${a.n}.** ${a.text.trim()}`)).join("\n\n");
      break;
  }
  return `${body}\n\n${sign}`;
}
