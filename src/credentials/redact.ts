import { statSync } from "node:fs";
import { basename } from "node:path";
import { StoreError } from "../auth/store.js";
import { KeyError } from "./keychain.js";
import { allSecrets, credentialsPath } from "./store.js";

export const REDACTED = "[redacted]";
export const CANNOT_READ = "the stored credentials cannot be read, so no output can be shown safely";
/** A line shorter than this is only matched as a whole line (a key's last line may be `==`). */
const SHORT = 8;
const FLUSH_AT = 70_000;
/** The longest secret that can be saved (an ssh-key) — what a very long line keeps back when it is cut. */
const HOLD_BACK = 16_384;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The texts a secret can appear as in output: raw, JSON-escaped and URL-encoded. */
function variants(s: string): string[] {
  const out = new Set([s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)]);
  return [...out].filter(Boolean);
}

export interface Match {
  start: number;
  end: number;
}

export interface Redactor {
  readonly empty: boolean;
  redact(text: string): string;
  /** Where the secrets are in the text. */
  find(text: string): Match[];
  /** The length of the longest pattern. */
  readonly maxLen: number;
}

export const emptyRedactor: Redactor = { empty: true, redact: (t) => t, find: () => [], maxLen: 0 };

/** Builds a redactor for the secrets. Multi-line keys are also matched line by line. */
export function makeRedactor(secrets: string[]): Redactor {
  const long = new Set<string>();
  const short = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    for (const v of variants(secret)) long.add(v);
    if (!secret.includes("\n")) continue;
    for (const raw of secret.split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line || /^-----(BEGIN|END) /.test(line)) continue;
      for (const v of variants(line)) (line.length >= SHORT ? long : short).add(v);
    }
  }
  // longest first, so a secret that starts another one leaves no tail
  const sources = [...long].sort((a, b) => b.length - a.length).map(esc);
  const before = String.raw`(?<=(?:^|\n|\\n)[ \t]*)`;
  const after = String.raw`(?=$|\r|\n|\\n|\\r|")`;
  for (const s of [...short].sort((a, b) => b.length - a.length)) sources.push(`${before}${esc(s)}${after}`);
  if (!sources.length) return emptyRedactor;
  const re = new RegExp(sources.join("|"), "g");
  const maxLen = Math.max(...[...long, ...short].map((s) => s.length));

  const find = (text: string): Match[] => {
    const found: Match[] = [];
    for (const m of text.matchAll(re)) if (m[0].length) found.push({ start: m.index!, end: m.index! + m[0].length });
    return found;
  };
  const redact = (text: string) => {
    let out = "";
    let at = 0;
    for (const m of find(text)) {
      out += text.slice(at, m.start) + REDACTED;
      at = m.end;
    }
    return out + text.slice(at);
  };
  return { empty: false, redact, find, maxLen };
}

export interface StreamRedactor {
  write(text: string): void;
  end(): void;
}

/**
 * A line-buffered filter. `current` is asked on every call, so a secret that is saved while a process runs is
 * redacted from then on. An unfinished line is held until a newline or `end()`, or until it is very long.
 */
export function redactStream(sink: (text: string) => void, current: () => Redactor = () => emptyRedactor): StreamRedactor {
  let pending = "";
  return {
    write(text) {
      const r = current();
      // unfinished lines are always held: a secret may be saved between the two halves of a token
      pending += text;
      const nl = pending.lastIndexOf("\n");
      if (nl >= 0) {
        sink(r.redact(pending.slice(0, nl + 1)));
        pending = pending.slice(nl + 1);
      }
      if (pending.length > FLUSH_AT) {
        // hold back the last `maxLen` characters, and any match that crosses the cut
        let cut = pending.length - Math.max(r.maxLen, HOLD_BACK);
        for (const m of r.find(pending)) if (m.start < cut && m.end > cut) cut = m.start;
        if (cut > 0) {
          sink(r.redact(pending.slice(0, cut)));
          pending = pending.slice(cut);
        }
      }
    },
    end() {
      if (pending) sink(current().redact(pending));
      pending = "";
    },
  };
}

/** Hides what either redactor hides (overlapping matches become one). */
export function combineRedactors(a: Redactor, b: Redactor): Redactor {
  if (b.empty) return a;
  if (a.empty) return b;
  const find = (text: string): Match[] => {
    const all = [...a.find(text), ...b.find(text)].sort((x, y) => x.start - y.start || y.end - x.end);
    const out: Match[] = [];
    for (const m of all) {
      const last = out.at(-1);
      if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
      else out.push({ ...m });
    }
    return out;
  };
  const redact = (text: string) => {
    let out = "";
    let at = 0;
    for (const m of find(text)) {
      out += text.slice(at, m.start) + REDACTED;
      at = m.end;
    }
    return out + text.slice(at);
  };
  return { empty: false, redact, find, maxLen: Math.max(a.maxLen, b.maxLen) };
}

// ---- the live set, from credentials.json -------------------------------------------------------------

let cache: { sig: string; redactor: Redactor } | undefined;

/** Used when the store changed and cannot be read: new secrets are unknown, so everything is hidden. */
export const BLOCKED: Redactor = {
  empty: false,
  redact: (t) => (t ? CANNOT_READ : t),
  find: (t) => (t ? [{ start: 0, end: t.length }] : []),
  maxLen: 0,
};

function signature(): string {
  const path = credentialsPath();
  try {
    const st = statSync(path);
    return `${path}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${path}:none`;
  }
}

/** The redactor for every stored secret. One `stat` while the file is unchanged. Throws StoreError or KeyError. */
export function secretRedactor(): Redactor {
  const sig = signature();
  if (cache?.sig === sig) return cache.redactor;
  const redactor = makeRedactor(allSecrets());
  cache = { sig, redactor };
  return redactor;
}

/** Like `secretRedactor`, but never throws: when the changed store cannot be read it hides everything (fail closed). */
export function liveRedactor(): Redactor {
  try {
    return secretRedactor();
  } catch {
    return BLOCKED;
  }
}

/** JSON text of a value with the stored secrets hidden, for API answers. `undefined` when the store cannot be read. */
export function redactedJson(value: unknown): string | undefined {
  const r = liveRedactor();
  const text = JSON.stringify(value);
  if (r === BLOCKED) return undefined;
  return r.empty ? text : r.redact(text);
}

/** Throws a KeyError that starts with "the stored credentials cannot be read" when the store cannot be used. */
export function requireRedaction(): Redactor {
  try {
    return secretRedactor();
  } catch (e) {
    const why = e instanceof StoreError ? `${basename(e.file)} is not valid` : e instanceof KeyError ? e.message : "unexpected error";
    throw new KeyError("failed", `the stored credentials cannot be read (${why}); fix that before runs can start`);
  }
}

/** Redacts one text (a log line, an error message). */
export function redactText(text: string): string {
  return liveRedactor().redact(text);
}

/** Forgets the cached set (tests). */
export function resetRedactCache(): void {
  cache = undefined;
}
