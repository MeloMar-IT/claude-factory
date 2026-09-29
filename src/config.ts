import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { FACTORY_HOME } from "./flow/load.js";

const WatcherSchema = z
  .object({
    id: z.string().regex(/^[\w-]+$/),
    enabled: z.boolean().default(true),
    /**
     * issues: labelled issues → flow. pr-feedback: new review comments on factory PRs → flow.
     * ci-failures: CI red on the default branch → ci-fix. schedule: run a chore every `every`.
     */
    source: z.enum(["issues", "pr-feedback", "ci-failures", "schedule"]).default("issues"),
    flow: z.string().default("github-issue"),
    github_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo"),
    label: z.string().default("claude-factory"),
    every: z.string().default("5m"),
    max_per_tick: z.number().int().positive().default(1),
    vars: z.record(z.string(), z.string()).default({}),
    /** schedule: what the chore should do (the run's task). */
    task: z.string().max(5000).optional(),
    /** ci-failures: branch to watch (default: the repo's default branch). */
    branch: z.string().regex(/^[\w./-]+$/).optional(),
    /** issues: skip issues that carry any of these labels. */
    exclude_labels: z.array(z.string()).default([]),
    /** issues: your own names for the status labels (default factory:working, factory:done, …). */
    status_labels: z
      .object({ working: z.string(), done: z.string(), needs_info: z.string(), waiting: z.string(), failed: z.string() })
      .partial()
      .strict()
      .default({}),
    /** issues: labels to remove when a run succeeds (e.g. the trigger label). */
    remove_on_done: z.array(z.string()).default([]),
    /** issues: post the failure reason and the failing step's output on the issue. */
    comment_on_failure: z.boolean().default(true),
    /** Start nothing while an open PR's head branch starts with this (e.g. factory/daily-). */
    pause_while_pr_open: z.string().optional(),
    /** Never run two of this watcher's runs at the same time (they share a branch). */
    one_at_a_time: z.boolean().default(false),
    /** schedule: run once a day at this time ("17:00") instead of every `every`. */
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").optional(),
    /** schedule: IANA time zone for `at`, e.g. Europe/Berlin (default: this Mac's). */
    timezone: z.string().optional(),
  })
  .strict()
  .refine((w) => w.source !== "schedule" || !!w.task?.trim(), { message: "a schedule watcher needs a task", path: ["task"] })
  .refine((w) => !w.timezone || validTimeZone(w.timezone), { message: "unknown time zone (use e.g. Europe/Berlin)", path: ["timezone"] });

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const PROVIDER_KINDS = ["anthropic", "openai", "ollama", "lmstudio", "anthropic-compatible"] as const;

/** Where an agent's model runs. anthropic/anthropic-compatible serve Claude Code, openai serves Codex, local ones serve both. */
const ProviderSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS),
    base_url: z.string().url().optional(),
    /** Env var holding the API key (anthropic-compatible). */
    api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    /** Model used when a step names the provider but no model. */
    default_model: z.string().optional(),
    /** USD per million tokens, for providers that report tokens but no cost (Codex with an API key). */
    price: z.object({ input_per_mtok: z.number().nonnegative(), output_per_mtok: z.number().nonnegative() }).strict().optional(),
  })
  .strict();

const RouterRuleSchema = z
  .object({
    /** Regex on the step id. */
    step: z.string().optional(),
    /** Regex on the flow name. */
    flow: z.string().optional(),
    /** Only from this visit on (2 = retries / fix loops). */
    min_visit: z.number().int().positive().optional(),
    /** Model spec, e.g. sonnet, codex, codex:gpt-5, ollama:qwen3-coder. */
    model: z.string().min(1),
  })
  .strict();

const RouterSchema = z
  .object({
    /** First matching rule picks the model for agent steps that don't name one. */
    rules: z.array(RouterRuleSchema).default([]),
    /** Tried in order when an agent step hits a rate/usage limit, or (for free targets) when a budget is used up. */
    fallback: z.array(z.string().min(1)).default([]),
    fallback_on: z.array(z.enum(["rate_limit", "budget"])).default(["rate_limit", "budget"]),
  })
  .strict()
  .prefault({});

export const ConfigSchema = z
  .object({
    /** Model spec for agent steps with no model anywhere (flow, step or router). */
    default_model: z.string().optional(),
    /** Extra or overridden providers; anthropic, openai, ollama and lmstudio are built in. */
    providers: z.record(z.string().regex(/^[a-z][\w-]*$/), ProviderSchema).default({}),
    router: RouterSchema,
    /** Stop starting new work once today's spend reaches this. */
    daily_budget_usd: z.number().positive().optional(),
    /** Max runs executing at the same time (across all repos). */
    concurrency: z.number().int().positive().default(2),
    /** Pushes to these branches are refused (glob patterns). */
    protected_branches: z.array(z.string()).default(["main", "master", "develop", "release/*"]),
    /**
     * Run agent steps without your personal Claude Code setup (MCP servers, plugins, skills,
     * hooks, user settings). Smaller context every turn and no off-task detours.
     */
    isolate_agents: z.boolean().default(true),
    /** Block pushes whose new commits add secrets (API keys, private keys, .env files). */
    secret_scan: z.boolean().default(true),
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
export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type RouterConfig = z.infer<typeof RouterSchema>;
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
