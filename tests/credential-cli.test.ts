import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findUserByEmail } from "../src/auth/users.js";
import { addCredential, listCredentials, readSecret } from "../src/credentials/store.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";

const CLI = resolve("dist/cli.js");
const PW = "test-password-12345";
let tmp: string;
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
const outputs: string[] = [];

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`npm run build\` first`);
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cred-cli-"));
  home = join(tmp, "home");
  saved = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  outputs.length = 0;
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

function scf(args: string[], input = "") {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_HOME: home };
  delete env.FACTORY_HOME;
  const r = spawnSync(process.execPath, [CLI, ...args], { input, env, encoding: "utf8" });
  outputs.push(r.stdout, r.stderr);
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const makeUser = (email: string, admin = false) => scf(["user", "create", ...(admin ? ["--admin"] : []), "--name", "N", "--email", email], PW + "\n");

describe("scf user delete", () => {
  it("deletes an account and its credentials", () => {
    makeUser("root@example.com", true);
    makeUser("ann@example.com");
    const ann = findUserByEmail("ann@example.com")!;
    addCredential({ userId: ann.id, type: "token", name: "a", secret: fakeToken() });
    const r = scf(["user", "delete", "ann@example.com"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("deleted ann@example.com (1 credential(s) wiped)");
    expect(findUserByEmail("ann@example.com")).toBeUndefined();
    expect(listCredentials(ann.id)).toEqual([]);
  });

  it("refuses an unknown e-mail, the only admin and bad syntax", () => {
    makeUser("root@example.com", true);
    expect(scf(["user", "delete", "nobody@example.com"]).code).toBe(1);
    expect(scf(["user", "delete", "root@example.com"]).code).toBe(1);
    expect(scf(["user", "delete"]).code).toBe(1);
  });

  it("exits 1 and names the old key when it cannot be removed", () => {
    makeUser("root@example.com", true);
    makeUser("ann@example.com");
    makeUser("bob@example.com");
    for (const e of ["ann@example.com", "bob@example.com"]) addCredential({ userId: findUserByEmail(e)!.id, type: "token", name: "a", secret: fakeToken(e.slice(0, 3)) });
    kc.fail("delete");
    const r = scf(["user", "delete", "ann@example.com"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("an old credential key");
  });
});

describe("scf credential", () => {
  const token = fakeToken();
  const keys = () => Object.values(kc.items());

  it("says there is no key yet", () => {
    const r = scf(["credential", "rotate-key"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no credential key yet");
  });

  it("re-encrypts the credentials", () => {
    makeUser("root@example.com", true);
    const u = findUserByEmail("root@example.com")!;
    const a = addCredential({ userId: u.id, type: "token", name: "a", secret: token });
    const b = addCredential({ userId: u.id, type: "token", name: "b", secret: fakeToken("Bb2") });
    const r = scf(["credential", "rotate-key"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("re-encrypted 2 credential(s)");
    expect(readSecret(u.id, a.id)).toBe(token);
    expect(readSecret(u.id, b.id)).toBe(fakeToken("Bb2"));
  });

  it("exits 1 while an old key is left, then 0", () => {
    makeUser("root@example.com", true);
    addCredential({ userId: findUserByEmail("root@example.com")!.id, type: "token", name: "a", secret: token });
    kc.fail("delete");
    const bad = scf(["credential", "rotate-key"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("old key(s)");
    kc.fail();
    expect(scf(["credential", "rotate-key"]).code).toBe(0);
  });

  it("checks the Keychain", () => {
    expect(scf(["credential", "check"]).out).toContain("Keychain works");
    kc.fail("add");
    expect(scf(["credential", "check"]).code).toBe(1);
  });

  it("shows the usage for an unknown subcommand", () => {
    const r = scf(["credential", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: scf credential");
  });

  it("hides a stored token in an error message", () => {
    makeUser("root@example.com", true);
    const t = fakeToken("zq5");
    addCredential({ userId: findUserByEmail("root@example.com")!.id, type: "token", name: "a", secret: t });
    const r = scf(["user", "delete", `${t}@example.com`]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain(t);
    expect(r.err).toContain("[redacted]");
  });

  it("never prints a secret or the key", () => {
    makeUser("root@example.com", true);
    addCredential({ userId: findUserByEmail("root@example.com")!.id, type: "token", name: "a", secret: token });
    scf(["credential", "rotate-key"]);
    scf(["credential", "check"]);
    const all = outputs.join("\n");
    expect(all).not.toContain(token);
    for (const k of keys()) expect(all).not.toContain(k);
  });
});
