import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { BLOCKED, CANNOT_READ, REDACTED, liveRedactor, redactedJson, type Redactor } from "../credentials/redact.js";

const MAX_BODY = 1_000_000;
export const NAME_RE = /^[\w-]+$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra response headers, e.g. `Retry-After`. */
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/**
 * Answers with JSON. Every API answer passes through here, so the stored secrets are hidden now, even in text that
 * was saved before they were stored. When the store cannot be read nothing is shown (fail closed). `keep` lists public
 * keys that stay readable as whole values (only the repository routes pass them).
 */
export function send(res: ServerResponse, status: number, body: unknown, keep: string[] = []) {
  const text = redactedJson(body, keep);
  if (text === undefined) {
    cannotRead(res);
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

function cannotRead(res: ServerResponse) {
  res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: CANNOT_READ }));
}

/** One CSV cell: a leading quote in front of what a spreadsheet would run as a formula, then RFC 4180 quoting. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV line, ended with CRLF. `redact` is applied to each cell first. */
export function csvLine(cells: string[], redact: (cell: string) => string = (c) => c): string {
  return cells.map((c) => csvCell(redact(c))).join(",") + "\r\n";
}

/**
 * One CSV line for the live redactor. Each cell is redacted, then the written line and the joined cells are checked
 * again: a secret made by the quoting or the formula guard, or one spread over cells, hides the whole row.
 */
export function redactedCsvLine(cells: string[], r: Redactor): string {
  const clean = cells.map((c) => r.redact(c));
  const line = csvLine(clean);
  if (r.find(line).length === 0 && r.find(clean.join(",")).length === 0) return line;
  return csvLine(cells.map(() => REDACTED));
}

const CSV_FLUSH = 64 * 1024;

/**
 * Answers with a CSV download, written in pieces as the rows come. Every cell passes the same redaction as `send`;
 * when the store cannot be read nothing is shown (fail closed).
 */
export async function sendCsv(res: ServerResponse, filename: string, header: string[], rows: AsyncIterable<string[]>): Promise<void> {
  const r = liveRedactor();
  if (r === BLOCKED) {
    cannotRead(res);
    return;
  }
  let buf = redactedCsvLine(header, r);
  let started = false;
  const flush = async () => {
    if (res.destroyed) return;
    if (!started) {
      started = true;
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      });
    }
    if (!res.write(buf)) {
      await new Promise<void>((done) => {
        const end = () => {
          res.off("drain", end);
          res.off("close", end);
          done();
        };
        res.once("drain", end);
        res.once("close", end);
      });
    }
    buf = "";
  };
  try {
    for await (const row of rows) {
      if (res.destroyed) return;
      buf += redactedCsvLine(row, liveRedactor());
      if (buf.length >= CSV_FLUSH) await flush();
    }
    await flush();
    res.end();
  } catch (e) {
    if (started) res.destroy();
    throw e;
  }
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if ((v === undefined || v === null) && !required) return "";
  if (typeof v !== "string" || (required && !v.trim())) throw new HttpError(400, `"${key}" must be a non-empty string`);
  return v;
}

export function serveStatic(res: ServerResponse, root: string, rel: string) {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(readFileSync(file));
}
