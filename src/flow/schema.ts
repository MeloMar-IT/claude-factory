import { z } from "zod";
import { varEnvName } from "../engine/template.js";

/** Reserved transition targets. Anything else must be a step id. */
/** next: following step · end: succeed · fail: fail · stop: halt as "stopped" (needs a human). */
export const RESERVED_TARGETS = ["next", "end", "fail", "stop"] as const;

export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

/** Coding agent CLI that runs a claude-type step. */
export const AGENTS = ["claude", "codex"] as const;

/** How hard the agent thinks; more effort = better answers, more tokens. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const stepId = z
  .string()
  .regex(/^[a-zA-Z][\w-]*$/, "step id must start with a letter and contain only letters, digits, _ or -");

const varValue = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const varsRecord = z.record(z.string(), varValue);

/** Names a user may fill in: the same pattern the API accepts for run variables. */
export const VAR_NAME_RE = /^[\w-]+$/;
export const isVarName = (k: string): boolean => VAR_NAME_RE.test(k) && k !== "__proto__";

const shown = { label: z.string().trim().min(1).max(80).optional(), help: z.string().max(300).optional() };

/** How one variable shows to users: hidden (admin default), fixed (shown, read-only) or input (user fills in). */
export const PublishVarSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("hidden") }).strict(),
  z.object({ mode: z.literal("fixed"), ...shown }).strict(),
  z.object({ mode: z.literal("input"), ...shown, default: varValue.optional(), required: z.boolean().optional() }).strict(),
]);

/** What users may run and fill in. `version` is raised by the server on save. */
export const PublishSchema = z
  .object({
    enabled: z.boolean().default(false),
    version: z.number().int().positive().default(1),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    vars: z.record(z.string(), PublishVarSchema).default({}),
  })
  .strict();
export type Publish = z.infer<typeof PublishSchema>;
export type PublishVar = z.infer<typeof PublishVarSchema>;

const baseStep = {
  id: stepId,
  description: z.string().optional(),
  /** Regex; step only succeeds if its output matches. */
  pass_if: z.string().optional(),
  /** Regex; step fails if its output matches. */
  fail_if: z.string().optional(),
  /** Skipped in top-to-bottom order; only entered via a jump (e.g. an error handler). */
  jump_only: z.boolean().optional(),
  /** Where to go on success: step id | next | end | fail | stop. Default: next. */
  on_success: z.string().optional(),
  /** Where to go on failure: step id | next | end | fail | stop. Default: fail. */
  on_failure: z.string().optional(),
  /** On success, the first route whose regex matches the output decides where to go (before on_success). */
  routes: z.array(z.object({ if: z.string(), goto: z.string() }).strict()).optional(),
  /** When a run that stopped at this step is resumed, restart at this step instead. */
  resume_from: z.string().optional(),
  /** How often this step may run in one flow run (loop guard). */
  max_visits: z.number().int().positive().optional(),
  timeout_sec: z.number().positive().optional(),
};

export const ClaudeStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("claude"),
    prompt: z.string().min(1),
    /** Model spec: sonnet · codex · codex:gpt-5 · ollama:qwen3-coder · codex:ollama:gpt-oss:20b */
    model: z.string().optional(),
    /** claude (Claude Code, default) or codex (OpenAI Codex CLI). */
    agent: z.enum(AGENTS).optional(),
    /** Provider name from config (anthropic, openai, ollama, lmstudio, or your own). */
    provider: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
    system_prompt: z.string().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    allowed_tools: z.array(z.string()).optional(),
    /** Continue the Claude session of an earlier claude step (by id). */
    resume: z.string().optional(),
    max_budget_usd: z.number().positive().optional(),
    /** Run Claude's bash tool in Claude Code's sandbox (writes limited to the workspace). Default: flow sandbox.claude. */
    sandbox: z.boolean().optional(),
  })
  .strict();

export const ShellStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("shell"),
    run: z.string().min(1),
    /** Run inside a Docker container (flow sandbox.docker_image) — use for steps that execute repo code. */
    sandbox: z.boolean().optional(),
  })
  .strict();

/** Pauses the run until a human approves (→ on_success) or rejects (→ on_failure). */
export const ApprovalStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("approval"),
    message: z.string().min(1),
  })
  .strict();

/** Runs the listed steps concurrently; succeeds when all of them succeed. */
export const ParallelStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("parallel"),
    steps: z.array(stepId).min(2),
  })
  .strict();

/** Runs another flow inline, in the same workspace. */
export const FlowStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("flow"),
    flow: z.string().min(1),
    /** Vars for the sub-flow; values may use {{vars.*}}, {{workdir}}, {{run.*}}. */
    vars: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const StepSchema = z.discriminatedUnion("type", [
  ClaudeStepSchema,
  ShellStepSchema,
  ApprovalStepSchema,
  ParallelStepSchema,
  FlowStepSchema,
]);

export const DefaultsSchema = z
  .object({
    model: z.string().optional(),
    agent: z.enum(AGENTS).optional(),
    provider: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    allowed_tools: z.array(z.string()).optional(),
    max_visits: z.number().int().positive().optional(),
    timeout_sec: z.number().positive().optional(),
    max_budget_usd: z.number().positive().optional(),
  })
  .strict();

export const SandboxSchema = z
  .object({
    /** Default for claude steps: sandbox Claude's bash tool. */
    claude: z.boolean().optional(),
    /** Image for shell steps with `sandbox: true`, e.g. node:22. */
    docker_image: z.string().optional(),
  })
  .strict();

type AnyStep = z.infer<typeof StepSchema>;

/**
 * Check that jumps, routes, resume and parallel references point at known steps.
 * `known` is the set of ids a reference may point at.
 */
export function checkStepRefs(steps: AnyStep[], known: Set<string>, addIssue: (path: (string | number)[], msg: string) => void) {
  const reserved = RESERVED_TARGETS as readonly string[];
  const byId = new Map(steps.map((s) => [s.id, s]));
  steps.forEach((s, i) => {
    const target = (t: string | undefined, path: (string | number)[]) => {
      if (t && !reserved.includes(t) && !known.has(t)) addIssue(["steps", i, ...path], `unknown step "${t}"`);
    };
    target(s.on_success, ["on_success"]);
    target(s.on_failure, ["on_failure"]);
    s.routes?.forEach((r, j) => {
      target(r.goto, ["routes", j, "goto"]);
      try {
        new RegExp(r.if);
      } catch {
        addIssue(["steps", i, "routes", j, "if"], `invalid regex: ${r.if}`);
      }
    });
    if (s.resume_from && !known.has(s.resume_from)) addIssue(["steps", i, "resume_from"], `unknown step "${s.resume_from}"`);
    for (const key of ["pass_if", "fail_if"] as const) {
      const re = s[key];
      if (!re) continue;
      try {
        new RegExp(re);
      } catch {
        addIssue(["steps", i, key], `invalid regex: ${re}`);
      }
    }
    if (s.type === "claude" && s.resume) {
      const t = byId.get(s.resume);
      if (!t || t.type !== "claude") addIssue(["steps", i, "resume"], `resume must reference a claude step, got "${s.resume}"`);
    }
    if (s.type === "parallel") {
      s.steps.forEach((ref, j) => {
        const t = byId.get(ref);
        if (!t) addIssue(["steps", i, "steps", j], `unknown step "${ref}"`);
        else if (t.type !== "claude" && t.type !== "shell") addIssue(["steps", i, "steps", j], `parallel can only run claude or shell steps`);
        else if (ref === s.id) addIssue(["steps", i, "steps", j], `a parallel step cannot run itself`);
      });
    }
  });
}

export const FlowSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * worktree: isolated git worktree + branch of the local repo per run.
     * inplace: work directly in the repo. empty: fresh empty dir (e.g. clone from GitHub in a step).
     */
    workspace: z.enum(["worktree", "inplace", "empty"]).default("worktree"),
    /**
     * Only one run of flows with this set may be active per repository (GitHub repo, or the
     * local repo path). For flows that change code; others (e.g. planning) run in parallel.
     */
    one_per_repo: z.boolean().optional(),
    defaults: DefaultsSchema.default({}),
    limits: z.object({ max_cost_usd: z.number().positive().optional() }).strict().default({}),
    sandbox: SandboxSchema.default({}),
    vars: varsRecord.default({}),
    publish: PublishSchema.optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict()
  .superRefine((flow, ctx) => {
    const ids = new Set<string>();
    flow.steps.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `duplicate step id "${s.id}"` });
      if ((RESERVED_TARGETS as readonly string[]).includes(s.id)) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `"${s.id}" is a reserved word` });
      }
      ids.add(s.id);
    });
    checkStepRefs(flow.steps, ids, (path, message) => ctx.addIssue({ code: "custom", path, message }));
    for (const [key, spec] of Object.entries(flow.publish?.vars ?? {})) {
      const path = ["publish", "vars", key];
      if (!Object.hasOwn(flow.vars, key)) ctx.addIssue({ code: "custom", path, message: `unknown variable "${key}"` });
      if (spec.mode === "input" && !isVarName(key)) {
        ctx.addIssue({ code: "custom", path, message: "a variable users fill in needs a name of letters, digits, _ or -" });
      }
    }
    const inputs = Object.entries(flow.publish?.vars ?? {}).filter(([, spec]) => spec.mode === "input").map(([key]) => key);
    for (const key of inputs) {
      // A shell step sees variables as FACTORY_VAR_<NAME>; two names with the same result would overwrite each other.
      const clash = Object.keys(flow.vars).find((other) => other !== key && varEnvName(other) === varEnvName(key));
      if (clash !== undefined) {
        ctx.addIssue({ code: "custom", path: ["publish", "vars", key], message: `"${key}" and "${clash}" give the same environment variable ${varEnvName(key)}` });
      }
    }
    if (inputs.length) {
      // A value a user fills in must not be pasted into a shell command.
      flow.steps.forEach((s, i) => {
        if (s.type !== "shell") return;
        for (const m of s.run.matchAll(/\{\{\s*vars\.([\w-]+)\s*\}\}/g)) {
          if (inputs.includes(m[1]!)) {
            ctx.addIssue({ code: "custom", path: ["steps", i, "run"], message: `"${m[1]}" is filled in by users; in a shell step use $${varEnvName(m[1]!)} instead of {{vars.${m[1]}}}` });
          }
        }
      });
    }
    if (flow.publish?.enabled) {
      flow.steps.forEach((s, i) => {
        if (s.type === "flow") {
          ctx.addIssue({ code: "custom", path: ["steps", i, "type"], message: "a flow published to users cannot have sub-flow steps; copy the steps in" });
        }
      });
    }
  });

export type Flow = z.infer<typeof FlowSchema>;
export type Step = z.infer<typeof StepSchema>;
export type ClaudeStep = z.infer<typeof ClaudeStepSchema>;
export type ShellStep = z.infer<typeof ShellStepSchema>;
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;
export type ParallelStep = z.infer<typeof ParallelStepSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
