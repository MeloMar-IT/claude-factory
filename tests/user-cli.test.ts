import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { adminHint, terminalIo, userCommand, type UserIo } from "../src/auth/cli.js";
import { readSessions } from "../src/auth/sessions.js";
import { listUsers, startSession, verifyPassword } from "../src/auth/users.js";

const CLI = resolve("dist/cli.js");
const PW = "test-password-12345";
const PW2 = "test-other-password-678";
let tmp: string;
let home: string;
const mode = (p: string) => statSync(p).mode & 0o777;
const usersFile = () => join(home, "users.json");
const stored = () => JSON.parse(readFileSync(usersFile(), "utf8")) as { users: { email: string; status: string; passwordHash: string }[] };
const outputs: string[] = [];

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`npm run build\` first`);
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "user-cli-"));
  home = join(tmp, "missing", "home");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const cleanEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_HOME: home };
  delete env.FACTORY_HOME;
  return env;
};
function run(args: string[], input: string, env: NodeJS.ProcessEnv = cleanEnv()) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, env, encoding: "utf8" });
  outputs.push(r.stdout, r.stderr);
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const create = (email = "ann@example.com", extra: string[] = ["--admin"], password = PW) =>
  run(["user", "create", ...extra, "--name", "Ann", "--email", email], password + "\n");
const runAsync = (args: string[], input: string, env: NodeJS.ProcessEnv = cleanEnv()) =>
  new Promise<number | null>((done) => {
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    c.stdout.resume();
    c.stderr.resume();
    c.stdin.end(input);
    c.on("close", done);
  });

describe("scf user (child process)", () => {
  it("creates the first admin on a fresh install", () => {
    const r = create();
    expect(r.code).toBe(0);
    expect(r.out).toContain("created admin ann@example.com");
    expect(mode(home)).toBe(0o700);
    expect(mode(usersFile())).toBe(0o600);
  });

  it("keeps the modes under umask 000", () => {
    const r = spawnSync("sh", ["-c", 'umask 000; exec "$@"', "sh", process.execPath, CLI, "user", "create", "--name", "Ann", "--email", "ann@example.com"], {
      input: PW + "\n", env: cleanEnv(), encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(mode(home)).toBe(0o700);
    expect(mode(usersFile())).toBe(0o600);
  });

  it("fails on a duplicate, a short password, no password and a missing option", () => {
    expect(create().code).toBe(0);
    const before = readFileSync(usersFile());
    expect(create("ANN@example.com", []).code).toBe(1);
    expect(create("b@example.com", [], "short").code).toBe(1);
    expect(run(["user", "create", "--name", "B", "--email", "b@example.com"], "").code).toBe(1);
    expect(run(["user", "create", "--name", "B"], PW + "\n").code).toBe(1);
    expect(readFileSync(usersFile())).toEqual(before);
  });

  it("has no password option", () => {
    expect(run(["user", "create", `--password=${PW}`, "--name", "A", "--email", "a@example.com"], "").code).toBe(1);
  });

  it("checks the syntax before it does anything", () => {
    create();
    const before = readFileSync(usersFile());
    const bad = [
      ["block", "a@example.com", "b@example.com"],
      ["block", "ann@example.com", "--admin"],
      ["unblock", "ann@example.com", "--name", "x"],
      ["password", "ann@example.com", "--email", "x@example.com"],
      ["list", "extra"],
      ["list", "--admin"],
      ["create", "extra", "--name", "x", "--email", "x@example.com"],
      ["block", "ann@example.com", "--repo", "."],
      ["block"],
      ["role"],
      ["role", "ann@example.com"],
      ["role", "ann@example.com", "root"],
      ["role", "ann@example.com", "Admin"],
      ["role", "ann@example.com", "admin", "x"],
      ["role", "ann@example.com", "admin", "--admin"],
    ];
    for (const a of bad) {
      const r = run(["user", ...a], PW + "\n");
      expect(r.code, a.join(" ")).toBe(1);
      expect(r.err).toContain("usage: scf user create");
    }
    expect(readFileSync(usersFile())).toEqual(before);
  });

  it("lists accounts without a hash", () => {
    create();
    const r = run(["user", "list"], "");
    expect(r.code).toBe(0);
    for (const w of ["ann@example.com", "Ann", "admin", "active"]) expect(r.out).toContain(w);
  });

  it("changes a password", async () => {
    create();
    const old = stored().users[0]!.passwordHash;
    expect(run(["user", "password", "ANN@example.com"], PW2 + "\n").code).toBe(0);
    const now = stored().users[0]!.passwordHash;
    expect(now).not.toBe(old);
    expect(await verifyPassword(PW2, now)).toBe(true);
    expect(run(["user", "password", "nobody@example.com"], PW2 + "\n").code).toBe(1);
  });

  it("blocks and unblocks", () => {
    create();
    create("bob@example.com", []);
    expect(run(["user", "block", "bob@example.com"], "").code).toBe(0);
    expect(stored().users[1]!.status).toBe("blocked");
    expect(run(["user", "unblock", "bob@example.com"], "").code).toBe(0);
    expect(stored().users[1]!.status).toBe("active");
    expect(run(["user", "block", "nobody@example.com"], "").code).toBe(1);
    expect(run(["user", "unblock", "nobody@example.com"], "").code).toBe(1);
  });

  const auditFile = () => join(home, "audit.jsonl");
  const auditLines = () =>
    existsSync(auditFile())
      ? readFileSync(auditFile(), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  it("`role` changes the role and protects the last admin", () => {
    create();
    create("bob@example.com", []);
    const r = run(["user", "role", "BOB@example.com", "admin"], "");
    expect(r.code).toBe(0);
    expect(r.out).toContain("bob@example.com is now admin");
    expect(stored().users[1]).toMatchObject({ role: "admin" });
    expect(run(["user", "role", "ann@example.com", "user"], "").code).toBe(0);
    const before = readFileSync(usersFile());
    const last = run(["user", "role", "bob@example.com", "user"], "");
    expect(last.code).toBe(1);
    expect(last.err).toContain("make another admin first");
    expect(readFileSync(usersFile())).toEqual(before);
  });

  it("`role` with the same role or an unknown e-mail", () => {
    create();
    const lines = auditLines().length;
    const before = readFileSync(usersFile());
    const r = run(["user", "role", "ann@example.com", "admin"], "");
    expect(r.code).toBe(0);
    expect(r.out).toContain("is now");
    expect(readFileSync(usersFile())).toEqual(before);
    expect(auditLines()).toHaveLength(lines);
    expect(run(["user", "role", "nobody@example.com", "admin"], "").code).toBe(1);
  });

  it("`block` and `delete` refuse the only admin", () => {
    create();
    const users = readFileSync(usersFile());
    const audit = readFileSync(auditFile());
    for (const sub of ["block", "delete"]) {
      const r = run(["user", sub, "ann@example.com"], "");
      expect(r.code, sub).toBe(1);
      expect(r.err).toContain("make another admin first");
    }
    expect(readFileSync(usersFile())).toEqual(users);
    expect(readFileSync(auditFile())).toEqual(audit);
  });

  it("an unwritable audit log stops the command", () => {
    create();
    create("bob@example.com", []);
    rmSync(auditFile());
    mkdirSync(auditFile());
    const r = run(["user", "block", "bob@example.com"], "");
    expect(r.code).toBe(1);
    expect(r.err).toContain("audit.jsonl");
    expect(stored().users[1]!.status).toBe("active");
  });

  it("`list` shows the last sign-in", () => {
    create();
    expect(run(["user", "list"], "").out).toContain("last sign-in: never");
    const process_ = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    try {
      const u = listUsers()[0]!;
      startSession(u.id, u.passwordHash);
    } finally {
      if (process_ === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = process_;
    }
    expect(run(["user", "list"], "").out).toMatch(/last sign-in: \d{4}-\d\d-\d\dT/);
  });

  it("writes one audit line per action and no personal data", () => {
    create();
    expect(run(["user", "create", "--name", "Zebulon Quux", "--email", "zeb@example.com"], PW2 + "\n").code).toBe(0);
    const id = (stored().users as unknown as { id: string; email: string }[]).find((u) => u.email === "zeb@example.com")!.id;
    expect(run(["user", "password", "zeb@example.com"], "another-password-999\n").code).toBe(0);
    expect(run(["user", "role", "zeb@example.com", "admin"], "").code).toBe(0);
    expect(run(["user", "block", "zeb@example.com"], "").code).toBe(0);
    expect(run(["user", "unblock", "zeb@example.com"], "").code).toBe(0);
    expect(run(["user", "delete", "zeb@example.com"], "").code).toBe(0);
    const lines = auditLines().slice(1);
    expect(mode(auditFile())).toBe(0o600);
    expect(lines.map((l) => l.action)).toEqual(["create", "password", "role", "block", "unblock", "delete"]);
    for (const l of lines) {
      expect(l.by).toBe("cli");
      expect(l.userId).toBe(id);
      expect(Object.keys(l)).toHaveLength(l.action === "role" ? 6 : 4);
    }
    expect(lines[2]).toMatchObject({ oldRole: "user", newRole: "admin" });
    const text = readFileSync(auditFile(), "utf8");
    for (const w of [PW, PW2, "another-password-999", "scrypt$", "passwordHash", "Zebulon", "zeb@example.com"]) expect(text).not.toContain(w);
  });

  it("failed commands write no line", () => {
    create();
    const n = auditLines().length;
    expect(create("ANN@example.com", []).code).toBe(1);
    expect(create("b@example.com", [], "short").code).toBe(1);
    expect(run(["user", "create", "--name", "B", "--email", "b@example.com"], "").code).toBe(1);
    for (const sub of ["password", "block", "unblock", "delete"]) expect(run(["user", sub, "nobody@example.com"], PW2 + "\n").code).toBe(1);
    expect(run(["user", "role", "nobody@example.com", "user"], "").code).toBe(1);
    expect(auditLines()).toHaveLength(n);
  });

  it("two processes at the same time write four audit lines", async () => {
    const codes = await Promise.all(["a", "b", "c", "d"].map((n) => runAsync(["user", "create", "--name", n, "--email", `${n}@example.com`], PW + "\n")));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(auditLines()).toHaveLength(4);
  });

  it("the usage mentions `role`", () => {
    expect(run(["user"], "").err).toContain("scf user role");
    expect(run(["--help"], "").out).toContain("scf user role");
  });

  it("prints the usage", () => {
    for (const a of [["user"], ["user", "frobnicate"]]) {
      const r = run(a, "");
      expect(r.code).toBe(1);
      expect(r.err).toContain("usage: scf user create");
    }
    expect(run(["--help"], "").out).toContain("scf user create");
  });

  it("is not needed by other commands", () => {
    create();
    expect(run(["flows"], "").code).toBe(0);
  });

  it("two processes at the same time do not undo each other", async () => {
    const codes = await Promise.all(["a", "b", "c", "d"].map((n) => runAsync(["user", "create", "--name", n, "--email", `${n}@example.com`], PW + "\n")));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(run(["user", "list"], "").out.split("\n").filter((l) => l.includes("@example.com"))).toHaveLength(4);
  });

  it("takes over a dead lock", async () => {
    mkdirSync(join(home, "auth.lock"), { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(join(home, "auth.lock", "pid"), String(dead));
    const codes = await Promise.all(["a", "b", "c", "d"].map((n) => runAsync(["user", "create", "--name", n, "--email", `${n}@example.com`], PW + "\n")));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(stored().users).toHaveLength(4);
    expect(readdirSync(home).filter((n) => n.startsWith("auth.lock"))).toEqual([]);
  });

  it("a broken file is an error, not no accounts", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(usersFile(), "{");
    for (const r of [run(["user", "list"], ""), create()]) {
      expect(r.code).toBe(1);
      expect(r.err).toContain("is not valid JSON");
    }
    expect(readFileSync(usersFile(), "utf8")).toBe("{");
  });

  it("never prints a password or a hash", () => {
    create();
    run(["user", "list"], "");
    const key = stored().users[0]!.passwordHash.split("$")[3]!;
    for (const o of outputs) {
      expect(o).not.toContain("scrypt$");
      expect(o).not.toContain(key);
      expect(o).not.toContain(PW);
      expect(o).not.toContain(PW2);
    }
  });
});

describe("userCommand with a fake terminal", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = join(tmp, "h");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
  });
  const fake = (answers: string[], hidden: string[]) => {
    const calls: string[] = [];
    const lines: string[] = [];
    const io: UserIo = {
      isTTY: true,
      ask: async (p) => (calls.push(p), answers.shift()!),
      askHidden: async (p) => (calls.push(p), hidden.shift()!),
      readStdinLine: async () => (calls.push("stdin"), undefined),
      out: (l) => void lines.push(l),
    };
    return { io, calls, lines };
  };
  const list = () => userCommand({ positionals: ["list"], values: {} }, fake([], []).io);

  it("asks for name, e-mail and the password twice", async () => {
    const f = fake(["Ann", "ann@example.com"], [PW, PW]);
    expect(await userCommand({ positionals: ["create"], values: { admin: true } }, f.io)).toBe(0);
    expect(f.calls).toEqual(["Name: ", "E-mail: ", "Password: ", "Repeat password: "]);
    expect(f.lines).toEqual(["created admin ann@example.com"]);
    expect(f.lines.join("\n")).not.toContain(PW);
  });

  it("stops when the passwords differ", async () => {
    const f = fake([], [PW, PW2]);
    await expect(userCommand({ positionals: ["create"], values: { name: "Ann", email: "ann@example.com" } }, f.io)).rejects.toThrow("not the same");
    expect(existsSync(join(tmp, "h", "users.json"))).toBe(false);
  });

  it("rejects a short password before the second prompt", async () => {
    const f = fake([], ["short", "short"]);
    await expect(userCommand({ positionals: ["create"], values: { name: "Ann", email: "ann@example.com" } }, f.io)).rejects.toThrow("password");
    expect(f.calls).toEqual(["Password: "]);
  });

  it("does not take prototype names for sub-commands", async () => {
    const f = fake([], []);
    for (const sub of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      await expect(userCommand({ positionals: [sub, "ann@example.com"], values: {} }, f.io)).rejects.toThrow("usage: scf user create");
    }
    expect(f.calls).toEqual([]);
    expect(existsSync(join(tmp, "h", "users.json"))).toBe(false);
  });

  it("calls no io method on a syntax error", async () => {
    const f = fake([], []);
    await expect(userCommand({ positionals: ["list", "extra"], values: {} }, f.io)).rejects.toThrow("usage");
    await expect(userCommand({ positionals: ["create"], values: { repo: "." } }, f.io)).rejects.toThrow("usage");
    expect(f.calls).toEqual([]);
    expect(f.lines).toEqual([]);
    await list();
  });
});

// ---- the real prompts (terminalIo) on a fake terminal: streams that say isTTY and can switch raw mode ----

/** Runs userCommand with the real terminalIo(); `steps` type an answer once its prompt has been printed. */
async function onTerminal(args: { positionals: string[]; values: Record<string, unknown> }, steps: { wait: string; send: string }[]) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
  let out = "";
  let seen = 0;
  let i = 0;
  stderr.on("data", (d) => {
    out += d;
    const s = steps[i];
    if (s && out.slice(seen).includes(s.wait)) {
      seen = out.length;
      i++;
      setImmediate(() => stdin.write(s.send));
    }
  });
  let error: Error | undefined;
  await userCommand(args, terminalIo(stdin, stderr)).catch((e: Error) => (error = e));
  return { out, error };
}

describe("userCommand on a terminal", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
  });

  it("asks with echo off", async () => {
    const r = await onTerminal(
      { positionals: ["create"], values: { admin: true } },
      [
        { wait: "Name: ", send: "Ann\r" },
        { wait: "E-mail: ", send: "ann@example.com\r" },
        { wait: "Password: ", send: PW + "X\x7f\r" },
        { wait: "Repeat password: ", send: PW + "\r" },
      ],
    );
    expect(r.error).toBeUndefined();
    expect(r.out).not.toContain(PW);
    expect(r.out).not.toContain(PW.slice(PW.length / 2));
    expect(await verifyPassword(PW, stored().users[0]!.passwordHash)).toBe(true);
  });

  it("refuses two different passwords", async () => {
    const r = await onTerminal(
      { positionals: ["create"], values: { name: "Ann", email: "ann@example.com" } },
      [{ wait: "Password: ", send: PW + "\r" }, { wait: "Repeat password: ", send: PW2 + "\r" }],
    );
    expect(r.error?.message).toContain("the two passwords are not the same");
    expect(r.out).not.toContain(PW);
    expect(r.out).not.toContain(PW2);
    expect(existsSync(usersFile())).toBe(false);
  });

  it("stops on Ctrl-C", async () => {
    const r = await onTerminal({ positionals: ["create"], values: { name: "Ann", email: "ann@example.com" } }, [{ wait: "Password: ", send: "partial-typed\x03" }]);
    expect(r.error?.message).toBe("cancelled");
    expect(r.out).not.toContain("partial");
    expect(existsSync(usersFile())).toBe(false);
  });

  it("changes a password", async () => {
    mkdirSync(home, { recursive: true });
    await userCommand({ positionals: ["create"], values: { name: "Ann", email: "ann@example.com" } }, {
      isTTY: true, ask: async () => "", askHidden: async () => PW, readStdinLine: async () => undefined, out: () => {},
    });
    const r = await onTerminal({ positionals: ["password", "ann@example.com"] , values: {} }, [{ wait: "Password: ", send: PW2 + "\r" }, { wait: "Repeat password: ", send: PW2 + "\r" }]);
    expect(r.error).toBeUndefined();
    expect(r.out).not.toContain(PW2);
    expect(await verifyPassword(PW2, stored().users[0]!.passwordHash)).toBe(true);
  });
});

// ---- sessions and the serve hint ----

describe("accounts and sessions", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
  });

  /** Two accounts with one session each. */
  function twoWithSessions() {
    expect(create("ann@example.com").code).toBe(0);
    expect(create("bob@example.com", []).code).toBe(0);
    const users = listUsers();
    const [ann, bob] = ["ann@example.com", "bob@example.com"].map((e) => users.find((u) => u.email === e)!);
    for (const u of [ann!, bob!]) expect(startSession(u.id, u.passwordHash)).toBeDefined();
    expect(readSessions()).toHaveLength(2);
    return { ann: ann!, bob: bob! };
  }

  it("`password` signs the account out and leaves the others", () => {
    const { ann, bob } = twoWithSessions();
    expect(run(["user", "password", "ann@example.com"], PW2 + "\n").code).toBe(0);
    expect(readSessions().map((s) => s.userId)).toEqual([bob.id]);
    expect(ann.id).not.toBe(bob.id);
  });

  it("`block` signs the account out, and `unblock` does not bring it back", () => {
    const { ann } = twoWithSessions();
    expect(run(["user", "block", "bob@example.com"], "").code).toBe(0);
    expect(readSessions().map((s) => s.userId)).toEqual([ann.id]);
    expect(run(["user", "unblock", "bob@example.com"], "").code).toBe(0);
    expect(readSessions().map((s) => s.userId)).toEqual([ann.id]);
  });

  it("adminHint is set until an admin exists", () => {
    expect(adminHint()).toBe("no admin account yet — open the UI to create one, or run: scf user create --admin");
    expect(create("bob@example.com", []).code).toBe(0);
    expect(adminHint()).toContain("scf user create --admin");
    expect(create("ann@example.com").code).toBe(0);
    expect(adminHint()).toBeUndefined();
  });
});

describe("scf serve", () => {
  /** Starts the server, waits for the banner and the line after it, stops it, and returns what it printed. */
  async function banner(): Promise<string> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    const child = spawn(process.execPath, [CLI, "serve", "--port", String(port), "--repo", repo], {
      env: { ...cleanEnv(), FACTORY_NO_SUPERVISE: "1", FACTORY_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.resume();
    try {
      const until = Date.now() + 15_000;
      while (!out.includes("Ctrl+C to stop") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      return out;
    } finally {
      child.kill();
    }
  }

  it("prints a hint while there is no admin, and not after", async () => {
    const hint = "no admin account yet — open the UI to create one, or run: scf user create --admin";
    expect(await banner()).toContain(hint);
    expect(create().code).toBe(0);
    const after = await banner();
    expect(after).toContain("Ctrl+C to stop");
    expect(after).not.toContain("no admin account");
  }, 40_000);
});
