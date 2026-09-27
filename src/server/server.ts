import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flowDir, listFlows, parseFlow, resolveFlowPath, type FlowScope } from "../flow/load.js";
import { generateFlow } from "./generate.js";
import { RunManager } from "./runs.js";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui");
const YAML_BROWSER_DIR = join(dirname(createRequire(import.meta.url).resolve("yaml/package.json")), "browser");
const MAX_BODY = 1_000_000;
const NAME_RE = /^[\w-]+$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerOptions {
  repo: string;
  runsDir: string;
  port: number;
  claudeBin?: string;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if (v === undefined && !required) return "";
  if (typeof v !== "string" || (required && !v.trim())) throw new HttpError(400, `"${key}" must be a non-empty string`);
  return v;
}

function serveStatic(res: ServerResponse, root: string, rel: string) {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

export function startServer(opts: ServerOptions): Promise<{ url: string; close: () => void }> {
  const runs = new RunManager(opts.runsDir, opts.claudeBin);
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    const seg = path.split("/").filter(Boolean).slice(1); // drop "api"

    if (seg[0] === "info" && method === "GET") return send(res, 200, { repo: opts.repo, runsDir: opts.runsDir });

    if (seg[0] === "flows") {
      const name = seg[1];
      if (name !== undefined && !NAME_RE.test(name)) throw new HttpError(400, "invalid flow name");
      if (!name && method === "GET") return send(res, 200, listFlows(opts.repo));
      if (!name) throw new HttpError(405, "method not allowed");
      const listing = listFlows(opts.repo).find((f) => f.name === name);

      if (method === "GET") {
        if (!listing) throw new HttpError(404, `flow "${name}" not found`);
        return send(res, 200, { ...listing, yaml: readFileSync(listing.path, "utf8") });
      }
      if (method === "PUT") {
        const body = await readJson(req);
        const yaml = str(body, "yaml");
        const scope = str(body, "scope") as FlowScope;
        if (scope !== "repo" && scope !== "global") throw new HttpError(400, 'scope must be "repo" or "global"');
        const flow = parseFlow(yaml);
        if (flow.name !== name) throw new HttpError(400, `flow name "${flow.name}" must match "${name}"`);
        const dir = flowDir(scope, opts.repo);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${name}.yaml`);
        writeFileSync(path, yaml);
        return send(res, 200, { name, path, scope });
      }
      if (method === "DELETE") {
        if (!listing) throw new HttpError(404, `flow "${name}" not found`);
        if (listing.scope === "builtin") throw new HttpError(403, "built-in flows cannot be deleted");
        rmSync(listing.path);
        return send(res, 200, { deleted: listing.path });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (seg[0] === "validate" && method === "POST") {
      const body = await readJson(req);
      try {
        const flow = parseFlow(str(body, "yaml"));
        return send(res, 200, { ok: true, flow });
      } catch (e) {
        return send(res, 200, { ok: false, error: (e as Error).message });
      }
    }

    if (seg[0] === "generate" && method === "POST") {
      const body = await readJson(req);
      const result = await generateFlow(str(body, "request"), str(body, "current", false) || undefined, opts.claudeBin);
      return send(res, 200, result);
    }

    if (seg[0] === "runs") {
      const id = seg[1];
      if (!id && method === "GET") return send(res, 200, runs.list());
      if (!id && method === "POST") {
        const body = await readJson(req);
        const task = str(body, "task").trim();
        const repo = resolve(str(body, "repo", false) || opts.repo);
        if (!existsSync(repo)) throw new HttpError(400, `repo not found: ${repo}`);
        const vars: Record<string, string> = {};
        for (const [k, v] of Object.entries((body.vars as Record<string, unknown>) ?? {})) {
          if (!NAME_RE.test(k) || typeof v !== "string") throw new HttpError(400, `invalid var "${k}"`);
          vars[k] = v;
        }
        let flow;
        if (typeof body.yaml === "string") flow = parseFlow(body.yaml);
        else flow = parseFlow(readFileSync(resolveFlowPath(str(body, "flow"), opts.repo), "utf8"));
        return send(res, 201, { runId: runs.start(flow, task, repo, vars) });
      }
      if (!id || !/^[\w-]+$/.test(id)) throw new HttpError(400, "invalid run id");
      if (seg[2] === "cancel" && method === "POST") return send(res, 200, { cancelled: runs.cancel(id) });
      if (seg[2] === "events" && method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const unsubscribe = runs.subscribe(id, (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }
      if (!seg[2] && method === "GET") {
        const s = runs.get(id);
        if (!s) throw new HttpError(404, "run not found");
        return send(res, 200, s);
      }
    }
    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    // Only answer to our own origin: blocks DNS rebinding and cross-site requests,
    // since this server can execute code on the machine.
    if (!allowedHosts.has(req.headers.host ?? "")) return void res.writeHead(403).end("forbidden host");
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
      return void res.writeHead(403).end("forbidden origin");
    }
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);

    if (path.startsWith("/api/")) {
      api(req, res, path).catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : 400;
        if (!res.headersSent) send(res, status, { error: e.message });
        else res.end();
      });
      return;
    }
    if (path.startsWith("/vendor/yaml/")) return serveStatic(res, YAML_BROWSER_DIR, path.slice("/vendor/yaml/".length));
    serveStatic(res, UI_DIR, path === "/" ? "index.html" : path.slice(1));
  });

  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      resolveStart({ url: `http://localhost:${opts.port}`, close: () => server.close() });
    });
  });
}
