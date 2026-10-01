import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { FACTORY_HOME } from "./flow/load.js";

/** macOS login agent that keeps `scf serve` (UI + watchers + queue) running. */
export const SERVICE_LABEL = "com.spaghetti-code-foundry.server";
export const OLD_SERVICE_LABEL = "com.claude-factory.server";

/** What the service code needs from the machine; tests pass a fake so launchd is never touched. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  agentsDir: string;
  domain: string;
  /** Returns stdout; throws on failure. */
  launchctl(args: string[]): string;
  writeFile(path: string, data: string): void;
  removeFile(path: string): void;
}

export function macHost(): ServiceHost {
  return {
    platform: process.platform,
    agentsDir: join(homedir(), "Library", "LaunchAgents"),
    domain: `gui/${process.getuid?.() ?? 501}`,
    launchctl: (args) => execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    writeFile: (path, data) => writeFileSync(path, data),
    removeFile: (path) => rmSync(path),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function servicePlist(o: { cliPath: string; port: number; repo: string; logFile: string; home?: string }): string {
  const args = [process.execPath, o.cliPath, "serve", "--port", String(o.port), "--repo", o.repo];
  const home = o.home
    ? `\n    <key>SCF_HOME</key><string>${esc(o.home)}</string>\n    <key>FACTORY_HOME</key><string>${esc(o.home)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
    <key>HOME</key><string>${esc(homedir())}</string>${home}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${esc(o.repo)}</string>
  <key>StandardOutPath</key><string>${esc(o.logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logFile)}</string>
</dict>
</plist>
`;
}

function requireMac(host: ServiceHost) {
  if (host.platform !== "darwin") throw new Error("the service command supports macOS (launchd) only; on Linux run `scf serve` under systemd");
}

const plistPath = (host: ServiceHost, label: string) => join(host.agentsDir, `${label}.plist`);

/** Stop the agent (errors ignored: it may not be loaded) and delete its plist. Returns whether the plist existed. */
function removeAgent(host: ServiceHost, label: string): boolean {
  try {
    host.launchctl(["bootout", `${host.domain}/${label}`]);
  } catch {
    // not loaded
  }
  const path = plistPath(host, label);
  if (!existsSync(path)) return false;
  host.removeFile(path);
  return true;
}

export function installService(o: { cliPath: string; port: number; repo: string }, host: ServiceHost = macHost()): string {
  requireMac(host);
  const dataDir = process.env.FACTORY_HOME ?? FACTORY_HOME;
  const logFile = join(dataDir, "service.log");
  const home = process.env.SCF_HOME ?? process.env.FACTORY_HOME;
  mkdirSync(host.agentsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const newPath = plistPath(host, SERVICE_LABEL);
  // Read what is installed before any change, so a failure can put it back exactly.
  const saved = [OLD_SERVICE_LABEL, SERVICE_LABEL]
    .map((label) => ({ label, path: plistPath(host, label) }))
    .filter((s) => existsSync(s.path))
    .map((s) => ({ ...s, xml: readFileSync(s.path, "utf8") }));
  const hadOld = saved.some((s) => s.label === OLD_SERVICE_LABEL);

  try {
    removeAgent(host, OLD_SERVICE_LABEL);
    removeAgent(host, SERVICE_LABEL);
    host.writeFile(newPath, servicePlist({ ...o, logFile, home }));
    host.launchctl(["bootstrap", host.domain, newPath]);
  } catch (e) {
    const parts = [`could not install the service: ${msg(e)}`];
    try {
      removeAgent(host, SERVICE_LABEL);
    } catch (e2) {
      parts.push(`could not remove ${newPath}: ${msg(e2)}`);
    }
    const failed: string[] = [];
    for (const s of saved) {
      try {
        host.writeFile(s.path, s.xml);
        host.launchctl(["bootstrap", host.domain, s.path]);
      } catch (e3) {
        failed.push(`${s.label}: ${msg(e3)}`);
      }
    }
    if (saved.length) parts.push(failed.length ? `putting the previous service back failed: ${failed.join(", ")}` : "the previous service was put back");
    throw new Error(parts.join("; "));
  }
  return (
    (hadOld ? `removed the old service ${OLD_SERVICE_LABEL}\n` : "") +
    `installed ${newPath}\n  UI:  http://localhost:${o.port}\n  log: ${logFile}`
  );
}

export function uninstallService(host: ServiceHost = macHost()): string {
  requireMac(host);
  const failed: string[] = [];
  for (const label of [OLD_SERVICE_LABEL, SERVICE_LABEL]) {
    try {
      removeAgent(host, label);
    } catch (e) {
      failed.push(`${label}: ${msg(e)}`);
    }
  }
  if (failed.length) throw new Error(`could not remove the service: ${failed.join(", ")}`);
  return "service removed";
}

/** A hint when the installed service still logs outside the current data folder. */
function logHint(plist: string): string {
  const raw = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(plist, "utf8"))?.[1];
  if (!raw) return "";
  const logPath = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const dataDir = process.env.FACTORY_HOME ?? FACTORY_HOME;
  if (logPath.startsWith(dataDir + sep)) return "";
  return `\n  the service still logs to ${logPath} — run \`scf service install\` once to use ${dataDir}`;
}

export function serviceStatus(host: ServiceHost = macHost()): string {
  requireMac(host);
  if (!existsSync(plistPath(host, SERVICE_LABEL))) {
    if (existsSync(plistPath(host, OLD_SERVICE_LABEL))) {
      return `only the old service (${OLD_SERVICE_LABEL}) is installed — run \`scf service install\` to replace it`;
    }
    return "not installed";
  }
  try {
    const out = host.launchctl(["print", `${host.domain}/${SERVICE_LABEL}`]);
    const state = /state = (\w+)/.exec(out)?.[1] ?? "unknown";
    const pid = /pid = (\d+)/.exec(out)?.[1];
    return `installed · ${state}${pid ? ` (pid ${pid})` : ""}${logHint(plistPath(host, SERVICE_LABEL))}`;
  } catch {
    return `installed but not loaded${logHint(plistPath(host, SERVICE_LABEL))}`;
  }
}
