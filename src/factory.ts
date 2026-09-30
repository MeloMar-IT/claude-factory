#!/usr/bin/env node
// The old command name. Say so once on stderr, then run the normal CLI.
// The import is dynamic: static imports are hoisted above the notice.
process.stderr.write('note: "factory" is now "scf" (Spaghetti Code Foundry); "factory" keeps working as an alias.\n');
await import("./cli.js");
