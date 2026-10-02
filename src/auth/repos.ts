import { join } from "node:path";
import { z } from "zod";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "./store.js";

export type RepoErrorCode = "bad-name" | "duplicate" | "limit" | "not-found";

/** A problem with what the caller asked for. The message is safe to show. */
export class RepoError extends Error {
  constructor(
    public code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

export const reposPath = () => join(dataHome(), "repos.json");

/** At most this many repositories per account. */
export const REPO_LIMIT = 50;

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** The placeholder flows use for "no repository chosen yet", in any case. */
const isPlaceholder = (name: string) => name.toLowerCase() === "owner/repo";
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const validName = (name: string) => NAME_RE.test(name) && !name.endsWith("/.") && !name.endsWith("/..") && !isPlaceholder(name);

/** The name as it is stored (trimmed), or a RepoError. */
export function checkRepoName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (!validName(name)) throw new RepoError("bad-name", 'a repository is written as "owner/name" (letters, digits, "-", "_" and "."); "owner/repo" is only a placeholder');
  return name;
}

const FileSchema = z
  .object({
    version: z.literal(1),
    repos: z.record(z.uuid(), z.array(z.string().refine(validName)).max(REPO_LIMIT)),
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const [id, names] of Object.entries(f.repos)) {
      const seen = new Set(names.map((n) => n.toLowerCase()));
      if (seen.size !== names.length) ctx.addIssue({ code: "custom", message: "duplicate", path: ["repos", id] });
    }
  });

type RepoFile = z.infer<typeof FileSchema>;

const EMPTY: RepoFile = { version: 1, repos: {} };
const read = (): RepoFile => readJsonFile(reposPath(), FileSchema, EMPTY);

/** The repositories of an account, in the order they were added. */
export const listRepos = (userId: string): string[] => [...(read().repos[userId] ?? [])];

/** True when the account has this repository (any case). */
export const ownsRepo = (userId: string, name: string): boolean => (read().repos[userId] ?? []).some((n) => sameName(n, name));

export function addRepo(userId: string, input: unknown): string {
  const name = checkRepoName(input);
  return withAuthLock(() => {
    const file = read();
    const mine = file.repos[userId] ?? [];
    if (mine.some((n) => sameName(n, name))) throw new RepoError("duplicate", "you have that repository already");
    if (mine.length >= REPO_LIMIT) throw new RepoError("limit", `at most ${REPO_LIMIT} repositories`);
    writeJsonFile(reposPath(), { ...file, repos: { ...file.repos, [userId]: [...mine, name] } });
    return name;
  });
}

export function removeRepo(userId: string, input: string): void {
  withAuthLock(() => {
    const file = read();
    const mine = file.repos[userId] ?? [];
    if (!mine.some((n) => sameName(n, input))) throw new RepoError("not-found", "no such repository");
    const left = mine.filter((n) => !sameName(n, input));
    const repos = { ...file.repos, [userId]: left };
    if (!left.length) delete repos[userId];
    writeJsonFile(reposPath(), { ...file, repos });
  });
}

/** Removes the whole list of an account. Only inside withAuthLock; writes nothing when there is no list. A file that cannot be read throws. */
export function removeReposLocked(userId: string): number {
  if (!authLockHeld()) throw new Error("removeReposLocked must run inside withAuthLock");
  const file = read();
  const mine = file.repos[userId];
  if (!mine) return 0;
  const repos = { ...file.repos };
  delete repos[userId];
  writeJsonFile(reposPath(), { ...file, repos });
  return mine.length;
}
