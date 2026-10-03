import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_METHODS } from "../src/auth/repos.js";
import { CODES, type ConnectInput, type ConnectOpts, ConnectError, classifyGh, classifyGit, ghEnv, gitAuth, messageFor, sweepConnectFolders, testConnection } from "../src/repos/connect.js";
import { fakeGithub } from "./helpers/fake-github.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZSBrZXkgbGluZQ==\n-----END OPENSSH PRIVATE KEY-----";
const URL = "https://github.com/acme/app";
const SSH_URL = "git@github.com:acme/app.git";

// fakeGithub().restore() swaps process.env for a copy, and os.tmpdir() reads the real one: keep the real object and put it back
const realEnv = process.env;
let snapshot: NodeJS.ProcessEnv;
let fg: ReturnType<typeof fakeGithub>;
let scratch: string; // the TMPDIR of the test: a leftover folder shows up here
let tools: string;
let envLog: string;
let gitLog: string;
let wrapGh: string;
let wrapGit: string;

beforeEach(() => {
  snapshot = { ...realEnv };
  scratch =mkdtempSync(join(tmpdir(), "connect-tmp-"));
  fg = fakeGithub();
  tools = mkdtempSync(join(fg.tmp, "tools-"));
  envLog = join(tools, "gh-env.log");
  gitLog = join(tools, "git.log");
  writeFileSync(envLog, "");
  writeFileSync(gitLog, "");
  wrapGh = join(tools, "gh");
  writeFileSync(
    wrapGh,
    `#!/bin/sh
echo "GH_TOKEN=$GH_TOKEN|GH_HOST=$GH_HOST|GH_CONFIG_DIR=$GH_CONFIG_DIR|ARGS=$*" >> "$GHWRAP_ENV_LOG"
if [ -n "$GHWRAP_FAIL_BOTH" ]; then case "$*" in *"/issues?"*|*"/pulls?"*) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;; esac; fi
exec "${resolve("tests/fixtures/fake-gh.sh")}" "$@"
`,
    { mode: 0o755 },
  );
  wrapGit = join(tools, "git");
  writeFileSync(
    wrapGit,
    `#!/bin/sh
echo "$*" >> "$GITWRAP_LOG"
case " $* " in *" push "*)
  git rev-parse --is-shallow-repository >> "$GITWRAP_LOG"
  if [ -n "$GITWRAP_PUSH_ERR" ]; then printf '%s\\n' "$GITWRAP_PUSH_ERR" >&2; exit 128; fi ;;
esac
exec git "$@"
`,
    { mode: 0o755 },
  );
  chmodSync(wrapGh, 0o755);
  chmodSync(wrapGit, 0o755);
  Object.assign(process.env, { TMPDIR: scratch, SCF_CONNECT_REMOTE: fg.remote, GHWRAP_ENV_LOG: envLog, GITWRAP_LOG: gitLog });
  delete process.env.GH_TOKEN;
  delete process.env.GH_HOST;
  delete process.env.GH_CONFIG_DIR;
});
afterEach(() => {
  fg.restore();
  process.env = realEnv;
  for (const k of Object.keys(realEnv)) if (!(k in snapshot)) delete realEnv[k];
  Object.assign(realEnv, snapshot);
  rmSync(scratch, { recursive: true, force: true });
});

const test = (input: Partial<ConnectInput> = {}, opts: ConnectOpts = {}) => testConnection({ url: URL, method: "github-token", secret: TOKEN, ...input }, opts);
const codes = (r: { checks: { check: string; code: string }[] }) => Object.fromEntries(r.checks.map((c) => [c.check, c.code]));
const left = () => readdirSync(scratch);
const ghCalls = () => readFileSync(envLog, "utf8").split("\n").filter(Boolean);
const useGhWrapper = () => (process.env.FACTORY_GH_BIN = wrapGh);

// ---- classifying -----------------------------------------------------------------------------------

describe("classifyGit", () => {
  const t = { method: "github-token" } as const;
  it("tells the clone failures apart", () => {
    expect(classifyGit("clone", "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/a/b.git/'", t)).toBe("bad-token");
    expect(classifyGit("clone", "fatal: unable to access 'https://x/': The requested URL returned error: 401", t)).toBe("bad-token");
    expect(classifyGit("clone", "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found", t)).toBe("not-found");
    expect(classifyGit("clone", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", { method: "ssh-deploy-key" })).toBe("bad-key");
    expect(classifyGit("clone", "something nobody knows", t)).toBe("failed");
  });
  it("tells the push failures apart", () => {
    const auth = "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'";
    expect(classifyGit("push", auth, t)).toBe("bad-token");
    expect(classifyGit("push", auth, { method: "none" })).toBe("no-sign-in");
    expect(classifyGit("push", "remote: Permission to a/b.git denied to u.\nfatal: unable to access 'https://x/': The requested URL returned error: 403", t)).toBe("read-only");
    expect(classifyGit("push", "remote: Write access to repository not granted.\nfatal: unable to access", t)).toBe("read-only");
    expect(classifyGit("push", "ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.", { method: "ssh-deploy-key" })).toBe("read-only");
    expect(classifyGit("push", "error: src refspec HEAD does not match any\nerror: failed to push some refs", t)).toBe("empty");
  });
  it("knows the wording of other hosts", () => {
    expect(classifyGit("push", "remote: GitLab: You are not allowed to push code to this project.\nfatal: unable to access", t)).toBe("read-only");
    expect(classifyGit("push", "fatal: unable to access 'https://gitea/': User permission denied for writing.", t)).toBe("read-only");
    const ssh = { method: "ssh-deploy-key" } as const;
    expect(classifyGit("clone", "remote: ERROR: The project you were looking for could not be found or you don't have permission to view it.\nfatal: Could not read from remote repository.", ssh)).toBe("not-found");
    expect(classifyGit("push", "remote: ERROR: The project you were looking for could not be found or you don't have permission to view it.", ssh)).toBe("not-found");
    expect(classifyGit("clone", "remote: TF401019: The Git repository with name or identifier x does not exist or you do not have permissions for the operation you are attempting.", t)).toBe("not-found");
  });

  it("tells host problems apart for any stage", () => {
    expect(classifyGit("clone", "fatal: unable to access 'https://x/': Could not resolve host: x", t)).toBe("unreachable");
    expect(classifyGit("clone", "ssh: Could not resolve hostname x: Name or service not known", { method: "ssh-deploy-key" })).toBe("unreachable");
    expect(classifyGit("clone", "ssh: connect to host x port 22: Connection refused", { method: "ssh-deploy-key" })).toBe("unreachable");
    expect(classifyGit("clone", "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", { method: "ssh-deploy-key" })).toBe("host-key-changed");
    expect(classifyGit("clone", "Host key verification failed.\nfatal: Could not read from remote repository.", { method: "ssh-deploy-key" })).toBe("host-key-unknown");
    expect(classifyGit("clone", "", { ...t, timedOut: true })).toBe("timeout");
    expect(classifyGit("clone", "fatal: could not read Username for 'https://github.com': terminal prompts disabled", { method: "none" })).toBe("no-sign-in");
  });
});

describe("classifyGh", () => {
  it("tells the API failures apart", () => {
    const e = (stderr: string, more: object = {}) => ({ stderr, ...more });
    expect(classifyGh("repo", e("gh: Bad credentials (HTTP 401)"))).toBe("bad-token");
    expect(classifyGh("repo", e("gh: Bad credentials (HTTP 401)"), "none")).toBe("no-sign-in");
    expect(classifyGh("repo", e("gh: Not Found (HTTP 404)"))).toBe("not-found");
    expect(classifyGh("issues", e("gh: Resource not accessible by personal access token (HTTP 403)"))).toBe("no-issues");
    expect(classifyGh("pulls", e("gh: Resource not accessible by personal access token (HTTP 403)"))).toBe("no-pulls");
    expect(classifyGh("issues", e("gh: API rate limit exceeded (HTTP 403)"))).toBe("rate-limit");
    expect(classifyGh("repo", e("error connecting to api.github.com"))).toBe("unreachable");
    expect(classifyGh("repo", e("", { killed: true, signal: "SIGTERM" }))).toBe("timeout");
    expect(classifyGh("repo", e("", { code: "ENOENT" }))).toBe("no-gh");
    expect(classifyGh("repo", e("boom"))).toBe("failed");
  });
});

describe("messageFor", () => {
  it("gives a short plain sentence for every code and method", () => {
    for (const code of CODES) {
      for (const method of REPO_METHODS) {
        for (const check of ["clone", "push", "github-api"] as const) {
          const m = messageFor(code, method, check);
          expect(m.length, `${code} ${method}`).toBeGreaterThan(10);
          expect(m.length, `${code} ${method}`).toBeLessThanOrEqual(300);
          expect(/[\u0000-\u001f\u007f-\u009f]/.test(m)).toBe(false);
        }
      }
    }
  });
  it("points the host key messages at the right known_hosts file", () => {
    for (const code of ["host-key-changed", "host-key-unknown"] as const) {
      expect(messageFor(code, "ssh-deploy-key")).toContain("known_hosts in the data folder");
    }
    expect(messageFor("host-key-changed", "none")).toContain("~/.ssh/known_hosts");
    expect(messageFor("host-key-changed", "none")).not.toContain("data folder");
    expect(messageFor("host-key-unknown", "none")).not.toContain("data folder");
  });

  it("names the deploy key problem and what the Foundry needs", () => {
    expect(messageFor("read-only", "ssh-deploy-key", "push")).toContain("added without write access");
    for (const code of ["no-issues", "no-pulls", "no-issues-pulls"] as const) {
      const m = messageFor(code, "github-token", "github-api");
      expect(m).toContain("Read and write");
      expect(m).toMatch(/issues|pull requests/i);
    }
  });
});

// ---- the environment -------------------------------------------------------------------------------

describe("gitAuth", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(scratch, "dir-"));
  });
  const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
    const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const INHERITED = { GIT_DIR: "/nowhere", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_CONFIG_PARAMETERS: "'a.b=c'" };

  it("a token: only in SCF_GIT_PASSWORD, and the configuration is ignored", () => {
    const a = withEnv(INHERITED, () => gitAuth(dir, { method: "github-token", secret: TOKEN }));
    for (const k of Object.keys(INHERITED)) expect(a.env[k]).toBeUndefined();
    expect(a.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(a.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(a.args).toContain("credential.helper=");
    expect(a.env.GIT_ALLOW_PROTOCOL).toBe("file");
    const saved = process.env.SCF_CONNECT_REMOTE;
    delete process.env.SCF_CONNECT_REMOTE;
    try {
      expect(gitAuth(dir, { method: "github-token", secret: TOKEN }).env.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
    } finally {
      process.env.SCF_CONNECT_REMOTE = saved;
    }
    expect(a.args.join(" ")).not.toContain(TOKEN);
    expect(Object.entries(a.env).filter(([, v]) => v?.includes(TOKEN)).map(([k]) => k)).toEqual(["SCF_GIT_PASSWORD"]);
    const ask = (q: string) => execFileSync(a.askpass, [q], { env: a.env, encoding: "utf8" });
    expect(ask("Password for 'https://github.com': ")).toBe(`${TOKEN}\n`);
    expect(ask("Username for 'https://github.com': ")).toBe("x-access-token\n");
    const other = gitAuth(dir, { method: "https-token", username: "bob", secret: TOKEN });
    expect(execFileSync(other.askpass, ["Username for 'https://x': "], { env: other.env, encoding: "utf8" })).toBe("bob\n");
  });

  it("a deploy key: a 0600 file, IdentitiesOnly, no agent", () => {
    const hosts = join(dir, "known_hosts");
    const a = withEnv({ ...INHERITED, SSH_AUTH_SOCK: "/tmp/agent" }, () => gitAuth(dir, { method: "ssh-deploy-key", secret: KEY }, hosts));
    expect(statSync(a.key!).mode & 0o777).toBe(0o600);
    expect(readFileSync(a.key!, "utf8")).toContain("ZmFrZSBrZXkgbGluZQ==");
    const cmd = a.env.GIT_SSH_COMMAND!;
    for (const part of ["IdentitiesOnly=yes", "accept-new", "-F /dev/null", "$SCF_SSH_KEY", "$SCF_KNOWN_HOSTS"]) expect(cmd).toContain(part);
    // the path travels in the environment, so any path works but one with a quote
    expect(a.env.SCF_KNOWN_HOSTS).toBe(hosts);
    expect(cmd).not.toContain(hosts);
    const odd = join(dir, "a $b `c` \\d", "known_hosts");
    expect(gitAuth(dir, { method: "ssh-deploy-key", secret: KEY }, odd).env.SCF_KNOWN_HOSTS).toBe(odd);
    expect(a.env.LC_ALL).toBe("C");
    expect(cmd).not.toContain("ZmFrZSBrZXkgbGluZQ==");
    expect(a.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(a.env.GIT_DIR).toBeUndefined();
    expect(Object.values(a.env).some((v) => v?.includes("ZmFrZSBrZXkgbGluZQ=="))).toBe(false);
    expect(() => gitAuth(dir, { method: "ssh-deploy-key", secret: KEY }, join(dir, 'a"b'))).toThrow(ConnectError);
  });

  it("none: the server's own access, no inherited GIT_ variable, no prompt", () => {
    const a = withEnv(INHERITED, () => gitAuth(dir, { method: "none" }));
    expect(a.env.GIT_DIR).toBeUndefined();
    expect(a.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(a.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(a.env.LC_ALL).toBe("C");
    expect(a.args).toEqual([]);
    expect(a.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    const r = spawnSync(a.askpass, ["Password: "], { env: a.env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("a method with a secret and no secret cannot run", () => {
    expect(() => gitAuth(dir, { method: "github-token" })).toThrow(ConnectError);
  });
});

describe("ghEnv", () => {
  it("a token gets its own empty configuration folder; none adds no token", () => {
    const dir = mkdtempSync(join(scratch, "dir-"));
    const t = ghEnv("github-token", TOKEN, dir);
    expect(t.GH_TOKEN).toBe(TOKEN);
    expect(t.GH_CONFIG_DIR!.startsWith(dir)).toBe(true);
    expect(readdirSync(t.GH_CONFIG_DIR!)).toEqual([]);
    expect(t.LC_ALL).toBe("C");
    const n = ghEnv("none", undefined, dir);
    expect(n.LC_ALL).toBe("C");
    expect(n.GH_TOKEN).toBeUndefined();
    expect(n.GH_CONFIG_DIR).toBeUndefined();
  });
});

// ---- the checks ------------------------------------------------------------------------------------

describe("testConnection", () => {
  it("github-token: three checks pass, nothing is pushed, nothing is left", async () => {
    useGhWrapper();
    process.env.GH_HOST = "evil.example";
    process.env.GH_CONFIG_DIR = "/inherited/config";
    const refs = fg.remoteGit("for-each-ref");
    const r = await test();
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.check, c.ok, c.code])).toEqual([["clone", true, "ok"], ["push", true, "ok"], ["github-api", true, "ok"]]);
    expect(fg.remoteGit("for-each-ref")).toBe(refs);
    expect(left()).toEqual([]);
    const calls = ghCalls();
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c).toContain("--hostname github.com");
      expect(c).toContain(`GH_TOKEN=${TOKEN}|`);
      expect(c).toContain(`GH_CONFIG_DIR=${scratch}`);
    }
    expect(calls.filter((c) => /ARGS=api repos\/acme\/app( |$)/.test(c))).toHaveLength(1);
    expect(calls.some((c) => c.includes("/issues?"))).toBe(true);
    expect(calls.some((c) => c.includes("/pulls?"))).toBe(true);
    expect(fg.ghLog()).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("an SSH deploy key on GitHub: the API check is skipped and gh is not called", async () => {
    useGhWrapper();
    const r = await test({ url: SSH_URL, method: "ssh-deploy-key", secret: KEY });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.check === "github-api")).toMatchObject({ ok: true, skipped: true, code: "deploy-key" });
    expect(ghCalls()).toEqual([]);
    expect(left()).toEqual([]);
  });

  it("https-token on another host: two checks", async () => {
    const r = await test({ url: "https://git.example.com/acme/app", method: "https-token", username: "bob" });
    expect(r.checks.map((c) => c.check)).toEqual(["clone", "push"]);
    expect(r.ok).toBe(true);
  });

  it("none: gh runs with the server's own sign-in", async () => {
    useGhWrapper();
    process.env.GH_CONFIG_DIR = "/inherited/config";
    const r = await test({ method: "none", secret: undefined });
    expect(r.ok).toBe(true);
    for (const c of ghCalls()) {
      expect(c).toContain("GH_TOKEN=|");
      expect(c).toContain("GH_CONFIG_DIR=/inherited/config|");
      expect(c).toContain("--hostname github.com");
    }
  });

  it("clones shallow (depth 1)", async () => {
    const work = join(fg.tmp, "work");
    execFileSync("git", ["clone", "-q", fg.remote, work]);
    writeFileSync(join(work, "b.txt"), "b\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "second"], { cwd: work });
    execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: work });
    const r = await test({}, { git: wrapGit });
    expect(r.ok).toBe(true);
    const log = readFileSync(gitLog, "utf8");
    expect(log).toContain("--depth 1");
    expect(log).toContain("true");
  });

  it("push: a wrong token, a token without write access, a read-only deploy key", async () => {
    process.env.GITWRAP_PUSH_ERR = "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/app.git/'";
    let r = await test({}, { git: wrapGit });
    expect(codes(r)).toMatchObject({ clone: "ok", push: "bad-token" });
    expect(r.ok).toBe(false);
    process.env.GITWRAP_PUSH_ERR = "remote: Permission to acme/app.git denied to u.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403";
    r = await test({}, { git: wrapGit });
    expect(codes(r).push).toBe("read-only");
    process.env.GITWRAP_PUSH_ERR = "ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.";
    r = await test({ url: SSH_URL, method: "ssh-deploy-key", secret: KEY }, { git: wrapGit });
    expect(r.checks.find((c) => c.check === "push")!.message).toContain("added without write access");
    expect(left()).toEqual([]);
  });

  it("an empty repository: write access is still checked, with a local commit that is never sent", async () => {
    const empty = join(fg.tmp, "empty.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", empty]);
    process.env.SCF_CONNECT_REMOTE = empty;
    const r = await test();
    expect(codes(r)).toMatchObject({ clone: "ok", push: "ok" });
    expect(execFileSync("git", ["for-each-ref"], { cwd: empty, encoding: "utf8" })).toBe("");
    expect(left()).toEqual([]);
    // and a refused push on an empty repository is reported as what it is
    process.env.GITWRAP_PUSH_ERR = "remote: Permission to acme/app.git denied to u.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403";
    expect(codes(await test({}, { git: wrapGit })).push).toBe("read-only");
  });

  it("a missing repository: not found, the push check is skipped", async () => {
    process.env.SCF_CONNECT_REMOTE = join(fg.tmp, "nope.git");
    const r = await test();
    expect(codes(r)).toMatchObject({ clone: "not-found", push: "skipped" });
    expect(r.checks.find((c) => c.check === "push")).toMatchObject({ ok: false, skipped: true });
    expect(left()).toEqual([]);
  });

  it("a failing API: the issues permission, a wrong token, issues and pull requests", async () => {
    process.env.FAKE_GH_FAIL = "api repos/acme/app/issues?per_page=1";
    process.env.FAKE_GH_FAIL_TEXT = "gh: Resource not accessible by personal access token (HTTP 403)";
    let r = await test();
    expect(codes(r)).toMatchObject({ clone: "ok", push: "ok", "github-api": "no-issues" });
    expect(r.ok).toBe(false);
    process.env.FAKE_GH_FAIL = "api repos/acme/app";
    process.env.FAKE_GH_FAIL_TEXT = "gh: Bad credentials (HTTP 401)";
    r = await test();
    expect(codes(r)["github-api"]).toBe("bad-token");
    delete process.env.FAKE_GH_FAIL;
    useGhWrapper();
    process.env.GHWRAP_FAIL_BOTH = "1";
    r = await test();
    expect(codes(r)["github-api"]).toBe("no-issues-pulls");
    expect(left()).toEqual([]);
  });

  it("a timeout of the API check", async () => {
    process.env.FAKE_GH_SLEEP = "2";
    const r = await test({}, { timeoutMs: 300 });
    expect(codes(r)["github-api"]).toBe("timeout");
    expect(left()).toEqual([]);
  });

  it("a timeout of the clone", async () => {
    const r = await test({}, { timeoutMs: 1 });
    expect(codes(r)).toMatchObject({ clone: "timeout", push: "skipped" });
    expect(left()).toEqual([]);
  });

  it("a missing git program rejects only after the gh call ended, and cleans up", async () => {
    process.env.FAKE_GH_SLEEP = "1";
    const started = Date.now();
    await expect(test({}, { git: join(tools, "no-such-git") })).rejects.toMatchObject({ name: "ConnectError", code: "no-git" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(fg.ghLog()).toContain("gh api repos/acme/app");
    expect(left()).toEqual([]);
  });

  it("waits for the gh call even when the clone fails at once", async () => {
    process.env.SCF_CONNECT_REMOTE = join(fg.tmp, "nope.git");
    process.env.FAKE_GH_SLEEP = "1";
    const started = Date.now();
    await test();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(left()).toEqual([]);
  });

  it("a hostile git configuration: a token ignores it, none uses the server's", async () => {
    const home = mkdtempSync(join(fg.tmp, "home-"));
    writeFileSync(join(home, ".gitconfig"), `[url "${join(fg.tmp, "missing.git")}"]\n\tinsteadOf = file://${fg.remote}\n`);
    process.env.HOME = home;
    expect(codes(await test()).clone).toBe("ok");
    expect(codes(await test({ method: "none", secret: undefined })).clone).toBe("not-found");
    delete process.env.HOME;
    process.env.HOME = mkdtempSync(join(fg.tmp, "home-"));
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${join(fg.tmp, "missing.git")}.insteadOf`, GIT_CONFIG_VALUE_0: `file://${fg.remote}` });
    try {
      expect(codes(await test()).clone).toBe("ok");
      expect(codes(await test({ method: "none", secret: undefined })).clone).toBe("ok");
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
    }
  });

  it("sweeps old folders and keeps fresh ones", () => {
    const old = join(scratch, "scf-connect-old");
    const fresh = join(scratch, "scf-connect-new");
    mkdirSync(old);
    mkdirSync(fresh);
    const hourAgo = new Date(Date.now() - 3_700_000);
    utimesSync(old, hourAgo, hourAgo);
    sweepConnectFolders();
    expect(left()).toEqual(["scf-connect-new"]);
  });
});
