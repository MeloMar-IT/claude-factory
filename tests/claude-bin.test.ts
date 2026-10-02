import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeBin } from "../src/steps/claude.js";

// The Claude desktop app bundles a newer Claude Code than an old `claude` on PATH; the app has
// stored it as <version>/claude.app/… and, later, as <version>/<id>/claude.app/….
describe("finding Claude Code", () => {
  afterEach(() => delete process.env.FACTORY_DESKTOP_CLAUDE_DIR);

  const install = (root: string, ...path: string[]) => {
    const dir = join(root, ...path, "claude.app/Contents/MacOS");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
    chmodSync(join(dir, "claude"), 0o755);
    return join(dir, "claude");
  };

  it("uses the newest bundled version, in either folder layout", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-code-"));
    process.env.FACTORY_DESKTOP_CLAUDE_DIR = root;
    const flat = install(root, "999.1.1");
    expect(resolveClaudeBin()).toBe(flat);
    const nested = install(root, "999.1.2", "f2326db61802");
    expect(resolveClaudeBin()).toBe(nested);
    mkdirSync(join(root, "999.1.3", "incomplete"), { recursive: true }); // a download in progress
    expect(resolveClaudeBin()).toBe(nested);
  });
});
