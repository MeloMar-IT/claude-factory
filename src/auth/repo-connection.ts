import { z } from "zod";
import { CredentialError, listCredentials, readSecret } from "../credentials/store.js";
import type { RepoRecord } from "./repos.js";
import { RepoError } from "./repo-url.js";

/** One check of a connection test. `message` is a fixed sentence (never text of a tool), `code` a fixed word. */
export const CheckSchema = z
  .object({
    check: z.enum(["clone", "push", "github-api"]),
    ok: z.boolean(),
    skipped: z.literal(true).optional(),
    code: z.string().regex(/^[a-z-]{1,40}$/),
    message: z.string().min(1).max(300),
  })
  .strict();

/** The last connection test of a repository: when, whether every check passed, and each check. */
export const ConnectionSchema = z
  .object({
    at: z.iso.datetime(),
    ok: z.boolean(),
    checks: z.array(CheckSchema).min(1).max(3),
  })
  .strict();

export type CheckResult = z.infer<typeof CheckSchema>;
export type ConnectionResult = z.infer<typeof ConnectionSchema>;

/** The name a repository's own credential has. */
export const repoSecretName = (r: Pick<RepoRecord, "id">) => `repo:${r.id}`;

const MISSING = "the sign-in of this repository is missing; set it again with Change authentication";

/** The token or private key of a record. Sets `lastUsed`. A missing credential (or one of another type) is a `no-credential` RepoError. */
export function readRepoSecret(rec: RepoRecord): string {
  const type = rec.method === "ssh-deploy-key" ? "ssh-key" : "token";
  const c = rec.credentialId ? listCredentials(rec.owner).find((x) => x.id === rec.credentialId && x.name === repoSecretName(rec) && x.type === type) : undefined;
  if (!c) throw new RepoError("no-credential", MISSING);
  try {
    return readSecret(rec.owner, c.id);
  } catch (e) {
    // removed between the check and the read
    if (e instanceof CredentialError && e.code === "not-found") throw new RepoError("no-credential", MISSING);
    throw e;
  }
}
