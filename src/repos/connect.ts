import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckResult, ConnectionResult } from "../auth/repo-connection.js";
import type { RepoMethod } from "../auth/repos.js";
import { dataHome } from "../auth/store.js";
import { tryParseRepoUrl } from "../auth/repo-url.js";
import { gh } from "../github.js";

/** A test could not run at all (not a failed check). The message never holds a secret. */
export type ConnectErrorCode = "no-git" | "no-temp" | "bad-path" | "no-secret" | "failed";
export class ConnectError extends Error {
  constructor(
    public code: ConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/** The fixed words a check can end with. */
export const CODES = [
  "ok", "skipped", "deploy-key", "bad-token", "bad-key", "no-sign-in", "not-found", "read-only", "empty", "unreachable",
  "host-key-changed", "host-key-unknown", "timeout", "failed", "no-issues", "no-pulls", "no-issues-pulls", "rate-limit", "no-gh",
] as const;
export type Code = (typeof CODES)[number];
export type CheckName = CheckResult["check"];

/** The time a whole test may take. */
export const TEST_TIMEOUT_MS = 60_000;
const FOLDER_PREFIX = "scf-connect-";

// ---- messages --------------------------------------------------------------------------------------

/** A fixed sentence that says what happened and what to do. Never text from git, ssh or gh. */
export function messageFor(code: Code, method: RepoMethod, check: CheckName = "clone"): string {
  const key = method === "ssh-deploy-key";
  const none = method === "none";
  switch (code) {
    case "ok":
      return check === "clone"
        ? "The repository can be read."
        : check === "push"
          ? "Write access works. Nothing was pushed."
          : "The repository, its issues and its pull requests can be read.";
    case "skipped":
      return "Not checked, because the check before it failed.";
    case "deploy-key":
      return "A deploy key gives git access only; issues and pull requests are not checked.";
    case "bad-token":
      return "The host did not accept the token. It may be wrong or expired. Make a new token and use Change authentication.";
    case "bad-key":
      return "The host did not accept the deploy key. Add the public key shown on this page as a deploy key of the repository, with write access.";
    case "no-sign-in":
      return "The server has no sign-in for this repository. Set up the server's access (for example gh auth login), or choose another authentication.";
    case "not-found":
      return key
        ? "The repository was not found, or the deploy key has no access to it. Check the address and add the public key as a deploy key of this repository."
        : none
          ? "The repository was not found, or the server's own access cannot see it. Check the address and the server's access."
          : "The repository was not found, or the token has no access to it. Check the address, and give the token access to this repository.";
    case "read-only":
      return key
        ? "The deploy key was added without write access. Remove it and add it again with Allow write access."
        : none
          ? "The server's own access can read the repository but not write to it. Ask for write access."
          : "The sign-in can read the repository but not write to it. Give the token Contents: Read and write.";
    case "empty":
      return "The repository is empty, so write access could not be checked. Push a first commit and test again.";
    case "unreachable":
      return "The host could not be reached. Check the address, and that the server can reach the internet.";
    case "host-key-changed":
      return `The host key of the server changed. If that is expected, remove the line of this host from ${none ? "~/.ssh/known_hosts of the server's account" : "known_hosts in the data folder"} and test again. If not, do not trust this host.`;
    case "host-key-unknown":
      return none
        ? "The host key could not be verified. Connect to the host once from the server's account, or check its SSH configuration."
        : "The host key could not be verified. Check the address of the host, and known_hosts in the data folder.";
    case "timeout":
      return "The check took too long and was stopped. Check that the host is reachable, or try again.";
    case "failed":
      return "The check failed for a reason the Foundry does not know. Check the address and the sign-in, then test again.";
    case "no-issues":
      return "The sign-in cannot read the issues of this repository. Give the token Issues: Read and write; the Foundry needs it to read and comment on issues.";
    case "no-pulls":
      return "The sign-in cannot read the pull requests of this repository. Give the token Pull requests: Read and write; the Foundry needs it to open and update them.";
    case "no-issues-pulls":
      return "The sign-in cannot read issues or pull requests. Give the token Issues and Pull requests: Read and write; the Foundry needs both.";
    case "rate-limit":
      return "GitHub's request limit is used up. Wait a while and test again.";
    case "no-gh":
      return "The GitHub command line tool (gh) was not found on the server.";
  }
}

const result = (check: CheckName, code: Code, method: RepoMethod, extra: { ok?: boolean; skipped?: true } = {}): CheckResult => ({
  check,
  ok: extra.ok ?? code === "ok",
  ...(extra.skipped ? { skipped: true as const } : {}),
  code,
  message: messageFor(code, method, check),
});

// ---- classifying -----------------------------------------------------------------------------------

/** Which code a failed git command gets, from its stderr. Unknown text is "failed", never a wrong "ok". */
export function classifyGit(stage: "clone" | "push", text: string, opts: { method: RepoMethod; timedOut?: boolean }): Code {
  if (opts.timedOut) return "timeout";
  const t = text;
  const signIn = (): Code => (opts.method === "none" ? "no-sign-in" : opts.method === "ssh-deploy-key" ? "bad-key" : "bad-token");
  if (/Permission denied \(publickey/i.test(t)) return signIn();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key .*has changed/i.test(t)) return "host-key-changed";
  if (/Host key verification failed/i.test(t)) return "host-key-unknown";
  if (/Could not resolve host|Name or service not known|nodename nor servname|Network is unreachable|No route to host|Connection refused|Connection timed out|Failed to connect|Operation timed out/i.test(t)) return "unreachable";
  if (stage === "push" && /src refspec .* does not match any|does not match any/i.test(t)) return "empty";
  // GitLab over ssh, Azure DevOps and others say "not found" in their own words, also when the cause is no access
  if (/could not be found|don't have permission to view|TF401019|does not exist or you do not have/i.test(t)) return "not-found";
  if (stage === "push" && /read[- ]only|Write access to repository not granted|Permission to .* denied|not allowed to push|permission denied for writing|insufficient (permission|privileges)|do(es)? not have (write )?permission to push|error: 403/i.test(t)) return "read-only";
  if (/Invalid username or token|Authentication failed|error: 401|Bad credentials|Access denied/i.test(t)) return signIn();
  if (/terminal prompts disabled|could not read (Username|Password)/i.test(t)) return opts.method === "none" ? "no-sign-in" : signIn();
  if (/Repository not found|not found|does not appear to be a git repository|error: 404|error: 403|does not exist/i.test(t)) return "not-found";
  return "failed";
}

/** What an execFile error of `gh` looks like. */
export interface GhFailure {
  killed?: boolean;
  signal?: string | null;
  code?: number | string | null;
  stderr?: string;
  message?: string;
}

/** Which code a failed `gh api` call gets. `stage` says which call it was (a 403 on the issues call means no issues permission). */
export function classifyGh(stage: "repo" | "issues" | "pulls", err: unknown, method?: RepoMethod): Code {
  const e = (err ?? {}) as GhFailure;
  if (e.killed || e.signal) return "timeout";
  if (e.code === "ENOENT") return "no-gh";
  const t = `${e.stderr ?? ""}\n${e.message ?? ""}`;
  if (/rate limit/i.test(t)) return "rate-limit";
  if (/HTTP 401|Bad credentials|gh auth login|not logged in/i.test(t)) return method === "none" ? "no-sign-in" : "bad-token";
  if (/HTTP 404|Not Found/i.test(t)) return "not-found";
  if (/HTTP 403|Resource not accessible/i.test(t)) return stage === "issues" ? "no-issues" : stage === "pulls" ? "no-pulls" : "not-found";
  if (/error connecting|could not resolve|no such host|dial tcp/i.test(t)) return "unreachable";
  return "failed";
}

// ---- the environment of git and gh -----------------------------------------------------------------

export interface ConnectInput {
  url: string;
  method: RepoMethod;
  username?: string;
  /** The token or the private key. Not for the method "none". */
  secret?: string;
}

export interface ConnectOpts {
  timeoutMs?: number;
  /** The git program (default "git"). */
  git?: string;
  /** SSH host keys are kept here (default: known_hosts in the data folder). */
  knownHosts?: string;
}

export interface GitAuth {
  env: NodeJS.ProcessEnv;
  /** Arguments that go before the git command. */
  args: string[];
  /** The helper script that answers git's prompts. */
  askpass: string;
  /** The temporary private key file (deploy key only). */
  key?: string;
}

/** Tests only (like SCF_SECURITY_BIN): the path of a git repository that every test clones instead of the address. */
const localRemote = () => process.env.SCF_CONNECT_REMOTE || undefined;

const script = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};

/**
 * The environment and arguments of a git process for a method. The secret goes only into the environment of the child
 * (a token) or a 0600 file in `dir` (a key), never into an argument or the address. Every inherited GIT_* variable is
 * dropped. A token or key ignores the git configuration and credential helpers; "none" is the server's own access and keeps them.
 */
export function gitAuth(dir: string, input: Pick<ConnectInput, "method" | "username" | "secret">, knownHosts = join(dataHome(), "known_hosts")): GitAuth {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.LC_ALL = "C"; // the diagnostics are classified by their English text
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_ALLOW_PROTOCOL = localRemote() ? "file" : "https:ssh";
  const needSecret = () => {
    if (!input.secret) throw new ConnectError("no-secret", "the sign-in of this repository is missing");
    return input.secret;
  };
  if (input.method === "none") {
    const askpass = script(dir, "askpass", "exit 1");
    env.GIT_ASKPASS = askpass;
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    return { env, args: [], askpass };
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  const args = ["-c", "credential.helper="];
  if (input.method === "ssh-deploy-key") {
    const secret = needSecret();
    // the path travels in SCF_KNOWN_HOSTS; only a quote (ssh's own quoting) or a line break cannot be passed on
    if (/["\n\r]/.test(knownHosts)) throw new ConnectError("bad-path", "the data folder path cannot be used for the SSH host keys");
    mkdirSync(dirname(knownHosts), { recursive: true, mode: 0o700 });
    const key = join(dir, "key");
    writeFileSync(key, secret.endsWith("\n") ? secret : `${secret}\n`, { mode: 0o600 });
    chmodSync(key, 0o600);
    delete env.SSH_AUTH_SOCK;
    env.SCF_SSH_KEY = key;
    env.SCF_KNOWN_HOSTS = knownHosts;
    env.GIT_SSH_COMMAND = 'ssh -F /dev/null -i "$SCF_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=\\"$SCF_KNOWN_HOSTS\\""';
    const askpass = script(dir, "askpass", "exit 1");
    env.GIT_ASKPASS = askpass;
    return { env, args, askpass, key };
  }
  const secret = needSecret();
  const askpass = script(dir, "askpass", 'case "$1" in\n  Username*) printf \'%s\\n\' "$SCF_GIT_USERNAME" ;;\n  Password*) printf \'%s\\n\' "$SCF_GIT_PASSWORD" ;;\n  *) exit 1 ;;\nesac');
  env.GIT_ASKPASS = askpass;
  env.SCF_GIT_USERNAME = input.method === "https-token" ? (input.username ?? "") : "x-access-token";
  env.SCF_GIT_PASSWORD = secret;
  return { env, args, askpass };
}

/**
 * Extra environment for `gh`. A token is passed in GH_TOKEN with an empty configuration folder (so a stored `gh` sign-in is
 * not used); "none" adds nothing, so `gh` acts as the server's account.
 */
export function ghEnv(method: RepoMethod, secret: string | undefined, dir: string): NodeJS.ProcessEnv {
  if (method === "none" || !secret) return { GH_PROMPT_DISABLED: "1", LC_ALL: "C" };
  const config = join(dir, "gh-config");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  return { GH_PROMPT_DISABLED: "1", LC_ALL: "C", GH_TOKEN: secret, GH_CONFIG_DIR: config };
}

// ---- running ---------------------------------------------------------------------------------------

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(git: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = execFile(git, args, { env, cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1_000_000, windowsHide: true }, (err, out, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(out), stderr: String(stderr), timedOut: false });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === "ENOENT") return reject(new ConnectError("no-git", "git was not found on the server"));
      resolve({ code: typeof e.code === "number" ? e.code : null, stdout: String(out ?? ""), stderr: String(stderr ?? ""), timedOut: e.killed === true });
    });
    child.stdin?.end();
  });
}

async function gitChecks(url: string, input: ConnectInput, auth: GitAuth, dir: string, git: string, left: () => number): Promise<CheckResult[]> {
  const remote = localRemote();
  const address = remote ? `file://${remote}` : url;
  const repo = join(dir, "repo");
  const cloned = await run(git, [...auth.args, "clone", "--depth", "1", "--no-checkout", "--quiet", "--", address, repo], auth.env, dir, left());
  if (cloned.code !== 0) {
    const code = classifyGit("clone", cloned.stderr, { method: input.method, timedOut: cloned.timedOut });
    return [result("clone", code, input.method), result("push", "skipped", input.method, { ok: false, skipped: true })];
  }
  const scratch = `scf-connection-test-${randomBytes(4).toString("hex")}`;
  // an empty repository, or a remote whose HEAD points nowhere, has no commit to push: make one locally (never sent)
  let source = "HEAD";
  const head = await run(git, [...auth.args, "rev-parse", "--verify", "--quiet", "HEAD"], auth.env, repo, left());
  if (head.code !== 0) {
    const who = { GIT_AUTHOR_NAME: "scf", GIT_AUTHOR_EMAIL: "scf@localhost", GIT_COMMITTER_NAME: "scf", GIT_COMMITTER_EMAIL: "scf@localhost" };
    const env = { ...auth.env, ...who };
    const tree = await run(git, ["hash-object", "-t", "tree", "-w", "--stdin"], env, repo, left());
    const commit = tree.code === 0 ? await run(git, ["commit-tree", tree.stdout.trim(), "-m", "connection test"], env, repo, left()) : tree;
    if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit.stdout.trim())) {
      const code = commit.timedOut ? "timeout" : "failed";
      return [result("clone", "ok", input.method), result("push", code, input.method)];
    }
    source = commit.stdout.trim();
  }
  const pushed = await run(git, [...auth.args, "push", "--dry-run", "origin", `${source}:refs/heads/${scratch}`], auth.env, repo, left());
  const push = pushed.code === 0 ? "ok" : classifyGit("push", pushed.stderr, { method: input.method, timedOut: pushed.timedOut });
  return [result("clone", "ok", input.method), result("push", push, input.method)];
}

async function apiCheck(github: string, input: ConnectInput, dir: string, left: () => number): Promise<CheckResult> {
  const { method } = input;
  if (method === "ssh-deploy-key") return result("github-api", "deploy-key", method, { ok: true, skipped: true });
  const env = ghEnv(method, input.secret, dir);
  const call = (path: string) => gh(["api", path, "--hostname", "github.com"], env, left());
  const base = `repos/${github}`;
  try {
    await call(base);
  } catch (e) {
    return result("github-api", classifyGh("repo", e, method), method);
  }
  const [issues, pulls] = await Promise.allSettled([call(`${base}/issues?per_page=1`), call(`${base}/pulls?per_page=1&state=all`)]);
  const ci: Code = issues.status === "rejected" ? classifyGh("issues", issues.reason, method) : "ok";
  const cp: Code = pulls.status === "rejected" ? classifyGh("pulls", pulls.reason, method) : "ok";
  const code: Code = ci === "no-issues" && cp === "no-pulls" ? "no-issues-pulls" : ci !== "ok" ? ci : cp;
  return result("github-api", code, method);
}

/** Removes `scf-connect-*` folders in the temporary folder that are older than `maxAgeMs` (left by a crashed test). */
export function sweepConnectFolders(maxAgeMs = 3_600_000, now = Date.now()): void {
  try {
    const base = tmpdir();
    for (const name of readdirSync(base)) {
      if (!name.startsWith(FOLDER_PREFIX)) continue;
      const path = join(base, name);
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
      } catch {
        // gone or not ours to remove: leave it
      }
    }
  } catch {
    // no temporary folder to read
  }
}

/**
 * Tests a repository's connection: a shallow clone, a dry-run push and (for a GitHub repository) reading it through the API.
 * The clone and push run one after the other, the API checks beside them; the call ends when all have ended. The temporary
 * folder (with the key file) is always removed. A failed check is a result; only a test that cannot run throws a ConnectError.
 */
export async function testConnection(input: ConnectInput, opts: ConnectOpts = {}): Promise<ConnectionResult> {
  sweepConnectFolders();
  const deadline = Date.now() + (opts.timeoutMs ?? TEST_TIMEOUT_MS);
  const left = () => Math.max(1, deadline - Date.now());
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), FOLDER_PREFIX));
  } catch {
    throw new ConnectError("no-temp", "no temporary folder could be made");
  }
  try {
    const auth = gitAuth(dir, input, opts.knownHosts);
    const github = tryParseRepoUrl(input.url)?.github;
    const [g, a] = await Promise.allSettled([
      gitChecks(input.url, input, auth, dir, opts.git ?? "git", left),
      github ? apiCheck(github, input, dir, left) : Promise.resolve(undefined),
    ]);
    if (g.status === "rejected") throw g.reason instanceof ConnectError ? g.reason : new ConnectError("failed", "the test could not run");
    if (a.status === "rejected") throw a.reason instanceof ConnectError ? a.reason : new ConnectError("failed", "the test could not run");
    const checks = a.value ? [...g.value, a.value] : g.value;
    return { at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
