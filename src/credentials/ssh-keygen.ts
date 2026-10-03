import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSecret } from "./store.js";

const TIMEOUT_MS = 10_000;

/** What a public ed25519 key looks like as one line: the type and the 68 characters of its blob, nothing else. */
export const PUBLIC_KEY_RE = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;

export type KeygenErrorCode = "missing" | "failed";

/** A problem with making a key. The message never holds a key or a path. */
export class KeygenError extends Error {
  constructor(
    public code: KeygenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeygenError";
  }
}

export interface KeyPair {
  /** `ssh-ed25519 <key>`, one line, no comment. */
  publicKey: string;
  /** The private key in OpenSSH form, as `checkSecret("ssh-key", …)` stores it. */
  privateKey: string;
}

const failed = () => new KeygenError("failed", "ssh-keygen did not make a usable key");

/**
 * Makes an ed25519 key pair with ssh-keygen (no passphrase, no comment) in a private temporary folder that is removed
 * again. `SCF_SSH_KEYGEN_BIN` replaces the tool (for tests). Blocks while the tool runs, like the Keychain calls.
 */
export function generateKeyPair(): KeyPair {
  const bin = process.env.SCF_SSH_KEYGEN_BIN || "/usr/bin/ssh-keygen";
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "scf-keygen-"));
    const file = join(dir, "key");
    const r = spawnSync(bin, ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file], { stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new KeygenError("missing", "ssh-keygen was not found");
      throw failed();
    }
    if (r.status !== 0) throw failed();
    const privateKey = checkSecret("ssh-key", readFileSync(file, "utf8"));
    const [type, blob] = readFileSync(`${file}.pub`, "utf8").trim().split(/\s+/);
    const publicKey = `${type} ${blob}`;
    if (!PUBLIC_KEY_RE.test(publicKey)) throw failed();
    return { publicKey, privateKey };
  } catch (e) {
    if (e instanceof KeygenError) throw e;
    throw failed();
  } finally {
    // a key file that could not be removed must not be stored as if all were well: this throws and aborts
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        throw failed();
      }
    }
  }
}
