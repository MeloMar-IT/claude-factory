import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { CANNOT_READ, redactedJson } from "../credentials/redact.js";

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
 * was saved before they were stored. When the store cannot be read nothing is shown (fail closed).
 */
export function send(res: ServerResponse, status: number, body: unknown) {
  const text = redactedJson(body);
  if (text === undefined) {
    res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: CANNOT_READ }));
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
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
