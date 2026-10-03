import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { protectedBranchEnv } from "../src/engine/guards.js";

const SCAN = resolve("tools/secret-scan");
// Built at runtime so this file itself never contains a key-shaped string.
const GH_TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

let tmp: string;
let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
const commit = (file: string, text: string) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `add ${file}`);
};
const scan = (...args: string[]) => spawnSync(SCAN, args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-secrets-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  commit("README.md", "hello\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("secret-scan", () => {
  it("passes clean commits and ignores placeholders", () => {
    commit("src/a.js", 'const password = "changeme-please-123";\nconst apiKey = process.env.API_KEY;\nconst token = "{{vars.token}}";\n');
    const r = scan("HEAD~1..HEAD");
    expect(r.stdout).toContain("no secrets found");
    expect(r.status).toBe(0);
  });

  it("finds tokens, keys and sensitive files, masked, with file and line", () => {
    commit("src/cfg.js", `// config\nexport const gh = "${GH_TOKEN}";\nexport const aws = "${AWS_KEY}";\n`);
    commit(".env", "X=1\n");
    const r = scan("HEAD~2..HEAD");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/cfg.js:2  GitHub token  ghp_…");
    expect(r.stderr).toContain("src/cfg.js:3  AWS access key");
    expect(r.stderr).toContain(".env  sensitive file");
    expect(r.stderr).not.toContain(GH_TOKEN);
  });

  it("flags a private key only when key data follows the header", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" + "x".repeat(20);
    commit("src/gen.java", 'write("-----BEGIN PRIVATE KEY-----\\n" + encode(generated.getPrivate()) + "\\n-----END PRIVATE KEY-----\\n");\n');
    expect(scan().status).toBe(0);
    commit("config/key.txt", `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`);
    const r = scan();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("config/key.txt:1  private key");
  });

  it("honours inline and file allow-lists", () => {
    commit("test/fixture.js", `const t = "${GH_TOKEN}"; // factory:allow-secret\n`);
    expect(scan("HEAD~1..HEAD").status).toBe(0);
    commit("docs/example.md", `aws: ${AWS_KEY}\n`);
    expect(scan("HEAD~1..HEAD").status).toBe(1);
    commit(".claude-factory/secret-allow", "^docs/example\\.md:\n");
    expect(scan("HEAD~2..HEAD").status).toBe(0);
  });

  it("--text replaces secrets in text from stdin, keeps the rest and needs no git repository", () => {
    const pem = ["-----BEGIN RSA " + "PRIVATE KEY-----", "A".repeat(64), "-----END RSA " + "PRIVATE KEY-----"].join("\n");
    const input = `token ${GH_TOKEN} and ${AWS_KEY} fine words\n${pem}\nafter`;
    const r = spawnSync(SCAN, ["--text"], { cwd: tmp, input, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(GH_TOKEN);
    expect(r.stdout).not.toContain(AWS_KEY);
    expect(r.stdout).not.toContain("AAAAAAAA");
    expect(r.stdout).toContain("fine words");
    expect(r.stdout).toContain("after");
  });

  it("blocks a push through the pre-push hook", () => {
    const remote = join(tmp, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "-b", "factory/x");
    commit("src/leak.js", `export const k = "${GH_TOKEN}";\n`);
    const env = { ...process.env, ...protectedBranchEnv(["main"], true) };
    const r = spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repo, env, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("src/leak.js:1  GitHub token");
    // Fixing the commit lets the push through.
    git("reset", "-q", "--hard", "HEAD~1");
    commit("src/ok.js", "export const k = process.env.K;\n");
    const ok = spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repo, env, encoding: "utf8" });
    expect(ok.status).toBe(0);
  });
});
