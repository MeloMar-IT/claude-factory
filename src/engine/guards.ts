import { createSign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { FACTORY_HOME } from "../flow/load.js";

const PRE_PUSH = `#!/bin/sh
# Installed by claude-factory: refuse pushes to protected branches.
while read local_ref local_sha remote_ref remote_sha; do
  branch=\${remote_ref#refs/heads/}
  set -f
  for pattern in $FACTORY_PROTECTED_BRANCHES; do
    case "$branch" in
      $pattern) echo "claude-factory: pushing to protected branch '$branch' is blocked" >&2; exit 1 ;;
    esac
  done
  set +f
done
exit 0
`;

/**
 * Env that makes every git command in the run use our pre-push hook, which refuses
 * pushes to protected branches. (GIT_CONFIG_* applies to all git processes, including
 * the ones Claude starts.) Note: this replaces the repo's own git hooks during runs.
 */
export function protectedBranchEnv(patterns: string[]): Record<string, string> {
  if (!patterns.length) return {};
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
  };
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
export function dockerCommand(image: string, workdir: string, command: string, envNames: string[]): { cmd: string; args: string[] } {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const args = [
    "run", "--rm", "-i",
    "--user", `${uid}:${gid}`,
    "-v", `${workdir}:/work`,
    "-w", "/work",
    "-e", "HOME=/tmp",
    ...envNames.flatMap((n) => ["-e", n]), // values come from our env, not the command line
    image, "sh", "-c", command,
  ];
  return { cmd: "docker", args };
}
