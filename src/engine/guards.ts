import { execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { FACTORY_HOME, flowDir, parseFlow } from "../flow/load.js";
import type { Flow, Step } from "../flow/schema.js";

const ZERO = "0000000000000000000000000000000000000000";

const PRE_PUSH = `#!/bin/sh
# Installed by Spaghetti Code Foundry: refuse pushes to protected branches, and pushes that add secrets.
while read local_ref local_sha remote_ref remote_sha; do
  branch=\${remote_ref#refs/heads/}
  set -f
  # The one exception: the hotfix merge step may push (not delete) the branch it was granted. FACTORY_PUSH_ALLOW
  # is "<branch>:<token>"; it counts only when the engine wrote that token (a file next to this hook) for the
  # running step, so a step that just sets the variable itself gets nothing.
  allowed=0
  if [ -n "$FACTORY_PUSH_ALLOW" ] && [ "$local_sha" != "${ZERO}" ]; then
    allow_branch=\${FACTORY_PUSH_ALLOW%%:*}; allow_token=\${FACTORY_PUSH_ALLOW#*:}
    case "$allow_token" in ""|*[!0-9a-f]*) ;; *)
      [ "$allow_branch" = "$branch" ] && [ "$(cat "$(dirname "$0")/allow/$allow_token" 2>/dev/null)" = "$branch" ] && allowed=1 ;;
    esac
  fi
  if [ "$allowed" != 1 ]; then
    for pattern in $FACTORY_PROTECTED_BRANCHES; do
      case "$branch" in
        $pattern) echo "Spaghetti Code Foundry: pushing to protected branch '$branch' is blocked" >&2; exit 1 ;;
      esac
    done
  fi
  set +f
  if [ -n "$FACTORY_SECRET_SCAN" ] && [ "$local_sha" != "${ZERO}" ]; then
    if [ "$remote_sha" = "${ZERO}" ]; then
      "$FACTORY_SECRET_SCAN" "$local_sha" --not --remotes || exit 1
    else
      "$FACTORY_SECRET_SCAN" "$remote_sha..$local_sha" || exit 1
    fi
  fi
done
exit 0
`;

/**
 * Env that makes every git command in the run use our pre-push hook, which refuses
 * pushes to protected branches and (with secretScan) pushes whose new commits contain
 * secrets. GIT_CONFIG_* applies to all git processes, including the ones agents start.
 * Note: this replaces the repo's own git hooks during runs.
 */
export function protectedBranchEnv(patterns: string[], secretScan = false): Record<string, string> {
  if (!patterns.length && !secretScan) return {};
  const dir = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "hooks");
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  writeFileSync(hook, PRE_PUSH);
  chmodSync(hook, 0o755);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: dir,
    FACTORY_PROTECTED_BRANCHES: patterns.join(" "),
    ...(secretScan ? { FACTORY_SECRET_SCAN: join(TOOLS_DIR, "secret-scan") } : {}),
  };
}

// ── Hotfixes: the one push to a protected branch ──

/** The flow and the step that may push to main: only the merge step of the unchanged built-in issue-gitflow. */
export const HOTFIX_FLOW = "issue-gitflow";
export const HOTFIX_PUSH_STEP = "push_main";

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

let shipped: string | undefined;
function shippedGitflow(): string | undefined {
  if (shipped !== undefined) return shipped;
  const file = join(flowDir("builtin", ""), `${HOTFIX_FLOW}.yaml`);
  if (!existsSync(file)) return undefined;
  return (shipped = canonical(parseFlow(readFileSync(file, "utf8"), file)));
}

/**
 * Is the hotfix path allowed for this run? "off": the setting is off. "other": the flow is not the
 * built-in issue-gitflow (any changed step, variable default, limit or sandbox counts as changed).
 * "on": the setting is on and the flow is the shipped one. Fails closed.
 */
export function hotfixState(flow: Flow, config: Pick<Config, "hotfix_to_main">): "on" | "off" | "other" {
  if (!config.hotfix_to_main) return "off";
  try {
    const want = shippedGitflow();
    return want !== undefined && flow.name === HOTFIX_FLOW && canonical(flow) === want ? "on" : "other";
  } catch {
    return "other";
  }
}

/** Branch names the exception may name: plain names, no glob characters, no spaces or shell syntax. */
const PUSH_ALLOW_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** FACTORY_PUSH_ALLOW for a step: set only for push_main of the unchanged shipped flow (top level). */
export function pushAllowEnv(step: Pick<Step, "id">, depth: number, vars: Record<string, string>, state: "on" | "off" | "other"): Record<string, string> {
  const branch = vars.main_branch ?? "";
  if (step.id !== HOTFIX_PUSH_STEP || depth !== 0 || state !== "on" || !PUSH_ALLOW_OK.test(branch)) return {};
  return { FACTORY_PUSH_ALLOW: branch };
}

/**
 * Let one step push `branch` past the hook: writes a one-time token the hook checks and returns the
 * FACTORY_PUSH_ALLOW value for that step. Call revoke() when the step ends.
 */
export function grantPush(branch: string): { env: Record<string, string>; revoke: () => void } {
  const dir = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "hooks", "allow");
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const file = join(dir, token);
  writeFileSync(file, branch, { mode: 0o600 });
  return { env: { FACTORY_PUSH_ALLOW: `${branch}:${token}` }, revoke: () => rmSync(file, { force: true }) };
}

// ── The running Foundry's own build ──

const selfCache = new Map<string, { sha: string; repo: string } | undefined>();

/**
 * The commit a checkout was at when first asked (once per process) and its GitHub repository as
 * "owner/name" in lower case. Undefined for a folder that is not a git checkout with a GitHub origin.
 */
export function selfBuild(dir = process.env.FACTORY_SELF_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")): { sha: string; repo: string } | undefined {
  if (selfCache.has(dir)) return selfCache.get(dir);
  let found: { sha: string; repo: string } | undefined;
  try {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const sha = git("rev-parse", "HEAD");
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(git("remote", "get-url", "origin"));
    if (/^[0-9a-f]{40}$/.test(sha) && m) found = { sha, repo: `${m[1]}/${m[2]}`.toLowerCase() };
  } catch {
    // not a git checkout, or no origin
  }
  selfCache.set(dir, found);
  return found;
}

/** FACTORY_SELF_SHA and FACTORY_SELF_REPO for steps ("" when unknown). */
export function selfEnv(): Record<string, string> {
  const b = selfBuild();
  return { FACTORY_SELF_SHA: b?.sha ?? "", FACTORY_SELF_REPO: b?.repo ?? "" };
}

// ── GitHub App installation tokens ──

let appToken: { token: string; expires: number; key: string } | undefined;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function appJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

async function installationToken(app: NonNullable<Config["github_app"]>): Promise<string> {
  const key = `${app.app_id}/${app.installation_id}`;
  if (appToken && appToken.key === key && appToken.expires - Date.now() > 5 * 60_000) return appToken.token;
  const jwt = appJwt(app.app_id, readFileSync(app.private_key_path, "utf8"));
  const res = await fetch(`https://api.github.com/app/installations/${app.installation_id}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "claude-factory" },
  });
  if (!res.ok) throw new Error(`GitHub App token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  appToken = { token: body.token, expires: new Date(body.expires_at).getTime(), key };
  return body.token;
}

/** Env for acting as the bot: git author/committer and the token gh (and git via gh) uses. */
export async function identityEnv(config: Config): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const { name, email, gh_token_env } = config.bot;
  if (name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
  if (email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email;
  if (config.github_app) env.GH_TOKEN = await installationToken(config.github_app);
  else if (gh_token_env) {
    const t = process.env[gh_token_env];
    if (!t) throw new Error(`bot.gh_token_env is "${gh_token_env}" but that env var is not set`);
    env.GH_TOKEN = t;
  }
  return env;
}

// ── Docker sandbox for shell steps ──

/** Wrap a shell command so it runs in a container with only the workspace mounted. */
export const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tools");

export function dockerCommand(image: string, workdir: string, command: string, envNames: string[]): { cmd: string; args: string[] } {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const args = [
    "run", "--rm", "-i",
    "--user", `${uid}:${gid}`,
    "-v", `${workdir}:/work`,
    "-v", `${TOOLS_DIR}:/factory-tools:ro`,
    "-w", "/work",
    "-e", "HOME=/tmp",
    "-e", "FACTORY_TOOLS=/factory-tools",
    "-e", "SCF_TOOLS=/factory-tools",
    ...envNames.filter((n) => n !== "FACTORY_TOOLS" && n !== "SCF_TOOLS").flatMap((n) => ["-e", n]), // values come from our env, not the command line
    image, "sh", "-c", command,
  ];
  return { cmd: "docker", args };
}
