import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE = resolve("tests/fixtures/fake-ssh-keygen.mjs");

export interface KeygenCall {
  args: string[];
  dir: string;
  dirMode: number;
}
export interface FakeKeygen {
  /** The calls so far. */
  calls(): KeygenCall[];
  /** The pairs the fake made, in order. */
  pairs(): { privateKey: string; publicKey: string }[];
  /** Sets or clears FAKE_KEYGEN_FAIL. */
  fail(mode?: "exit" | "private" | "public" | "no-private" | "no-public"): void;
  remove(): void;
}

const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** Points the key maker at a fake `ssh-keygen`. Call `remove()` when done. */
export function fakeKeygen(): FakeKeygen {
  const dir = mkdtempSync(join(tmpdir(), "fake-keygen-"));
  const bin = join(dir, "ssh-keygen");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const log = join(dir, "calls.log");
  const keys = join(dir, "keys.log");
  process.env.SCF_SSH_KEYGEN_BIN = bin;
  process.env.FAKE_KEYGEN_LOG = log;
  process.env.FAKE_KEYGEN_KEYS = keys;
  delete process.env.FAKE_KEYGEN_FAIL;
  return {
    calls: () => lines<KeygenCall>(log),
    pairs: () => lines<{ privateKey: string; publicKey: string }>(keys),
    fail: (mode) => {
      if (mode) process.env.FAKE_KEYGEN_FAIL = mode;
      else delete process.env.FAKE_KEYGEN_FAIL;
    },
    remove: () => {
      delete process.env.SCF_SSH_KEYGEN_BIN;
      delete process.env.FAKE_KEYGEN_LOG;
      delete process.env.FAKE_KEYGEN_KEYS;
      delete process.env.FAKE_KEYGEN_FAIL;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
