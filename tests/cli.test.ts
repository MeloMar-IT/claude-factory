import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WatcherSchema } from "../src/config.js";
import { flowDir } from "../src/flow/load.js";
import { BOT_MARKER } from "../src/github.js";
import { STATUS_LABELS } from "../src/queue/watcher.js";

const NOTICE = 'note: "factory" is now "scf" (Spaghetti Code Foundry); "factory" keeps working as an alias.';
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function run(file: string, args: string[], env: Record<string, string> = {}) {
  if (!existsSync(file)) throw new Error(`${file} is missing — run \`npm run build\` first`);
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("scf command", () => {
  it("maps both commands in package.json and the lock file", () => {
    const pkg = readJson("package.json");
    expect(pkg.name).toBe("spaghetti-code-foundry");
    expect(pkg.bin).toEqual({ scf: "dist/cli.js", factory: "dist/factory.js" });
    expect(pkg.scripts.build).toContain("chmod +x dist/cli.js dist/factory.js");
    const lock = readJson("package-lock.json");
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""].name).toBe(pkg.name);
    expect(lock.packages[""].bin).toEqual(pkg.bin);
  });

  it("factory prints the notice once; scf prints none", () => {
    const f = run(resolve("dist/factory.js"), ["--help"]);
    expect(f.status).toBe(0);
    expect(f.stderr.split(NOTICE).length - 1).toBe(1);
    expect(f.stdout.startsWith("Spaghetti Code Foundry (scf) — run custom flows")).toBe(true);
    expect(f.stdout).toContain("scf run");
    expect(f.stdout).toContain('"factory" still works');
    const s = run(resolve("dist/cli.js"), ["--help"]);
    expect(s.stdout.startsWith("Spaghetti Code Foundry (scf) — run custom flows")).toBe(true);
    expect(s.stderr).not.toContain("note:");
    expect(s.stdout).not.toMatch(/^\s*factory /m);
  });

  it("SCF_HOME wins over FACTORY_HOME", () => {
    const a = mkdtempSync(join(tmpdir(), "scf-a-"));
    const b = mkdtempSync(join(tmpdir(), "scf-b-"));
    mkdirSync(join(a, "flows"));
    writeFileSync(join(a, "flows", "mine.yaml"), "name: mine\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    const r = run(resolve("dist/cli.js"), ["flows"], { SCF_HOME: a, FACTORY_HOME: b });
    expect(r.stdout).toContain("mine");
    expect(r.stdout).toContain(a);
  });

  it("usage errors show a valid command", () => {
    const cli = resolve("dist/cli.js");
    expect(run(cli, ["run"]).stderr).toContain('usage: scf run <flow> --task "..."');
    expect(run(cli, ["new"]).stderr).toContain("usage: scf new <name> (letters");
    expect(run(cli, ["eval"]).stderr).toContain("usage: scf eval <suite.yaml> [--flows");
    expect(run(cli, ["validate"]).stderr).toContain("usage: scf validate <flow>");
  });

  it("UI hints are exact commands", () => {
    expect(readFileSync("ui/dashboard.js", "utf8")).toContain('"scf eval evals/example.yaml"');
  });

  it("UI hints say scf", () => {
    const bad = /(?<![\w-])factory (run|resume|approve|reject|eval|clean|service|serve|ui|new|validate|flows|blocks|flow-guide|watch)\b/;
    for (const f of walk("ui").filter((p) => /\.(js|html)$/.test(p))) expect(readFileSync(f, "utf8"), f).not.toMatch(bad);
  });
});

describe("names that stay", () => {
  it("keeps the marker, labels and folders", () => {
    expect(BOT_MARKER).toBe("<!-- claude-factory");
    expect(Object.values(STATUS_LABELS).map((l) => l.name)).toEqual([
      "factory:working",
      "factory:done",
      "factory:needs-info",
      "factory:waiting-approval",
      "factory:failed",
    ]);
    expect(WatcherSchema.parse({ id: "w", github_repo: "o/r" }).label).toBe("claude-factory");
    expect(flowDir("repo", "/r")).toBe("/r/.claude-factory/flows");
    for (const l of Object.values(STATUS_LABELS)) {
      expect(l.description.startsWith("Spaghetti Code Foundry ")).toBe(true);
      expect(l.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("docs use the new name", () => {
    const read = (f: string) => readFileSync(f, "utf8");
    const [readme, guide, authoring] = [read("README.md"), read("docs/USER_GUIDE.md"), read("docs/FLOW_AUTHORING.md")];
    expect(readme.startsWith("# Spaghetti Code Foundry\n")).toBe(true);
    expect(guide.startsWith("# Spaghetti Code Foundry user guide\n")).toBe(true);
    expect(authoring.startsWith("# Writing Spaghetti Code Foundry flows")).toBe(true);
    expect(readme).toContain("Formerly **claude-factory**");
    expect(guide).toContain("Formerly **claude-factory**");
    for (const d of [readme, guide, authoring]) expect(d).not.toMatch(/\b[Tt]he\s+factory\b/);
    expect(readme).toContain("git clone https://github.com/MeloMar-IT/spaghetti-code-foundry.git\ncd spaghetti-code-foundry\n");
    expect(guide).toContain("`~/.claude-factory/config.yaml`");
    expect(guide).toContain("`factory:working`");
  });

  it("the feature flow header uses the product name", () => {
    const text = readFileSync("flows/feature.yaml", "utf8");
    expect(text.split("\n")[0]).toContain("Spaghetti Code Foundry flow");
    expect(text).toContain("factory new my-flow");
  });

  it("built-in flows and tools keep FACTORY_ names", () => {
    // tools/area-lock also reads SCF_HOME and SCF_LOCK_DIR (it picks the data folder itself)
    for (const f of [...walk("flows"), ...walk("tools")]) {
      expect(readFileSync(f, "utf8").replace(/SCF_(HOME|LOCK_DIR)/g, ""), f).not.toContain("SCF_");
    }
  });
});

describe("repository links", () => {
  const REPO = "https://github.com/MeloMar-IT/spaghetti-code-foundry";
  const read = (f: string) => readFileSync(f, "utf8");

  it("package.json points to the new repository", () => {
    const pkg = readJson("package.json");
    expect(pkg.repository).toEqual({ type: "git", url: "git+" + REPO + ".git" });
    expect(pkg.homepage).toBe(REPO + "#readme");
    expect(pkg.bugs).toEqual({ url: REPO + "/issues" });
  });

  it("no link to the old repository is left", () => {
    const files = ["README.md", "CLAUDE.md", "package.json", ...walk("docs").filter((p) => p.endsWith(".md"))];
    for (const f of files) expect(read(f), f).not.toMatch(/github\.com[/:]MeloMar-IT\/claude-factory/i);
    expect(read("README.md")).toContain(`](${REPO})`);
  });

  it("README and guide tell existing clones to update the remote", () => {
    const [readme, guide] = [read("README.md"), read("docs/USER_GUIDE.md")];
    expect(readme).toContain(`git remote set-url origin ${REPO}.git`);
    expect(readme).toContain("git remote set-url origin git@github.com:MeloMar-IT/spaghetti-code-foundry.git");
    expect(guide).toContain(`git remote set-url origin ${REPO}.git`);
    for (const text of [readme, guide]) {
      expect(text).not.toMatch(/repository keep the old name/);
      const formerly = text.split("\n").find((l) => l.startsWith("Formerly **claude-factory**"));
      expect(formerly).toContain("`~/.spaghetti-code-foundry`");
    }
  });
});

describe("data folder", () => {
  const cli = resolve("dist/cli.js");
  const lockTool = resolve("tools/area-lock");
  const FLOW = "name: mine\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n";
  /** Runs a command with HOME set to `home` and no home or lock variables from the test setup. */
  const clean = (file: string, args: string[], home: string, extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(FACTORY_|SCF_)/.test(k)) env[k] = v;
    return spawnSync(file, args, { encoding: "utf8", env: { ...env, HOME: home, ...extra } });
  };
  const scf = (args: string[], home: string, extra: Record<string, string> = {}) => clean(process.execPath, [cli, ...args], home, extra);
  const withHome = () => {
    const home = mkdtempSync(join(tmpdir(), "scf-home-"));
    return { home, oldDir: join(home, ".claude-factory"), newDir: join(home, ".spaghetti-code-foundry") };
  };
  const seedOld = (oldDir: string) => {
    mkdirSync(join(oldDir, "flows"), { recursive: true });
    writeFileSync(join(oldDir, "flows", "mine.yaml"), FLOW);
  };

  it("scf run writes who started the run", () => {
    const { home, oldDir } = withHome();
    seedOld(oldDir);
    const repo = join(home, "repo");
    mkdirSync(repo);
    const runs = join(home, "runs");
    const r = scf(["run", "mine", "--repo", repo, "--runs-dir", runs], home);
    expect(r.status).toBe(0);
    const [id] = readdirSync(runs);
    expect(readJson(join(runs, id!, "run.json")).source).toBe("cli");
  });

  it("scf flows moves ~/.claude-factory to ~/.spaghetti-code-foundry and keeps the backup", () => {
    const { home, oldDir, newDir } = withHome();
    seedOld(oldDir);
    const r = scf(["flows"], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mine");
    expect(r.stdout).toContain(newDir);
    expect(existsSync(join(newDir, "flows", "mine.yaml"))).toBe(true);
    expect(existsSync(join(oldDir, "flows", "mine.yaml"))).toBe(true);
    expect(existsSync(join(oldDir, "MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt"))).toBe(true);
    expect(r.stderr).toContain("note: moved the data folder");
  });

  it("refuses to run when the note exists but the new folder is missing; help still works", () => {
    const { home, oldDir } = withHome();
    seedOld(oldDir);
    writeFileSync(join(oldDir, "MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt"), "moved");
    const r = scf(["flows"], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SCF_HOME");
    expect(existsSync(join(home, ".spaghetti-code-foundry"))).toBe(false);
    expect(scf(["--help"], home).status).toBe(0);
  });

  it("--help shows the old folder while only that exists, and does not move it", () => {
    const { home, oldDir, newDir } = withHome();
    seedOld(oldDir);
    const r = scf(["--help"], home);
    expect(r.stdout).toContain(join(oldDir, "runs"));
    expect(existsSync(newDir)).toBe(false);
  });

  it("an empty SCF_HOME does not hide FACTORY_HOME", () => {
    const { home } = withHome();
    const a = mkdtempSync(join(tmpdir(), "scf-a-"));
    mkdirSync(join(a, "flows"));
    writeFileSync(join(a, "flows", "mine.yaml"), FLOW);
    const r = scf(["flows"], home, { SCF_HOME: "", FACTORY_HOME: a });
    expect(r.stdout).toContain(a);
    expect(readdirSync(home)).toEqual([]);
  });

  it("tools/area-lock picks the same default folder", () => {
    const only = withHome();
    seedOld(only.oldDir);
    expect(clean(lockTool, ["list"], only.home).status).toBe(0);
    expect(existsSync(join(only.oldDir, "locks", "local"))).toBe(true);
    expect(existsSync(only.newDir)).toBe(false);

    const both = withHome();
    seedOld(both.oldDir);
    mkdirSync(both.newDir);
    clean(lockTool, ["list"], both.home);
    expect(existsSync(join(both.newDir, "locks", "local"))).toBe(true);
    expect(existsSync(join(both.oldDir, "locks"))).toBe(false);

    const neither = withHome();
    clean(lockTool, ["list"], neither.home);
    expect(existsSync(join(neither.newDir, "locks", "local"))).toBe(true);

    const moved = withHome();
    seedOld(moved.oldDir);
    writeFileSync(join(moved.oldDir, "MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt"), "moved");
    const r = clean(lockTool, ["list"], moved.home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SCF_HOME");
    expect(existsSync(join(moved.oldDir, "locks"))).toBe(false);
    expect(existsSync(moved.newDir)).toBe(false);
  });
});
