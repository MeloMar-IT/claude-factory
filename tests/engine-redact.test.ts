import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { addCredential } from "../src/credentials/store.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const owner = "11111111-1111-4111-8111-111111111111";
const token = fakeToken();
const baseConfig = (): Config => ConfigSchema.parse({ protected_branches: [] });
let tmp: string;
let repo: string;
let runsDir: string;
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "engine-redact-"));
  home = join(tmp, "home");
  process.env.FACTORY_HOME = home;
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  kc = fakeKeychain();
  addCredential({ userId: owner, type: "token", name: "gh", secret: token }, { ownerOk: () => true });
  writeFileSync(join(repo, "token.txt"), token);
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const start = (yaml: string, over: Record<string, unknown> = {}) =>
  runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, config: baseConfig(), ...over });

describe("stored secrets are redacted", () => {
  it("hides the token in the failure note", async () => {
    const guard = process.env.FACTORY_NO_FAILURE_MODEL;
    delete process.env.FACTORY_NO_FAILURE_MODEL;
    process.env.FAKE_EXPLAIN = `KIND: code\nWHY: it printed ${token} twice`;
    try {
      const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'exit 1'}\n");
      expect(s.failureNote).toBeDefined();
      expect(JSON.stringify(s.failureNote)).not.toContain(token);
      expect(readFileSync(join(s.runDir, "run.json"), "utf8")).not.toContain(token);
      expect(readFileSync(liveLogFile(s.runDir), "utf8")).not.toContain(token);
    } finally {
      delete process.env.FAKE_EXPLAIN;
      if (guard !== undefined) process.env.FACTORY_NO_FAILURE_MODEL = guard;
    }
  });

  it("hides the token in a failing shell step and everything that records it", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: leak, type: shell, run: 'cat token.txt; cat token.txt >&2; exit 3', on_failure: next}
  - {id: after, type: shell, run: 'echo "$FACTORY_OUT_LEAK"'}
`);
    const texts = [
      JSON.stringify(s.history),
      s.reason ?? "",
      readFileSync(join(s.runDir, "run.json"), "utf8"),
      readFileSync(liveLogFile(s.runDir), "utf8"),
      ...s.history.map((h) => readFileSync(h.logFile, "utf8")),
    ];
    for (const t of texts) expect(t).not.toContain(token);
    expect(s.history[0]!.output).toContain("[redacted]");
    expect(s.history[1]!.output).toContain("[redacted]");
  });

  it("hides the token in an approval note", async () => {
    const s = await start(`name: t\nworkspace: inplace\nsteps:\n  - {id: gate, type: approval, message: "ok?"}\n`);
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: baseConfig(), decision: { approved: true, by: "me", note: `use ${token}` } });
    expect(JSON.stringify(r.history)).not.toContain(token);
    expect(r.history[0]!.output).toContain("[redacted]");
  });

  it("hides the token in an early failure", async () => {
    const bad = join(tmp, token);
    mkdirSync(bad);
    const logged: string[] = [];
    const s = await start(`name: t\nworkspace: worktree\nsteps:\n  - {id: a, type: shell, run: "true"}\n`, { repo: bad, log: (l: string) => logged.push(l) });
    expect(s.status).toBe("failed");
    expect(s.reason).not.toContain(token);
    // run.json also holds the repo path the user gave (outside the redaction scope); its reason must be clean
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).reason).not.toContain(token);
    expect(logged.join("\n")).not.toContain(token);
  });

  it("fails the run before it starts when the stored credentials cannot be read", async () => {
    resetRedactCache();
    kc.fail("find");
    const marker = join(tmp, "marker");
    const s = await start(`name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "touch ${marker}"}\n`);
    expect(s.status).toBe("failed");
    expect(s.history).toEqual([]);
    expect(s.reason).toMatch(/^the stored credentials cannot be read/);
    expect(s.workdir).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("makes no Keychain call when there are no credentials", async () => {
    rmSync(join(home, "credentials.json"));
    kc.clearLog();
    const s = await start(`name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "echo plain"}\n`);
    expect(s.history[0]!.output).toBe("plain\n");
    expect(kc.calls()).toEqual([]);
  });
});
