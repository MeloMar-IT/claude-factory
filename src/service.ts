import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FACTORY_HOME } from "./flow/load.js";

/** macOS login agent that keeps `factory serve` (UI + watchers + queue) running. */
export const SERVICE_LABEL = "com.claude-factory.server";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function servicePlist(o: { cliPath: string; port: number; repo: string; logFile: string }): string {
  const args = [process.execPath, o.cliPath, "serve", "--port", String(o.port), "--repo", o.repo];
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
    <key>HOME</key><string>${esc(homedir())}</string>
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

function requireMac() {
  if (process.platform !== "darwin") throw new Error("the service command supports macOS (launchd) only; on Linux run `factory serve` under systemd");
}

export function installService(o: { cliPath: string; port: number; repo: string }): string {
  requireMac();
  const logFile = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "service.log");
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(process.env.FACTORY_HOME ?? FACTORY_HOME, { recursive: true });
  if (existsSync(plistPath())) uninstallService();
  writeFileSync(plistPath(), servicePlist({ ...o, logFile }));
  execFileSync("launchctl", ["bootstrap", domain(), plistPath()]);
  return `installed ${plistPath()}\n  UI:  http://localhost:${o.port}\n  log: ${logFile}`;
}

export function uninstallService(): string {
  requireMac();
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${SERVICE_LABEL}`], { stdio: "ignore" });
  } catch {
    // not loaded
  }
  if (existsSync(plistPath())) rmSync(plistPath());
  return "service removed";
}

export function serviceStatus(): string {
  requireMac();
  if (!existsSync(plistPath())) return "not installed";
  try {
    const out = execFileSync("launchctl", ["print", `${domain()}/${SERVICE_LABEL}`], { encoding: "utf8" });
    const state = /state = (\w+)/.exec(out)?.[1] ?? "unknown";
    const pid = /pid = (\d+)/.exec(out)?.[1];
    return `installed · ${state}${pid ? ` (pid ${pid})` : ""}`;
  } catch {
    return "installed but not loaded";
  }
}
