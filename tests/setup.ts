import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must behave the same everywhere — also inside a factory run, which sets FACTORY_* variables
// and a git pre-push hook (through GIT_CONFIG_*) that blocks pushes to "main". The tests push to
// fake remotes and set their own FACTORY_* values, so drop the inherited ones.
for (const k of Object.keys(process.env)) {
  if (/^(FACTORY_|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)) delete process.env[k];
}
// Keep tests away from the real ~/.claude-factory (config, hooks, learnings, locks) and notifications.
process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-home-"));
process.env.FACTORY_LOCK_DIR = join(process.env.FACTORY_HOME, "locks");
process.env.FACTORY_NO_NOTIFY = "1";
