import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEEDS_TOKEN, NO_RUN_OWNER, TOKEN_MISSING, TOKEN_UNREADABLE, addRepo, repoAccess, reposPath, setRepoAuth, transferRepo } from "../src/auth/repos.js";
import { adoptRuns, isRefinementRun } from "../src/auth/run-owner.js";
import { removeCredential, listCredentials } from "../src/credentials/store.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { REPO_READ_FLOW, TOKEN_REFUSED_REASON, isRepoReadStep, repoReadEnv, tokenRefused } from "../src/engine/guards.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadFlow, parseFlow } from "../src/flow/load.js";
import { REFINE_BRIEF_FLOW } from "../src/flow/usage.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
const BOT = ["ghp", ""].join("_") + "Bot".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  kc.remove();
  gh.restore();
});

const tokenRepo = (owner: { id: string }, token = TOKEN, url = "acme/app") => addRepo(owner.id, { url, method: "github-token", token });

describe("repoAccess", () => {
  it("gives the stored token for github-token and sets lastUsed", () => {
    const r = tokenRepo(user);
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "token", token: TOKEN });
    expect(listCredentials(user.id).find((c) => c.id === r.credentialId)?.lastUsed).not.toBeNull();
  });

  it("gives the token of https-token on github.com", () => {
    addRepo(user.id, { url: "https://github.com/acme/app", method: "https-token", username: "bob", token: TOKEN });
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "token", token: TOKEN });
  });

  it("matches the name in any case and with .git", () => {
    tokenRepo(user);
    expect(repoAccess(user.id, "ACME/App")).toMatchObject({ kind: "token" });
    expect(repoAccess(user.id, "acme/app.git")).toMatchObject({ kind: "token" });
  });

  it("method none: the server's access for an admin, a sentence for a user", () => {
    addRepo(admin.id, "acme/app");
    addRepo(user.id, "acme/web");
    expect(repoAccess(admin.id, "acme/app")).toEqual({ kind: "server" });
    expect(repoAccess(user.id, "acme/web")).toEqual({ kind: "refused", reason: NEEDS_TOKEN });
  });

  it("a version 1 file gives a user the sentence", () => {
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: { [user.id]: ["acme/app"] } }));
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "refused", reason: NEEDS_TOKEN });
  });

  it("after a transfer the new owner needs a token and the old owner has no such repository", () => {
    const r = tokenRepo(user);
    transferRepo(r.id, "admin@example.com");
    expect(repoAccess(admin.id, "acme/app")).toEqual({ kind: "server" });
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "refused", reason: '"acme/app" is not one of your repositories' });
    transferRepo(r.id, "user@example.com");
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "refused", reason: NEEDS_TOKEN });
  });

  it.each([["owner/repo"], ["nope"], ["other/thing"]])("refuses %j", (name) => {
    tokenRepo(admin);
    const a = repoAccess(user.id, name);
    expect(a).toEqual({ kind: "refused", reason: `"${name}" is not one of your repositories` });
  });

  it("refuses another account's repository, a record on another host and an undefined owner", () => {
    tokenRepo(admin);
    addRepo(user.id, "https://example.com/acme/other");
    expect(repoAccess(user.id, "acme/app")).toMatchObject({ kind: "refused" });
    expect(repoAccess(user.id, "acme/other")).toMatchObject({ kind: "refused" });
    expect(repoAccess(undefined, "acme/app")).toEqual({ kind: "refused", reason: NO_RUN_OWNER });
  });

  it("a removed credential gives TOKEN_MISSING", () => {
    const r = tokenRepo(user);
    removeCredential(user.id, r.credentialId!);
    expect(repoAccess(user.id, "acme/app")).toEqual({ kind: "refused", reason: TOKEN_MISSING });
  });

  it("an unreadable Keychain or file gives TOKEN_UNREADABLE with the cause in detail and never throws", () => {
    tokenRepo(user);
    kc.fail("find");
    const a = repoAccess(user.id, "acme/app");
    expect(a).toMatchObject({ kind: "refused", reason: TOKEN_UNREADABLE });
    expect((a as { detail?: string }).detail).toBeTruthy();
    kc.fail();
    writeFileSync(reposPath(), "not json");
    const b = repoAccess(user.id, "acme/app");
    expect(b).toMatchObject({ kind: "refused", reason: TOKEN_UNREADABLE });
    expect((b as { detail?: string }).detail).toMatch(/repos\.json/);
  });

  it("no reason names a file, a lock or a path", () => {
    for (const r of [NEEDS_TOKEN, TOKEN_MISSING, TOKEN_UNREADABLE, NO_RUN_OWNER, TOKEN_REFUSED_REASON]) expect(r).not.toMatch(/\.json|auth\.lock|wrong-format|not-json|locked|unreadable|\//);
  });
});

describe("guards", () => {
  const src = "refinement 123";
  it("grants only the clone and the issue list, at the top level, of the refinement flow", () => {
    expect(isRepoReadStep({ id: "clone" }, 0, REPO_READ_FLOW, src)).toBe(true);
    expect(isRepoReadStep({ id: "list_issues" }, 0, REPO_READ_FLOW, src)).toBe(true);
    for (const id of ["brief", "check_brief"]) expect(isRepoReadStep({ id }, 0, REPO_READ_FLOW, src)).toBe(false);
    expect(isRepoReadStep({ id: "clone" }, 1, REPO_READ_FLOW, src)).toBe(false);
    expect(isRepoReadStep({ id: "clone" }, 0, "refine-brief-2", src)).toBe(false);
    for (const s of ["ui", "cli", "watcher w issue #1", "refinement", "Refinement x", undefined]) expect(isRepoReadStep({ id: "clone" }, 0, REPO_READ_FLOW, s)).toBe(false);
    expect(isRefinementRun("refinement x")).toBe(true);
  });

  it("names the shipped flow", () => expect(REPO_READ_FLOW).toBe(REFINE_BRIEF_FLOW));

  it("repoReadEnv holds the isolation variables only for a token", () => {
    expect(repoReadEnv({ kind: "server" }, {})).toEqual({});
    expect(repoReadEnv({ kind: "refused", reason: "x" }, {})).toEqual({});
    const env = repoReadEnv({ kind: "token", token: TOKEN }, {});
    expect(env).toMatchObject({ GH_TOKEN: TOKEN, GH_HOST: "github.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_PARAMETERS: "", GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_COUNT: "0" });
    expect(repoReadEnv({ kind: "token", token: TOKEN }, { GIT_CONFIG_COUNT: "1" })).not.toHaveProperty("GIT_CONFIG_COUNT");
  });

  it.each([
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "GraphQL: Could not resolve to a Repository with the name 'acme/app'.",
    "Resource not accessible by personal access token",
    "Resource not accessible by integration",
    "Resource protected by organization SAML enforcement",
    "the SAML SSO session has expired",
    "forbids access via a fine-grained personal access token",
    "fatal: Authentication failed for 'https://github.com/acme/app/'",
    "remote: Invalid username or password.",
    "remote: Invalid username or token.",
    "remote: Repository not found.",
    "fatal: repository 'https://github.com/acme/app/' not found",
    "remote: Write access to repository not granted.",
    "remote: Permission to acme/app.git denied to bob.",
    "fatal: The requested URL returned error: 403",
    "fatal: The requested URL returned error: 401",
    "fatal: could not read Username: terminal prompts disabled",
  ])("tokenRefused: %s", (line) => expect(tokenRefused(line)).toBe(true));

  it.each(["HTTP 403: API rate limit exceeded", "You have exceeded a secondary rate limit", "could not clone acme/app", "boom"])("tokenRefused is false for %s", (line) =>
    expect(tokenRefused(line)).toBe(false),
  );
});

// ---- engine level ------------------------------------------------------------------------------

const PROBE = (name = "refine-brief") => `
name: ${name}
workspace: empty
vars: { github_repo: acme/app }
steps:
  - id: clone
    type: shell
    run: 'if [ "$GH_TOKEN" = "$FAKE_GH_EXPECT_TOKEN" ]; then echo "stored host=$GH_HOST"; else echo "\${GH_TOKEN:-none}"; fi'
  - id: list_issues
    type: shell
    run: 'if [ "$GH_TOKEN" = "$FAKE_GH_EXPECT_TOKEN" ]; then echo "stored host=$GH_HOST"; else echo "\${GH_TOKEN:-none}"; fi'
  - id: other
    type: shell
    run: 'if [ "$GH_TOKEN" = "$FAKE_GH_EXPECT_TOKEN" ]; then echo "stored host=$GH_HOST"; else echo "\${GH_TOKEN:-none}"; fi'
  - id: brief
    type: claude
    prompt: SHOWGH
`;
const probe = (name?: string) => parseFlow(PROBE(name), "probe.yaml");
const runs = () => join(gh.tmp, "runs");
const go = (flow: ReturnType<typeof probe>, extra: { source?: string; owner?: string; config?: Config } = {}) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: ConfigSchema.parse({ protected_branches: [] }), ...extra });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const lastUsed = (r: { credentialId?: string }, uid: string) => listCredentials(uid).find((c) => c.id === r.credentialId)?.lastUsed;
const REFINE = "refinement 6b1c1d52-1111-4111-8111-111111111111";

describe("a refinement run", { timeout: 60_000 }, () => {
  it("gives the stored token to the clone and the issue list only, never to the agent", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const s = await go(probe(), { source: REFINE, owner: user.id });
    expect(s.status).toBe("succeeded");
    expect(out(s, "clone")).toBe("stored host=github.com");
    expect(out(s, "list_issues")).toBe("stored host=github.com");
    expect(out(s, "other")).toBe("none");
    expect(out(s, "brief")).toContain("gh_token=none");
  });

  it("replaces the bot's token in the two steps and leaves it in the others", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    process.env.BOT_TOKEN_FOR_TEST = BOT;
    const config = ConfigSchema.parse({ protected_branches: [], bot: { gh_token_env: "BOT_TOKEN_FOR_TEST" } });
    const s = await go(probe(), { source: REFINE, owner: user.id, config });
    expect(out(s, "clone")).toBe("stored host=github.com");
    expect(out(s, "list_issues")).toBe("stored host=github.com");
    expect(out(s, "other")).toBe(BOT);
    expect(out(s, "brief")).toContain("gh_token=other");
  });

  it.each([["ui"], ["cli"], ["watcher w issue #1"], [undefined]])("a run with the source %s gets no token", async (source) => {
    const r = tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const s = await go(probe(), { source, owner: user.id });
    for (const id of ["clone", "list_issues", "other"]) expect(out(s, id)).toBe("none");
    expect(lastUsed(r, user.id)).toBeNull();
  });

  it("a flow with another name gets no token", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const s = await go(probe("refine-brief-2"), { source: REFINE, owner: user.id });
    expect(out(s, "clone")).toBe("none");
  });

  it("a repo flow run as a sub-flow gets no token", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    mkdirSync(join(gh.tmp, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(gh.tmp, ".claude-factory", "flows", "refine-brief.yaml"), PROBE());
    const outer = parseFlow("name: outer\nworkspace: empty\nsteps:\n  - id: inner\n    type: flow\n    flow: refine-brief\n", "outer.yaml");
    const s = await go(outer, { source: REFINE, owner: user.id });
    const clone = s.history.find((h) => h.id === "inner/clone");
    expect(clone?.output.trim()).toBe("none");
  });

  it("hides the token when a step prints it, and writes it nowhere", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const flow = parseFlow("name: refine-brief\nworkspace: empty\nsteps:\n  - id: clone\n    type: shell\n    run: 'echo $GH_TOKEN'\n", "leak.yaml");
    const s = await go(flow, { source: REFINE, owner: user.id });
    expect(out(s, "clone")).toContain("[redacted]");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of files(s.runDir)) expect(readFileSync(f, "utf8")).not.toContain(TOKEN);
  });

  it("looks the token up when the step starts: a resume sees the new one", async () => {
    const r = tokenRepo(user);
    const flow = parseFlow("name: refine-brief\nworkspace: empty\nsteps:\n  - id: first\n    type: shell\n    run: 'exit 1'\n  - id: clone\n    type: shell\n    run: 'test \"$GH_TOKEN\" = \"$FAKE_GH_EXPECT_TOKEN\" && echo stored'\n", "late.yaml");
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const s = await go(flow, { source: REFINE, owner: user.id });
    expect(s.status).toBe("failed");
    setRepoAuth(user.id, r.id, { token: TOKEN2 });
    const again = await resumeRun({ runId: s.runId, runsDir: runs(), claudeBin, from: "clone", config: ConfigSchema.parse({ protected_branches: [] }) });
    expect(out(again, "clone")).toBe("stored");
  });

  it("fails with TOKEN_UNREADABLE and logs the cause when the repository list cannot be read", async () => {
    tokenRepo(user);
    writeFileSync(reposPath(), "not json");
    const s = await go(probe(), { source: REFINE, owner: user.id });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(`step "clone" failed: ${TOKEN_UNREADABLE}`);
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain("the stored token could not be read:");
  });

  it("a refinement run without an owner fails and is not adopted", async () => {
    tokenRepo(admin);
    const s = await go(probe(), { source: REFINE });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(`step "clone" failed: ${NO_RUN_OWNER}`);
    expect(s.owner).toBeUndefined();
    expect(gh.ghLog()).toBe("");
    const hand = await go(probe(), { source: "ui" });
    expect(hand.owner).toBe(admin.id);
    expect(adoptRuns(runs())).toBe(0);
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).owner).toBeUndefined();
  });
});

describe("git isolation", { timeout: 60_000 }, () => {
  it("the two steps ignore the server's git settings and allow https only; others keep them", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const cfg = join(gh.tmp, "hostile.gitconfig");
    writeFileSync(cfg, '[url "ssh://git@github.com/"]\n\tinsteadOf = https://github.com/\n[credential]\n\thelper = evil\n[http]\n\textraHeader = Authorization: Basic abc\n');
    process.env.GIT_CONFIG_GLOBAL = cfg;
    process.env.GIT_CONFIG_SYSTEM = cfg;
    const step = (id: string) => `  - id: ${id}\n    type: shell\n    run: |\n      git config --get-regexp '^(url|credential|http)\\.' || true\n      echo "allow=$GIT_ALLOW_PROTOCOL prompt=$GIT_TERMINAL_PROMPT askpass=\${GIT_ASKPASS-unset}"\n      git ls-remote ssh://git@example.invalid/x 2>&1 || true\n`;
    const flow = parseFlow(`name: refine-brief\nworkspace: empty\nsteps:\n${step("clone")}${step("list_issues")}${step("other")}`, "iso.yaml");
    const s = await go(flow, { source: REFINE, owner: user.id });
    for (const id of ["clone", "list_issues"]) {
      const o = out(s, id);
      expect(o).not.toMatch(/insteadof|credential\.helper|extraheader/i);
      expect(o).toMatch(/allow=https prompt=0 askpass=\s*\n/);
      expect(o).toContain("transport 'ssh' not allowed");
    }
    expect(out(s, "other")).toMatch(/credential\.helper evil/);
  });
});

describe("a token in the process", { timeout: 60_000 }, () => {
  it("switches off git tracing for the two steps and forces redaction of traces", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    Object.assign(process.env, { GIT_TRACE: "1", GIT_TRACE_PACKET: "1", GIT_TRACE_CURL: "1", GIT_CURL_VERBOSE: "1", GIT_TRACE_REDACT: "0" });
    const show = (id: string) => `  - id: ${id}\n    type: shell\n    run: 'echo "t=\${GIT_TRACE-unset} p=\${GIT_TRACE_PACKET-unset} c=\${GIT_TRACE_CURL-unset} v=\${GIT_CURL_VERBOSE-unset} r=$GIT_TRACE_REDACT"'\n`;
    const flow = parseFlow(`name: refine-brief\nworkspace: empty\nsteps:\n${show("clone")}${show("list_issues")}${show("other")}`, "trace.yaml");
    const s = await go(flow, { source: REFINE, owner: user.id });
    expect(out(s, "clone")).toBe("t=unset p=unset c=unset v=unset r=1");
    expect(out(s, "list_issues")).toBe("t=unset p=unset c=unset v=unset r=1");
    expect(out(s, "other")).toBe("t=1 p=1 c=1 v=1 r=0");
  });

  it("hides the token of a step even when the stored one was never known to the live set", async () => {
    const { runShell } = await import("../src/steps/shell.js");
    const logFile = join(gh.tmp, "pin.log");
    const r = await runShell({ command: 'echo "token=$T"', cwd: gh.tmp, env: { T: TOKEN2 }, logFile, pinnedSecrets: [TOKEN2] });
    expect(r.output).toContain("token=[redacted]");
    expect(readFileSync(logFile, "utf8")).not.toContain(TOKEN2);
    const plain = await runShell({ command: 'echo "token=$T"', cwd: gh.tmp, env: { T: TOKEN2 }, logFile: join(gh.tmp, "plain.log") });
    expect(plain.output).toContain(TOKEN2);
  });

  it("keeps hiding the token when the stored one is removed while the step runs", async () => {
    const r = tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const flow = parseFlow(`name: refine-brief\nworkspace: empty\nsteps:\n  - id: clone\n    type: shell\n    run: 'sleep 1; echo "late=$GH_TOKEN"'\n`, "rot.yaml");
    const running = go(flow, { source: REFINE, owner: user.id });
    await new Promise((res) => setTimeout(res, 400));
    removeCredential(user.id, r.credentialId!);
    const s = await running;
    expect(out(s, "clone")).toBe("late=[redacted]");
  });

  it("passes the repository variables into a sandboxed step, not the values on the command line", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    const bin = join(gh.tmp, "bin");
    writeFileSync(join(bin, "docker"), '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n', { mode: 0o755 });
    const flow = parseFlow("name: refine-brief\nworkspace: empty\nsteps:\n  - id: clone\n    type: shell\n    sandbox: true\n    run: 'true'\n", "box.yaml");
    const s = await go(flow, { source: REFINE, owner: user.id, config: ConfigSchema.parse({ protected_branches: [], sandbox: { docker_image: "img" } }) });
    const o = out(s, "clone");
    for (const name of ["GH_TOKEN", "GIT_CONFIG_GLOBAL", "GIT_ALLOW_PROTOCOL", "GIT_TERMINAL_PROMPT"]) expect(o).toContain(`arg:${name}\n`);
    expect(o).not.toContain(TOKEN);
  });

  it("finds a repository that is literally named .git", () => {
    addRepo(user.id, { url: "acme/.git", method: "github-token", token: TOKEN });
    expect(repoAccess(user.id, "acme/.git")).toEqual({ kind: "token", token: TOKEN });
  });
});

// ---- the shipped flow ----------------------------------------------------------------------------

describe("the shipped refine-brief flow", { timeout: 60_000 }, () => {
  const ship = (extra: { source?: string; owner?: string }) =>
    runFlow(loadFlow("refine-brief", gh.tmp).flow, { task: "Let people export CSV", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: ConfigSchema.parse({ protected_branches: [] }), ...extra });
  const shipUser = () => ship({ source: REFINE, owner: user.id });

  it("succeeds with the stored token, keeps it from the agent and from .git/config", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    process.env.FAKE_BRIEF = "ECHO";
    const s = await shipUser();
    expect(s.status).toBe("succeeded");
    expect(out(s, "brief")).toContain("gh_token=none");
    const conf = readFileSync(join(s.workdir!, "repo", ".git", "config"), "utf8");
    expect(conf).not.toContain(TOKEN);
    expect(conf).toContain("helper");
  });

  it("fails with the refused sentence when GitHub refuses the token", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN2;
    const s = await shipUser();
    expect(s.status).toBe("failed");
    expect(s.history.map((h) => h.id)).toEqual(["clone"]);
    expect(s.reason).toBe(`step "clone" failed: ${TOKEN_REFUSED_REASON}`);
  });

  it("a git 403 on the clone and a refusal in the issue list give the same sentence; a rate limit does not", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    process.env.FAKE_GH_FAIL = "repo clone";
    process.env.FAKE_GH_FAIL_TEXT = "remote: Write access to repository not granted.\nfatal: The requested URL returned error: 403";
    expect((await shipUser()).reason).toBe(`step "clone" failed: ${TOKEN_REFUSED_REASON}`);
    process.env.FAKE_GH_FAIL = "issue list";
    process.env.FAKE_GH_FAIL_TEXT = "Resource not accessible by personal access token";
    const s = await shipUser();
    expect(s.history.map((h) => h.id)).toEqual(["clone", "list_issues"]);
    expect(s.reason).toBe(`step "list_issues" failed: ${TOKEN_REFUSED_REASON}`);
    process.env.FAKE_GH_FAIL_TEXT = "HTTP 403: API rate limit exceeded";
    expect((await shipUser()).reason).toBe('step "list_issues" failed: exit code 1');
  });

  it("none: a user is refused before gh runs, an admin reads with the server's access", async () => {
    const rec = addRepo(user.id, "acme/app");
    process.env.FAKE_GH_EXPECT_TOKEN = "";
    const s = await shipUser();
    expect(s.reason).toBe(`step "clone" failed: ${NEEDS_TOKEN}`);
    expect(gh.ghLog()).toBe("");
    transferRepo(rec.id, "admin@example.com");
    expect((await ship({ source: REFINE, owner: admin.id })).status).toBe("succeeded");
  });

  it("a missing credential fails before gh runs", async () => {
    const r = tokenRepo(user);
    removeCredential(user.id, r.credentialId!);
    expect((await shipUser()).reason).toContain("is missing");
    expect(gh.ghLog()).toBe("");
  });

  it("an unreadable repository list fails before gh runs", async () => {
    tokenRepo(user);
    writeFileSync(reposPath(), "not json");
    const s = await shipUser();
    expect(s.reason).toBe(`step "clone" failed: ${TOKEN_UNREADABLE}`);
    expect(gh.ghLog()).toBe("");
  });

  it("a run by hand gets no stored token", async () => {
    tokenRepo(user);
    process.env.FAKE_GH_EXPECT_TOKEN = "";
    const s = await ship({ source: "ui", owner: user.id });
    expect(s.status).toBe("succeeded");
  });
});
