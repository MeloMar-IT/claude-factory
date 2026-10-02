import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resetRedactCache } from "../../src/credentials/redact.js";

const FAKE = resolve("tests/fixtures/fake-security.mjs");

export interface FakeKeychain {
  dir: string;
  file: string;
  log: string;
  /** The items as `{ "<service>\0<account>": key }`. */
  items(): Record<string, string>;
  /** The lines of the call log (arguments only). */
  calls(): string[][];
  clearLog(): void;
  /** Sets or clears FAKE_KEYCHAIN_FAIL. */
  fail(op?: "find" | "add" | "delete"): void;
  remove(): void;
}

/** Points the credential store at a fake `security` tool. Call `remove()` when done. */
export function fakeKeychain(): FakeKeychain {
  const dir = mkdtempSync(join(tmpdir(), "fake-keychain-"));
  const bin = join(dir, "security");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const file = join(dir, "items.json");
  const log = join(dir, "calls.log");
  process.env.SCF_SECURITY_BIN = bin;
  process.env.FAKE_KEYCHAIN_FILE = file;
  process.env.FAKE_KEYCHAIN_LOG = log;
  delete process.env.FAKE_KEYCHAIN_FAIL;
  resetRedactCache();
  return {
    dir,
    file,
    log,
    items: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as string[])
        : [],
    clearLog: () => writeFileSync(log, ""),
    fail: (op) => {
      if (op) process.env.FAKE_KEYCHAIN_FAIL = op;
      else delete process.env.FAKE_KEYCHAIN_FAIL;
    },
    remove: () => {
      delete process.env.SCF_SECURITY_BIN;
      delete process.env.FAKE_KEYCHAIN_FILE;
      delete process.env.FAKE_KEYCHAIN_LOG;
      delete process.env.FAKE_KEYCHAIN_FAIL;
      resetRedactCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A token built at run time, so no test file holds a token-shaped string. */
export const fakeToken = (tag = "Zx9") => "ghp_" + tag.repeat(12);

/** A real ed25519 private key in PEM form (LF line ends, final newline). */
export const fakeKey = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/** A PEM-shaped text whose last base64 line has `last` characters. */
export function pemWithLastLine(last: number): string {
  const body = randomBytes(200).toString("base64").replace(/=+$/, "").slice(0, 64 * 2 + last);
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
