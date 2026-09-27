import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests away from the real ~/.claude-factory (config, hooks, learnings) and notifications.
process.env.FACTORY_HOME ??= mkdtempSync(join(tmpdir(), "factory-home-"));
process.env.FACTORY_NO_NOTIFY = "1";
