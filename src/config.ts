import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { FACTORY_HOME } from "./flow/load.js";

const WatcherSchema = z
  .object({
    id: z.string().regex(/^[\w-]+$/),
    enabled: z.boolean().default(true),
    /** issues: labelled issues → flow. pr-feedback: new review comments on factory PRs → flow. */
    source: z.enum(["issues", "pr-feedback"]).default("issues"),
    flow: z.string().default("github-issue"),
    github_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo"),
    label: z.string().default("claude-factory"),
    every: z.string().default("5m"),
    max_per_tick: z.number().int().positive().default(1),
    vars: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const ConfigSchema = z
  .object({
    /** Stop starting new work once today's spend reaches this. */
    daily_budget_usd: z.number().positive().optional(),
    /** Max runs executing at the same time (across all repos). */
    concurrency: z.number().int().positive().default(2),
    /** Pushes to these branches are refused (glob patterns). */
    protected_branches: z.array(z.string()).default(["main", "master", "develop", "release/*"]),
    notify: z
      .object({
        macos: z.boolean().default(true),
        slack_webhook: z.string().url().optional(),
        /** Shell command run with FACTORY_EVENT, FACTORY_RUN_ID, FACTORY_STATUS, FACTORY_MESSAGE in env. */
        command: z.string().optional(),
        /** Which run outcomes notify. */
        on: z.array(z.enum(["succeeded", "failed", "stopped", "waiting", "cancelled"])).default(["succeeded", "failed", "stopped", "waiting"]),
      })
      .strict()
      .prefault({}),
    /** Commit/comment as a bot instead of you. */
    bot: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        /** Name of an env var holding a GitHub token for the bot account (used as GH_TOKEN). */
        gh_token_env: z.string().optional(),
      })
      .strict()
      .default({}),
    /** GitHub App identity (takes precedence over bot.gh_token_env). */
    github_app: z
      .object({
        app_id: z.string(),
        installation_id: z.string(),
        private_key_path: z.string(),
      })
      .strict()
      .optional(),
    /** Defaults for flows that don't set their own sandbox. */
    sandbox: z.object({ claude: z.boolean().optional(), docker_image: z.string().optional() }).strict().default({}),
    watchers: z.array(WatcherSchema).default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type WatcherConfig = z.infer<typeof WatcherSchema>;
export { WatcherSchema };

export const CONFIG_PATH = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "config.yaml");

export function loadConfig(path = CONFIG_PATH()): Config {
  if (!existsSync(path)) return ConfigSchema.parse({});
  const res = ConfigSchema.safeParse(parse(readFileSync(path, "utf8")) ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`${path}: invalid config\n${issues}`);
  }
  return res.data;
}

export function saveConfig(config: unknown, path = CONFIG_PATH()): Config {
  const parsed = ConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(parsed, { lineWidth: 0 }));
  return parsed;
}

/** Per-repo settings in <repo>/.claude-factory/config.yaml (e.g. test_cmd). */
const RepoConfigSchema = z
  .object({ vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).default({}) })
  .passthrough();

export function loadRepoVars(repo: string): Record<string, string> {
  const p = join(repo, ".claude-factory", "config.yaml");
  if (!existsSync(p)) return {};
  const res = RepoConfigSchema.safeParse(parse(readFileSync(p, "utf8")) ?? {});
  if (!res.success) throw new Error(`${p}: invalid repo config`);
  return res.data.vars;
}
