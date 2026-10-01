import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { FACTORY_HOME } from "../flow/load.js";
import { homeMoved } from "../home.js";
import { Scheduler } from "../queue/scheduler.js";
import { WatcherManager } from "../queue/watchers.js";
import { SESSION_RECHECK_MS, authRoutes, requireSession, sessionAlive } from "./api-auth.js";
import { adminRoutes } from "./api-admin.js";
import { flowRoutes } from "./api-flows.js";
import { runRoutes } from "./api-runs.js";
import { HttpError, send, serveStatic } from "./http.js";
import { areaWait, nextRoutes, type RestartState } from "./next.js";
import { boardRoutes } from "./board.js";
import { TurnNotifier } from "./notifier.js";
import { sinceRoutes } from "./since.js";
import { yourTurnRoutes } from "./your-turn.js";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui");
const YAML_BROWSER_DIR = join(dirname(createRequire(import.meta.url).resolve("yaml/package.json")), "browser");

export interface ServerOptions {
  repo: string;
  runsDir: string;
  port: number;
  claudeBin?: string;
  /** Run the watchers from config.yaml (default true). */
  watchers?: boolean;
  log?: (msg: string) => void;
  /** How often an open response re-checks its session, in ms (default 4000). */
  sessionRecheckMs?: number;
}

export interface ApiContext {
  opts: ServerOptions;
  scheduler: Scheduler;
  watchers: WatcherManager;
  config: () => Config;
  reloadConfig: () => void;
  /** Set while the server waits to restart (new version, moved data folder). */
  restart?: RestartState;
}

/** A route handler: returns true when it handled the request. */
export type Route = (ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string) => Promise<boolean>;

const ROUTES: Route[] = [adminRoutes, flowRoutes, runRoutes, nextRoutes, yourTurnRoutes, sinceRoutes, boardRoutes];

export async function startServer(opts: ServerOptions): Promise<{ url: string; close: () => void; ctx: ApiContext; notifier?: TurnNotifier }> {
  const log = opts.log ?? (() => {});
  let config = loadConfig();
  const scheduler = new Scheduler({
    runsDir: opts.runsDir,
    claudeBin: opts.claudeBin,
    config: () => config,
    queueFile: join(process.env.FACTORY_HOME ?? FACTORY_HOME, "queue.json"),
  });
  const watchers = new WatcherManager({ scheduler, runsDir: opts.runsDir, repo: opts.repo, config: () => config, areaWait, log });
  const ctx: ApiContext = { opts, scheduler, watchers, config: () => config, reloadConfig: () => (config = loadConfig()) };
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    const seg = path.split("/").filter(Boolean).slice(1); // drop "api"
    // The guard comes first: without a session nothing is answered, not even the moved-folder message with its path.
    if (await authRoutes(ctx, req, res, seg, method)) return;
    await requireSession(ctx, req, method);
    const moved = method === "GET" ? undefined : homeMoved();
    if (moved) throw new HttpError(503, `the data folder moved to ${moved}; the server restarts onto it — try again in a minute`);
    for (const route of ROUTES) {
      if (await route(ctx, req, res, seg, method)) return watchSession(req, res);
    }
    throw new HttpError(404, "not found");
  }

  /** A response that stays open (the run log stream) is closed when its session ends. */
  function watchSession(req: IncomingMessage, res: ServerResponse) {
    if (res.writableEnded || res.destroyed) return;
    const timer = setInterval(() => {
      if (!sessionAlive(ctx, req)) res.destroy();
    }, opts.sessionRecheckMs ?? SESSION_RECHECK_MS);
    timer.unref();
    res.on("close", () => clearInterval(timer));
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

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, "127.0.0.1", () => ok());
  });
  if (opts.watchers !== false) watchers.sync();
  let notifier: TurnNotifier | undefined;
  if (process.env.FACTORY_NO_NOTIFY !== "1") {
    notifier = new TurnNotifier(ctx, { baseUrl: `http://localhost:${opts.port}`, log });
    notifier.start();
  }
  return {
    url: `http://localhost:${opts.port}`,
    ctx,
    notifier,
    close: () => {
      notifier?.stop();
      watchers.stopAll();
      server.close();
    },
  };
}
