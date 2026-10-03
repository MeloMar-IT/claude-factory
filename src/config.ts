import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
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
    source: z.enum(["issues", "pr-feedback", "ci-failures", "schedule", "monitor"]).default("issues"),
    /** "default": the flow for the source (issues → issue-gitflow, schedule → release-daily). */
    flow: z.string().default("default"),
    /** Empty for a monitor (source "monitor": checks the Foundry itself, only one allowed). */
    github_repo: z.string().default(""),
    label: z.string().default("claude-factory"),
    every: z.string().default("5m"),
    max_per_tick: z.number().int().positive().default(1),
    /** issues: stories with one of these labels (not case sensitive) go before all other stories. */
    priority_labels: z.array(z.string()).default(["bug"]),
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
    /** issues: don't start an issue while an issue named under "Depends on" / "Blocked by" is not done. */
    wait_for_dependencies: z.boolean().default(true),
    /** issues: a dependency also counts as done (besides closed) when it has one of these labels. */
    dependency_done_labels: z.array(z.string()).default([]),
    /**
     * issues: before starting new issues, run this flow once over all of them (e.g. epic-questions,
     * which asks every owner decision up front). Issues it asks about wait for an answer.
     */
    precheck_flow: z.string().optional(),
    /** issues: labels to remove when a run succeeds (e.g. the trigger label). */
    remove_on_done: z.array(z.string()).default([]),
    /** issues: post the failure reason and the failing step's output on the issue. */
    comment_on_failure: z.boolean().default(true),
    /** issues: keep one status comment on every issue the watcher follows (edited, never a second one). */
    status_comment: z.boolean().default(true),
    /** Start nothing while an open PR's head branch starts with this (e.g. factory/daily-). */
    pause_while_pr_open: z.string().optional(),
    /** Never run two of this watcher's runs at the same time (they share a branch). */
    one_at_a_time: z.boolean().default(false),
    /** schedule: run once a day at this time ("17:00") instead of every `every`. */
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").optional(),
    /** schedule: IANA time zone for `at`, e.g. Europe/Berlin (default: this Mac's). */
    timezone: z.string().optional(),
    /** The e-mail of the account that owns this watcher's runs (default: the first admin). Only an admin can set it. */
    owner: z.string().max(254).optional(),
  })
  .strict()
  .refine((w) => w.source !== "schedule" || !!w.task?.trim(), { message: "a schedule watcher needs a task", path: ["task"] })
  .refine((w) => !w.timezone || validTimeZone(w.timezone), { message: "unknown time zone (use e.g. Europe/Berlin)", path: ["timezone"] })
  .superRefine((w, ctx) => {
    if (w.source !== "monitor") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(w.github_repo)) ctx.addIssue({ code: "custom", message: "owner/repo", path: ["github_repo"] });
      return;
    }
    const no = (path: string, set: boolean) => set && ctx.addIssue({ code: "custom", message: "a monitor does not use this", path: [path] });
    no("github_repo", w.github_repo !== "");
    no("flow", w.flow !== "default");
    no("precheck_flow", w.precheck_flow !== undefined);
    no("owner", w.owner !== undefined);
  });

/** Thresholds of the monitor watcher. */
const MonitorSchema = z
  .object({
    /** The same run resumed more than `resumes` times within `within_minutes` (at most 49: run.json keeps the last 50 resumes). */
    restart_loop: z.object({ resumes: z.number().int().min(1).max(49).default(5), within_minutes: z.number().int().min(1).max(1440).default(10) }).strict().prefault({}),
    /** A watcher's check failed for more than `checks` checks in a row. */
    watcher_error: z.object({ checks: z.number().int().min(1).max(1000).default(3) }).strict().prefault({}),
    /** More than `percent` of GitHub's hourly request limit used. */
    github_limit: z.object({ percent: z.number().min(1).max(100).default(80) }).strict().prefault({}),
    /** An enabled watcher finished no check for `intervals` times its interval. */
    watcher_silent: z.object({ intervals: z.number().min(1).max(1000).default(5) }).strict().prefault({}),
    /** At least `runs` failed runs with an error the Foundry cannot explain, within `within_hours`. */
    unexplained_failure: z.object({ runs: z.number().int().min(1).max(1000).default(1), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** A running run wrote nothing to its log for longer than its step's timeout plus `extra_minutes`; a step without a timeout counts `no_timeout_minutes`. */
    stuck_run: z.object({ extra_minutes: z.number().int().min(1).max(1440).default(10), no_timeout_minutes: z.number().int().min(1).max(10080).default(120) }).strict().prefault({}),
    /** The same step of the same flow ended a run as failed for `issues` different issues within `within_hours`. */
    same_step_failing: z.object({ issues: z.number().int().min(2).max(1000).default(3), within_hours: z.number().int().min(1).max(168).default(24) }).strict().prefault({}),
    /** An issue's status label did not match its newest run for more than `checks` checks. */
    label_mismatch: z.object({ checks: z.number().int().min(1).max(1000).default(3) }).strict().prefault({}),
    /** A lock is held by a run that is not running for more than `minutes`. */
    orphan_lock: z.object({ minutes: z.number().int().min(1).max(1440).default(10) }).strict().prefault({}),
    /** Jobs are queued, slots are free and nothing started for `minutes`. */
    queue_stalled: z.object({ minutes: z.number().int().min(1).max(1440).default(15) }).strict().prefault({}),
    /** A new version is installed and the server waited more than `hours` to restart. */
    restart_overdue: z.object({ hours: z.number().min(0.1).max(168).default(2) }).strict().prefault({}),
    /** The tests after a merge into develop failed `failures` times in a row; looks back `within_hours`. */
    develop_red: z.object({ failures: z.number().int().min(1).max(100).default(2), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
    /** A step took more than `factor` times its usual time, `times` times within `within_hours`. */
    slow_step: z.object({ factor: z.number().min(1.5).max(100).default(3), times: z.number().int().min(1).max(1000).default(3), within_hours: z.number().int().min(1).max(720).default(24) }).strict().prefault({}),
  })
  .strict();

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

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

/** One allowed host entry: a DNS name, IPv4 address or bracketed IPv6 address, with an optional port. */
export function hostEntryOk(entry: string): boolean {
  let host = entry;
  let port: string | undefined;
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end < 0) return false;
    const rest = entry.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":")) return false;
    if (rest) port = rest.slice(1);
    host = entry.slice(1, end);
    if (isIP(host) !== 6) return false;
  } else {
    const i = entry.lastIndexOf(":");
    if (i >= 0) {
      port = entry.slice(i + 1);
      host = entry.slice(0, i);
    }
    if (host.length === 0 || host.length > 253) return false;
    if (!host.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l))) return false;
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  return true;
}

const ServerSchema = z
  .object({
    /** Address to listen on. Only these four: the Mac itself or all networks. Needs a restart. */
    listen: z.enum(["127.0.0.1", "::1", "0.0.0.0", "::"]).default("127.0.0.1"),
    /** Host names (optionally with port) accepted besides localhost, e.g. "mymac.local". */
    allowed_hosts: z.array(z.string().transform((s) => s.toLowerCase()).refine(hostEntryOk, "not a host name")).default([]),
    /** Accept requests from other computers over plain HTTP. Passwords and cookies are then unencrypted. */
    allow_insecure_http: z.boolean().default(false),
  })
  .strict()
  .prefault({});

export const ConfigSchema = z
  .object({
    /** Where and for whom the web UI is reachable. */
    server: ServerSchema,
    /** Model spec for agent steps with no model anywhere (flow, step or router). */
    default_model: z.string().optional(),
    /** Extra or overridden providers; anthropic, openai, ollama and lmstudio are built in. */
    providers: z.record(z.string().regex(/^[a-z][\w-]*$/), ProviderSchema).default({}),
    router: RouterSchema,
    /**
     * false: costs are still recorded and reported, but nothing stops on money — no run limit
     * (`limits.max_cost_usd`), no step limit (`max_budget_usd`), no daily budget. For fixed-price
     * subscriptions. Usage limits reported by Claude/Codex themselves still pause runs.
     */
    cost_limits: z.boolean().default(true),
    /** Stop starting new work once today's spend reaches this. */
    daily_budget_usd: z.number().positive().optional(),
    /** Max runs executing at the same time (across all repos). */
    concurrency: z.number().int().positive().default(2),
    /** Pushes to these branches are refused (glob patterns). */
    protected_branches: z.array(z.string()).default(["main", "master", "develop", "release/*"]),
    /**
     * Build bug stories of the built-in issue-gitflow as hotfixes: after the reviews and a green test run
     * they are merged into main (and develop) without a person. Off: bug stories are built as features.
     */
    hotfix_to_main: z.boolean().default(false),
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
        /** Which run outcomes run the command (macOS and Slack tell only what waits for you). */
        on: z.array(z.enum(["succeeded", "failed", "stopped", "waiting", "cancelled"])).default(["succeeded", "failed", "stopped", "waiting"]),
        /** Also tell when a run succeeds. */
        successes: z.boolean().default(false),
        /** At most one notification in this many minutes. */
        throttle_minutes: z.number().int().min(1).default(5),
        /** No notifications between these times ("HH:MM", this machine's clock; may cross midnight). */
        quiet_hours: z.object({ from: clock, to: clock }).strict().optional(),
        /** "HH:MM": send a short summary once a day. */
        daily_summary_at: clock.optional(),
      })
      .strict()
      .prefault({}),
    /** The one-sentence reason a model writes for a failed run (a small call; the rules text is the fallback). */
    failure_summary: z
      .object({ enabled: z.boolean().default(true), model: z.string().default("haiku") })
      .strict()
      .default({ enabled: true, model: "haiku" }),
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
    /** Thresholds of the monitor watcher. */
    monitor: MonitorSchema.prefault({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const monitors = c.watchers.filter((w) => w.source === "monitor");
    if (monitors.length > 1) ctx.addIssue({ code: "custom", message: "only one monitor watcher is allowed", path: ["watchers"] });
    const m = monitors[0];
    if (m && c.watchers.some((w) => w !== m && w.id === m.id)) ctx.addIssue({ code: "custom", message: `the id "${m.id}" of the monitor is used by another watcher`, path: ["watchers"] });
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;
export type MonitorConfig = z.infer<typeof MonitorSchema>;
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
