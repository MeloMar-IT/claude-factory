import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { grantPush, hotfixState, protectedBranchEnv, pushAllowEnv, selfBuild } from "../src/engine/guards.js";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";

// The one exception to the protection of main: push_main of the unchanged built-in issue-gitflow.
const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const shipped = (): Flow => parseFlow(readFileSync("flows/issue-gitflow.yaml", "utf8"), "flows/issue-gitflow.yaml");
const on = { hotfix_to_main: true };
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-hotfix-"));
});
afterEach(() => {
  delete process.env.FACTORY_PUSH_ALLOW;
  rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quiet = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

describe("the pre-push hook", () => {
  let repo: string;
  beforeEach(() => {
    repo = join(tmp, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const remote = join(tmp, "remote.git");
    git(tmp, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
  });
  // allow: "granted" = a token the engine wrote for main; anything else is set by the step itself.
  const pushWith = (spec: string, allow?: string) => {
    const grant = allow === "granted" ? grantPush("main") : undefined;
    try {
      return spawnSync("git", ["push", "-q", "origin", spec], {
        cwd: repo, encoding: "utf8",
        env: { ...process.env, ...protectedBranchEnv(["main", "release/*"]), ...(grant ? grant.env : allow ? { FACTORY_PUSH_ALLOW: allow } : {}) },
      });
    } finally {
      grant?.revoke();
    }
  };

  it("blocks main without the exception, and lets exactly that branch through with it", () => {
    expect(pushWith("HEAD:main").status).not.toBe(0);
    expect(pushWith("HEAD:main").stderr).toContain("protected branch 'main' is blocked");
    expect(pushWith("HEAD:main", "granted").status).toBe(0);
    expect(git(tmp + "/remote.git", "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("keeps other protected branches and deleting main blocked", () => {
    expect(pushWith("HEAD:release/1", "granted").status).not.toBe(0);
    expect(pushWith("HEAD:main", "granted").status).toBe(0);
    const del = pushWith(":main", "granted");
    expect(del.status).not.toBe(0);
    expect(del.stderr).toContain("blocked");
    expect(git(tmp + "/remote.git", "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("gives nothing to a step that sets FACTORY_PUSH_ALLOW itself, or uses a token after the step ended", () => {
    for (const forged of ["main", "main:", "main:deadbeef", "main:../../x", "*:00"]) {
      expect(pushWith("HEAD:main", forged).status, forged).not.toBe(0);
    }
    const grant = grantPush("main");
    grant.revoke();
    const late = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], {
      cwd: repo, encoding: "utf8", env: { ...process.env, ...protectedBranchEnv(["main"]), ...grant.env },
    });
    expect(late.status).not.toBe(0);
    expect(quiet(tmp + "/remote.git", "rev-parse", "--verify", "main").status).not.toBe(0);
  });
});

describe("hotfixState", () => {
  const cfg = ConfigSchema.parse(on);
  it("is on for the shipped flow, after a JSON round-trip, and for an identical copy", () => {
    expect(hotfixState(shipped(), cfg)).toBe("on");
    expect(hotfixState(JSON.parse(JSON.stringify(shipped())) as Flow, cfg)).toBe("on");
    const dir = join(tmp, "flows");
    mkdirSync(dir);
    writeFileSync(join(dir, "issue-gitflow.yaml"), readFileSync("flows/issue-gitflow.yaml", "utf8"));
    expect(hotfixState(parseFlow(readFileSync(join(dir, "issue-gitflow.yaml"), "utf8")), cfg)).toBe("on");
  });

  it("is off when the setting is off", () => {
    expect(hotfixState(shipped(), ConfigSchema.parse({}))).toBe("off");
  });

  it.each([
    ["a changed step", (f: Flow) => { (f.steps.find((s) => s.id === "push_main") as { run: string }).run += "\necho more"; }],
    ["another name", (f: Flow) => { f.name = "issue-gitflow-2"; }],
    ["one var default", (f: Flow) => { f.vars.main_branch = "master"; }],
    ["the defaults", (f: Flow) => { f.defaults.timeout_sec = 1; }],
    ["the limits", (f: Flow) => { f.limits.max_cost_usd = 1; }],
    ["the sandbox", (f: Flow) => { f.sandbox = { docker_image: "node:22" } as Flow["sandbox"]; }],
    ["publishing", (f: Flow) => { f.publish = { enabled: true, vars: {} } as Flow["publish"]; }],
  ])("is other for %s", (_name, change) => {
    const f = shipped();
    change(f);
    expect(hotfixState(f, cfg)).toBe("other");
  });
});

describe("pushAllowEnv", () => {
  const vars = { main_branch: "main" };
  it("is set only for push_main at the top level of the shipped flow with the setting on", () => {
    expect(pushAllowEnv({ id: "push_main" }, 0, vars, "on")).toEqual({ FACTORY_PUSH_ALLOW: "main" });
    expect(pushAllowEnv({ id: "push_main" }, 0, { main_branch: "trunk" }, "on")).toEqual({ FACTORY_PUSH_ALLOW: "trunk" });
    expect(pushAllowEnv({ id: "push_feature" }, 0, vars, "on")).toEqual({});
    expect(pushAllowEnv({ id: "push_main" }, 1, vars, "on")).toEqual({});
    expect(pushAllowEnv({ id: "push_main" }, 0, vars, "off")).toEqual({});
    expect(pushAllowEnv({ id: "push_main" }, 0, vars, "other")).toEqual({});
  });

  it.each(["main;x", "*", "", "a b", "$(x)", "-f"])("refuses the branch name %j", (name) => {
    expect(pushAllowEnv({ id: "push_main" }, 0, { main_branch: name }, "on")).toEqual({});
  });
});

describe("a flow cannot give itself the exception", () => {
  const flowYaml = (name: string, id: string) => `
name: ${name}
workspace: empty
vars: { remote: "", main_branch: main }
steps:
  - id: ${id}
    type: shell
    run: |
      git init -q -b main . && git config user.email t@t && git config user.name t
      git commit -q --allow-empty -m x
      git init -q --bare "{{vars.remote}}" && git remote add origin "{{vars.remote}}"
      echo "hotfix=$FACTORY_HOTFIX allow=[$FACTORY_PUSH_ALLOW]"
      git push origin HEAD:main
`;
  const go = (name: string, id: string) => {
    const remote = join(tmp, `remote-${name}-${id}.git`);
    return runFlow(parseFlow(flowYaml(name, id)), {
      task: "t", repo: tmp, runsDir: join(tmp, "runs"), claudeBin, vars: { remote },
      config: ConfigSchema.parse({ protected_branches: ["main"], ...on }),
    }).then((r) => ({ r, remote }));
  };

  it("an issue-gitflow with its own push_main step gets no exception", async () => {
    const { r, remote } = await go("issue-gitflow", "push_main");
    expect(r.status).toBe("failed");
    const output = r.history[0]!.output;
    expect(output).toContain("hotfix=other allow=[]");
    expect(output).toContain("protected branch 'main' is blocked");
    expect(quiet(remote, "rev-parse", "--verify", "main").status).not.toBe(0);
  });

  it("FACTORY_PUSH_ALLOW in the server's own environment unblocks nothing", async () => {
    process.env.FACTORY_PUSH_ALLOW = "main";
    for (const [name, id] of [["issue-gitflow", "push_main"], ["other-flow", "push_main"], ["issue-gitflow", "push_feature"]]) {
      const { r, remote } = await go(name!, id!);
      expect(r.status).toBe("failed");
      expect(r.history[0]!.output).toContain("allow=[]");
      expect(quiet(remote, "rev-parse", "--verify", "main").status).not.toBe(0);
    }
  });
});

describe("selfBuild", () => {
  const clone = (origin: string) => {
    const dir = mkdtempSync(join(tmp, "self-"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    git(dir, "remote", "add", "origin", origin);
    return dir;
  };

  it("gives the commit and owner/name of a clone with a GitHub origin (https and ssh)", () => {
    for (const origin of ["https://github.com/Acme/App.git", "git@github.com:Acme/App.git", "https://github.com/Acme/App"]) {
      const dir = clone(origin);
      expect(selfBuild(dir)).toEqual({ sha: git(dir, "rev-parse", "HEAD"), repo: "acme/app" });
    }
  });

  it("is undefined without git or with another origin", () => {
    expect(selfBuild(mkdtempSync(join(tmp, "plain-")))).toBeUndefined();
    expect(selfBuild(clone("https://example.com/acme/app.git"))).toBeUndefined();
  });

  it("keeps the commit it saw first when HEAD moves", () => {
    const dir = clone("https://github.com/acme/app.git");
    const before = selfBuild(dir);
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
    expect(selfBuild(dir)).toEqual(before);
    expect(before!.sha).not.toBe(git(dir, "rev-parse", "HEAD"));
  });
});
