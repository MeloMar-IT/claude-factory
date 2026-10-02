import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export const KEYCHAIN_SERVICE = "claude-factory-credential-key";
const TIMEOUT_MS = 10_000;

export type KeyErrorCode = "missing" | "failed" | "unsupported" | "wrong-key";

/** A problem with the master key. The message never holds the key or a secret. */
export class KeyError extends Error {
  constructor(
    public code: KeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

/** `SCF_SECURITY_BIN` replaces the macOS tool (for tests). Without it only macOS is supported. */
function securityBin(): string {
  const bin = process.env.SCF_SECURITY_BIN;
  if (bin) return bin;
  if (process.platform !== "darwin") throw new KeyError("unsupported", "stored credentials need the macOS Keychain; other systems are not supported yet");
  return "/usr/bin/security";
}

/**
 * Runs the tool. `detached` gives it no controlling terminal, so a password prompt reads stdin.
 * The arguments never hold the key (it goes through stdin).
 */
function security(args: string[], input?: string) {
  // `detached` is honoured by spawnSync but missing from its type
  const options = { input, encoding: "utf8", detached: true, timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] } as SpawnSyncOptionsWithStringEncoding;
  const r = spawnSync(securityBin(), args, options);
  if (r.error) throw new KeyError("failed", `the Keychain tool could not run (${(r.error as NodeJS.ErrnoException).code ?? "error"})`);
  return r;
}

const NOT_FOUND = 44;

/** The key (64 hex digits) of an item, or undefined when there is no such item. */
export function findKey(keyId: string): string | undefined {
  const r = security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keyId, "-w"]);
  if (r.status === NOT_FOUND) return undefined;
  const key = (r.stdout ?? "").trim();
  if (r.status !== 0 || !/^[0-9a-f]{64}$/.test(key)) throw new KeyError("failed", "the Keychain did not give the credential key (is the login keychain locked?)");
  return key;
}

/** Stores the key as a new item and reads it back; a wrong write contract is an error here, never a silent leak. */
export function addKey(keyId: string, keyHex: string): void {
  const r = security(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", keyId, "-w"], `${keyHex}\n${keyHex}\n`);
  if (r.status !== 0) throw new KeyError("failed", "the Keychain did not accept the credential key");
  if (findKey(keyId) !== keyHex) {
    try {
      deleteKey(keyId);
    } catch {
      // best effort
    }
    throw new KeyError("failed", "the Keychain item does not hold the key that was written");
  }
}

/** Removes an item. An item that is already gone is fine. */
export function deleteKey(keyId: string): void {
  const r = security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keyId]);
  if (r.status !== 0 && r.status !== NOT_FOUND) throw new KeyError("failed", "the Keychain did not remove the old credential key");
}
