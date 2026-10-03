import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { redactText } from "../credentials/redact.js";
import { FACTORY_HOME } from "../flow/load.js";
import { homeMoved } from "../home.js";
import { Scheduler } from "../queue/scheduler.js";
import { steppedAsideFor } from "../queue/watcher.js";
import { WatcherManager } from "../queue/watchers.js";
import { SESSION_RECHECK_MS, authRoutes, requireSession, sessionAlive } from "./api-auth.js";
import { adminRoutes } from "./api-admin.js";
import { credentialRoutes } from "./api-credentials.js";
import { flowRoutes } from "./api-flows.js";
import { runRoutes } from "./api-runs.js";
import { HttpError, send, serveStatic } from "./http.js";
import { areaWait, forgetHistory, nextRoutes, type RestartState } from "./next.js";
import { healthRoutes } from "./health.js";
import type { UpdateView } from "../self-update.js";
import { boardRoutes } from "./board.js";
import { TurnNotifier } from "./notifier.js";
import { ClarityRecorder, clarityRoutes } from "./clarity.js";
import { CSP, HSTS, listenProblem, localUrl, requestAccess } from "./net.js";
import { ACCOUNT_SWEEP_MS, accountActive, accountSweeper } from "./account-work.js";
import { adoptRuns } from "../auth/run-owner.js";
import { hasAdmin, type User } from "../auth/users.js";
import { repoRoutes } from "./api-repos.js";
import { userRoutes } from "./api-users.js";
import { logRing } from "../monitor/monitor.js";
import { authorize, findRule } from "./permissions.js";
import { sinceRoutes } from "./since.js";
import { yourTurnRoutes } from "./your-turn.js";
import { USER_ERROR, movedText } from "./user-view.js";
import { turnActionRoutes } from "./turn-actions.js";

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
  /** How often runs without an owner are given to the first admin, in ms (default 60000). */
  adoptEveryMs?: number;
  /** How often blocked and deleted accounts are checked, in ms (default 2000). */
  accountSweepMs?: number;
}

export interface ApiContext {
  opts: ServerOptions;
  scheduler: Scheduler;
  watchers: WatcherManager;
  config: () => Config;
  reloadConfig: () => void;
  /** Set while the server waits to restart (new version, moved data folder). */
  restart?: RestartState;
  /** The self-updater of the running server: which version runs and whether an update waits. */
  selfUpdate?: { view(): UpdateView };
  /** The address the server is bound to (a changed setting applies after a restart). */
  listen: string;
  /**
   * The log without redaction, only for diagnostics the code built itself from fixed words (a file name and a kind),
   * never for exception text. They must stay readable when the credential store is the thing that is broken.
   */
  diagLog?: (msg: string) => void;
}

/** A route handler: returns true when it handled the request. */
export type Route = (ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string, user: User) => Promise<boolean>;

const ROUTES: Route[] = [credentialRoutes, repoRoutes, userRoutes, adminRoutes, flowRoutes, runRoutes, nextRoutes, yourTurnRoutes, turnActionRoutes, sinceRoutes, boardRoutes, healthRoutes, clarityRoutes];

export async function startServer(given: ServerOptions): Promise<{ url: string; close: () => void; ctx: ApiContext; notifier?: TurnNotifier }> {
  // every free-form server, watcher and notifier log line passes the redaction (fail closed)
  const sink = given.log ?? (() => {});
  const ring = logRing(); // the newest redacted lines, for the monitor
  const log = (msg: string) => {
    const text = redactText(msg);
    ring.push(text);
    sink(text);
  };
  const opts: ServerOptions = { ...given, log };
  let config = loadConfig();
  const listen = config.server.listen;
  // Before anything starts (queue, watchers): a non-local address needs accounts.
  const problem = listenProblem(listen, hasAdmin);
  if (problem) {
    log(problem);
    throw new Error(problem);
  }
  const scheduler = new Scheduler({
    runsDir: opts.runsDir,
    claudeBin: opts.claudeBin,
    config: () => config,
    queueFile: join(process.env.FACTORY_HOME ?? FACTORY_HOME, "queue.json"),
    accountActive,
    onFinished: (s) => {
      // A new succeeded run is a new sample: the next estimate must see it.
      if (s.status === "succeeded") forgetHistory(ctx);
      // When a run ends, the watchers of its repository check at once instead of at the next interval.
      // (A run that only stepped aside for a busy code area freed nothing: no check for that.)
      if (s.vars?.github_repo && !steppedAsideFor(s)) watchers.kickRepo(s.vars.github_repo);
    },
  });
  const watchers = new WatcherManager({ scheduler, runsDir: opts.runsDir, repo: opts.repo, config: () => config, areaWait, log, serverLog: ring.lines });
  const ctx: ApiContext = { opts, diagLog: sink, scheduler, watchers, config: () => config, reloadConfig: () => (config = loadConfig()), listen };

  // Before the first pump and before adopt(): jobs of blocked accounts never start, and a stop-work request made while
  // the server was down does not reach a run that is adopted later.
  const sweep = accountSweeper(scheduler, log);
  sweep();

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    const seg = path.split("/").filter(Boolean).slice(1); // drop "api"
    // The guard comes first: without a session nothing is answered, not even the moved-folder message with its path.
    if (await authRoutes(ctx, req, res, seg, method)) return;
    const user = await requireSession(ctx, req, method);
    const admin = user.role === "admin";
    let where = seg.join("/");
    try {
      // The table decides first: a call without a rule is 404, and a user only gets what the table gives.
      const rule = findRule(method, seg);
      if (!rule) throw new HttpError(404, "not found");
      where = rule.path;
      authorize(ctx, user, rule, seg);
      const moved = method === "GET" ? undefined : homeMoved();
      if (moved) throw new HttpError(503, movedText(moved, admin));
      for (const route of ROUTES) {
        if (await route(ctx, req, res, seg, method, user)) return watchSession(req, res);
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      // An unexpected error can hold a folder, a setting or a command: a user gets a fixed sentence, the log the message.
      if (admin || e instanceof HttpError) throw e;
      log(`api ${method} ${where}: ${(e as Error).message}`);
      throw new HttpError(500, USER_ERROR);
    }
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
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    // Only answer to our own host and origin: blocks DNS rebinding and cross-site requests,
    // since this server can execute code on the machine.
    const acc = requestAccess(req, config.server, opts.port);
    if (acc.https) res.setHeader("strict-transport-security", HSTS);
    if (acc.refusal) return void res.writeHead(403).end(acc.refusal);
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return void res.writeHead(400).end("bad request");
    }
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
    server.listen(opts.port, listen, () => ok());
  });
  // Runs of older versions have no owner. The first admin takes them: now, and again later, since the admin may be
  // made with `scf user create --admin` while we run, and runs that were live are skipped until they end.
  const adopt = () => {
    try {
      adoptRuns(opts.runsDir, log);
    } catch (e) {
      log(`! could not give runs to the first admin: ${(e as Error).message}`);
    }
  };
  adopt();
  const adoptTimer = setInterval(adopt, opts.adoptEveryMs ?? 60_000);
  adoptTimer.unref();
  const sweepTimer = setInterval(sweep, opts.accountSweepMs ?? ACCOUNT_SWEEP_MS);
  sweepTimer.unref();
  if (opts.watchers !== false) watchers.sync();
  let notifier: TurnNotifier | undefined;
  if (process.env.FACTORY_NO_NOTIFY !== "1") {
    notifier = new TurnNotifier(ctx, { baseUrl: localUrl(listen, opts.port), log });
    notifier.start();
  }
  const clarity = new ClarityRecorder(ctx, { log });
  clarity.start();
  return {
    url: localUrl(listen, opts.port),
    ctx,
    notifier,
    close: () => {
      clarity.stop();
      clearInterval(adoptTimer);
      clearInterval(sweepTimer);
      notifier?.stop();
      watchers.stopAll();
      server.close();
    },
  };
}
