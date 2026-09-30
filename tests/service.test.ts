import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installService, serviceStatus, servicePlist, uninstallService, type ServiceHost } from "../src/service.js";

const OLD = "old plist";
const PREV = "previous plist";
const OLD_LABEL = "com.claude-factory.server";
const NEW_LABEL = "com.spaghetti-code-foundry.server";

function fakeHost(o: { failBootstrap?: string; failWrite?: string; failRemove?: string; print?: string; platform?: NodeJS.Platform } = {}) {
  const agentsDir = mkdtempSync(join(tmpdir(), "factory-agents-"));
  const calls: string[][] = [];
  const host: ServiceHost = {
    platform: o.platform ?? "darwin",
    agentsDir,
    domain: "gui/501",
    launchctl(args) {
      calls.push(args);
      if (args[0] === "bootstrap" && o.failBootstrap && args[2]!.includes(o.failBootstrap)) throw new Error("bootstrap failed");
      if (args[0] === "print") {
        if (o.print === undefined) throw new Error("not loaded");
        return o.print;
      }
      return "";
    },
    writeFile(path, data) {
      if (o.failWrite && path.includes(o.failWrite)) throw new Error("write failed");
      writeFileSync(path, data);
    },
    removeFile(path) {
      if (o.failRemove && path.includes(o.failRemove)) throw new Error("remove failed");
      rmSync(path);
    },
  };
  const oldPath = join(agentsDir, `${OLD_LABEL}.plist`);
  const newPath = join(agentsDir, `${NEW_LABEL}.plist`);
  return { host, calls, oldPath, newPath, agentsDir };
}

const opts = { cliPath: "/x/dist/cli.js", port: 4777, repo: "/r" };
const seed = (h: { oldPath: string; newPath: string }, which: { old?: boolean; prev?: boolean }) => {
  if (which.old) writeFileSync(h.oldPath, OLD);
  if (which.prev) writeFileSync(h.newPath, PREV);
};

describe("launchd service", () => {
  it("runs scf serve with the current PATH and logs to a file", () => {
    const xml = servicePlist({ cliPath: "/x/dist/cli.js", port: 4777, repo: "/Users/me/code & stuff", logFile: "/tmp/f.log" });
    expect(xml).toContain("<string>/x/dist/cli.js</string>\n    <string>serve</string>");
    expect(xml).toContain("<string>/Users/me/code &amp; stuff</string>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>com.spaghetti-code-foundry.server</string>");
    expect(xml).not.toContain("SCF_HOME");
  });

  it("passes the data folder under both names when given", () => {
    const xml = servicePlist({ cliPath: "/x", port: 1, repo: "/r", logFile: "/l", home: "/h" });
    expect(xml).toContain("<key>SCF_HOME</key><string>/h</string>");
    expect(xml).toContain("<key>FACTORY_HOME</key><string>/h</string>");
  });

  it("install replaces the old agent", () => {
    const h = fakeHost();
    seed(h, { old: true });
    const out = installService(opts, h.host);
    expect(existsSync(h.oldPath)).toBe(false);
    const xml = readFileSync(h.newPath, "utf8");
    expect(xml).toContain("<key>SCF_HOME</key>");
    expect(xml).toContain("<key>FACTORY_HOME</key>");
    expect(h.calls).toContainEqual(["bootout", `gui/501/${OLD_LABEL}`]);
    expect(h.calls.at(-1)).toEqual(["bootstrap", "gui/501", h.newPath]);
    expect(out).toContain("removed the old service");
  });

  it("reinstall with only the new agent writes a fresh plist", () => {
    const h = fakeHost();
    seed(h, { prev: true });
    const out = installService(opts, h.host);
    expect(readFileSync(h.newPath, "utf8")).not.toContain(PREV);
    expect(h.calls).toContainEqual(["bootout", `gui/501/${NEW_LABEL}`]);
    expect(out).not.toContain("removed the old service");
  });

  it.each([
    ["bootstrap fails", { failBootstrap: "spaghetti" }],
    ["write fails", { failWrite: "spaghetti" }],
  ])("puts the old agent back when %s", (_n, f) => {
    const h = fakeHost(f);
    seed(h, { old: true });
    expect(() => installService(opts, h.host)).toThrow(/could not install.*put back/);
    expect(existsSync(h.newPath)).toBe(false);
    expect(readFileSync(h.oldPath, "utf8")).toBe(OLD);
    expect(h.calls.at(-1)).toEqual(["bootstrap", "gui/501", h.oldPath]);
  });

  it("puts the new agent back when a reinstall fails", () => {
    const h = fakeHost();
    seed(h, { prev: true });
    // make the first bootstrap fail only once
    let n = 0;
    const orig = h.host.launchctl;
    h.host.launchctl = (args) => {
      if (args[0] === "bootstrap" && n++ === 0) {
        h.calls.push(args);
        throw new Error("bootstrap failed");
      }
      return orig(args);
    };
    expect(() => installService(opts, h.host)).toThrow(/put back/);
    expect(readFileSync(h.newPath, "utf8")).toBe(PREV);
    expect(h.calls.at(-1)).toEqual(["bootstrap", "gui/501", h.newPath]);
  });

  it("restores both plists when both existed", () => {
    const h = fakeHost();
    seed(h, { old: true, prev: true });
    let failed = false;
    const orig = h.host.launchctl;
    h.host.launchctl = (args) => {
      if (args[0] === "bootstrap" && !failed) {
        failed = true;
        h.calls.push(args);
        throw new Error("bootstrap failed");
      }
      return orig(args);
    };
    expect(() => installService(opts, h.host)).toThrow(/put back/);
    expect(readFileSync(h.oldPath, "utf8")).toBe(OLD);
    expect(readFileSync(h.newPath, "utf8")).toBe(PREV);
    const boots = h.calls.filter((c) => c[0] === "bootstrap").map((c) => c[2]);
    expect(boots).toContain(h.oldPath);
    expect(boots.slice(1)).toContain(h.newPath);
  });

  it("puts the old agent back when removing it fails during the swap", () => {
    const h = fakeHost({ failRemove: "claude-factory" });
    seed(h, { old: true });
    expect(() => installService(opts, h.host)).toThrow(/could not install.*put back/);
    expect(readFileSync(h.oldPath, "utf8")).toBe(OLD);
    expect(h.calls.at(-1)).toEqual(["bootstrap", "gui/501", h.oldPath]);
    expect(existsSync(h.newPath)).toBe(false);
  });

  it("still restores when cleaning up the new plist fails too", () => {
    const h = fakeHost({ failBootstrap: "spaghetti", failRemove: "spaghetti" });
    seed(h, { old: true });
    expect(() => installService(opts, h.host)).toThrow(/could not remove.*put back/);
    expect(readFileSync(h.oldPath, "utf8")).toBe(OLD);
    expect(h.calls.at(-1)).toEqual(["bootstrap", "gui/501", h.oldPath]);
  });

  it("says so when putting the old agent back fails", () => {
    const h = fakeHost({ failBootstrap: "server.plist" });
    seed(h, { old: true });
    expect(() => installService(opts, h.host)).toThrow(/putting the previous service back failed/);
  });

  it("a failed fresh install leaves nothing behind", () => {
    const h = fakeHost({ failBootstrap: "spaghetti" });
    let err = "";
    try {
      installService(opts, h.host);
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toMatch(/could not install/);
    expect(err).not.toMatch(/put back/);
    expect(existsSync(h.newPath)).toBe(false);
  });

  it("uninstall removes both agents", () => {
    const h = fakeHost();
    seed(h, { old: true, prev: true });
    expect(uninstallService(h.host)).toBe("service removed");
    expect(existsSync(h.oldPath) || existsSync(h.newPath)).toBe(false);
    expect(h.calls).toContainEqual(["bootout", `gui/501/${OLD_LABEL}`]);
    expect(h.calls).toContainEqual(["bootout", `gui/501/${NEW_LABEL}`]);
  });

  it("uninstall removes the second agent even if the first fails", () => {
    const h = fakeHost({ failRemove: "claude-factory" });
    seed(h, { old: true, prev: true });
    expect(() => uninstallService(h.host)).toThrow(/could not remove/);
    expect(existsSync(h.newPath)).toBe(false);
  });

  it("status covers the four cases", () => {
    const none = fakeHost();
    expect(serviceStatus(none.host)).toBe("not installed");
    const old = fakeHost();
    seed(old, { old: true });
    expect(serviceStatus(old.host)).toMatch(/scf service install/);
    const up = fakeHost({ print: "state = running\npid = 42" });
    seed(up, { prev: true });
    expect(serviceStatus(up.host)).toBe("installed · running (pid 42)");
    const down = fakeHost();
    seed(down, { prev: true });
    expect(serviceStatus(down.host)).toBe("installed but not loaded");
  });

  it("only supports macOS", () => {
    const h = fakeHost({ platform: "linux" });
    mkdirSync(h.agentsDir, { recursive: true });
    expect(() => installService(opts, h.host)).toThrow(/scf serve/);
    expect(() => uninstallService(h.host)).toThrow(/scf serve/);
    expect(() => serviceStatus(h.host)).toThrow(/scf serve/);
  });
});
