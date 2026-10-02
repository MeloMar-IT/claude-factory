import { checkKeychain, rotateKey } from "./store.js";

export const CREDENTIAL_USAGE = `usage: scf credential rotate-key   Re-encrypt every stored credential under a new key
       scf credential check        Check that the macOS Keychain works for the credential key`;

/** `scf credential …`. Prints through `out`; returns the exit code. */
export function credentialCommand(positionals: string[], out: (line: string) => void): number {
  const [sub, ...rest] = positionals;
  if ((sub !== "rotate-key" && sub !== "check") || rest.length) throw new Error(CREDENTIAL_USAGE);
  if (sub === "check") {
    checkKeychain();
    out("Keychain works: the credential key can be stored, read and removed");
    return 0;
  }
  const r = rotateKey();
  if (!r.rotated && !r.oldKeysLeft) out("no credential key yet");
  else if (r.rotated) out(`re-encrypted ${r.count} credential(s) under a new key`);
  if (r.oldKeysLeft) {
    out(`${r.oldKeysLeft} old key(s) are still in the Keychain; run this command again once the Keychain works`);
    return 1;
  }
  return 0;
}
