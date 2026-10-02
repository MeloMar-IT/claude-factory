import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveVars } from "../engine/runner.js";
import { blockDir, listBlocks, parseBlock } from "../flow/blocks.js";
import { flowDir, flowFiles, listFlows, parseFlow, type FlowScope } from "../flow/load.js";
import { stampVersion, userFlow, type UserFlow } from "../flow/publish.js";
import type { Flow } from "../flow/schema.js";
import { generateFlow } from "./generate.js";
import { publishedFlows } from "./permissions.js";
import { HttpError, NAME_RE, readJson, send, str } from "./http.js";
import type { Route } from "./server.js";

function scopeOf(body: Record<string, unknown>): FlowScope {
  const scope = str(body, "scope") as FlowScope;
  if (scope !== "repo" && scope !== "global") throw new HttpError(400, 'scope must be "repo" or "global"');
  return scope;
}

export const flowRoutes: Route = async ({ opts }, req, res, seg, method, user) => {
  if (seg[0] === "flows") {
    const name = seg[1];
    if (name !== undefined && !NAME_RE.test(name)) throw new HttpError(400, "invalid flow name");
    if (!name && method === "GET") {
      if (user.role !== "admin") {
        const out: UserFlow[] = [];
        for (const f of publishedFlows(opts.repo)) {
          try {
            const flow = parseFlow(readFileSync(f.path, "utf8"), f.path);
            out.push(userFlow(f.name, flow, effectiveVars(flow, resolve(opts.repo))));
          } catch {
            // A flow that no longer parses is left out.
          }
        }
        return send(res, 200, out), true;
      }
      return send(res, 200, listFlows(opts.repo)), true;
    }
    if (!name) throw new HttpError(405, "method not allowed");
    const listing = listFlows(opts.repo).find((f) => f.name === name);
    if (method === "GET") {
      if (!listing) throw new HttpError(404, `flow "${name}" not found`);
      return send(res, 200, { ...listing, yaml: readFileSync(listing.path, "utf8") }), true;
    }
    if (method === "PUT") {
      const body = await readJson(req);
      const yaml = str(body, "yaml");
      const scope = scopeOf(body);
      const flow = parseFlow(yaml);
      if (flow.name !== name) throw new HttpError(400, `flow name "${flow.name}" must match "${name}"`);
      const dir = flowDir(scope, opts.repo);
      const path = join(dir, `${name}.yaml`);
      const stored: Flow[] = [];
      let overwritten: Flow | undefined;
      for (const p of flowFiles(name, opts.repo)) {
        try {
          const f = parseFlow(readFileSync(p, "utf8"), p);
          stored.push(f);
          if (p === path) overwritten = f;
        } catch {
          // A file that does not parse is left out.
        }
      }
      const stamped = stampVersion(yaml, flow, stored, overwritten);
      if (stamped.yaml !== yaml) parseFlow(stamped.yaml);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, stamped.yaml);
      return send(res, 200, { name, path, scope, yaml: stamped.yaml, ...(stamped.version !== undefined ? { version: stamped.version } : {}) }), true;
    }
    if (method === "DELETE") {
      if (!listing) throw new HttpError(404, `flow "${name}" not found`);
      if (listing.scope === "builtin") throw new HttpError(403, "built-in flows cannot be deleted");
      rmSync(listing.path);
      return send(res, 200, { deleted: listing.path }), true;
    }
    throw new HttpError(405, "method not allowed");
  }

  if (seg[0] === "blocks") {
    const id = seg[1];
    if (!id && method === "GET") return send(res, 200, listBlocks(opts.repo)), true;
    if (!id || !NAME_RE.test(id)) throw new HttpError(400, "invalid block id");
    const listing = listBlocks(opts.repo).find((b) => b.id === id);
    if (method === "PUT") {
      const body = await readJson(req);
      const yaml = str(body, "yaml");
      const scope = scopeOf(body);
      parseBlock(yaml);
      const dir = blockDir(scope, opts.repo);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.yaml`), yaml);
      return send(res, 200, { id, scope }), true;
    }
    if (method === "DELETE") {
      if (!listing) throw new HttpError(404, `block "${id}" not found`);
      if (listing.scope === "builtin") throw new HttpError(403, "built-in blocks cannot be deleted");
      rmSync(listing.path);
      return send(res, 200, { deleted: listing.path }), true;
    }
    throw new HttpError(405, "method not allowed");
  }

  if (seg[0] === "validate" && method === "POST") {
    const body = await readJson(req);
    try {
      return send(res, 200, { ok: true, flow: parseFlow(str(body, "yaml")) }), true;
    } catch (e) {
      return send(res, 200, { ok: false, error: (e as Error).message }), true;
    }
  }

  if (seg[0] === "generate" && method === "POST") {
    const body = await readJson(req);
    const result = await generateFlow(str(body, "request"), str(body, "current", false) || undefined, opts.claudeBin);
    return send(res, 200, result), true;
  }
  return false;
};
