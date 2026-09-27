import { z } from "zod";

/** Reserved transition targets. Anything else must be a step id. */
export const RESERVED_TARGETS = ["next", "end", "fail"] as const;

export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

const stepId = z
  .string()
  .regex(/^[a-zA-Z][\w-]*$/, "step id must start with a letter and contain only letters, digits, _ or -");

const baseStep = {
  id: stepId,
  description: z.string().optional(),
  /** Regex; step only succeeds if its output matches. */
  pass_if: z.string().optional(),
  /** Regex; step fails if its output matches. */
  fail_if: z.string().optional(),
  /** Where to go on success: step id | next | end | fail. Default: next. */
  on_success: z.string().optional(),
  /** Where to go on failure: step id | next | end | fail. Default: fail. */
  on_failure: z.string().optional(),
  /** How often this step may run in one flow run (loop guard). */
  max_visits: z.number().int().positive().optional(),
  timeout_sec: z.number().positive().optional(),
};

export const ClaudeStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("claude"),
    prompt: z.string().min(1),
    model: z.string().optional(),
    system_prompt: z.string().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    allowed_tools: z.array(z.string()).optional(),
    /** Continue the Claude session of an earlier claude step (by id). */
    resume: z.string().optional(),
    max_budget_usd: z.number().positive().optional(),
  })
  .strict();

export const ShellStepSchema = z
  .object({
    ...baseStep,
    type: z.literal("shell"),
    run: z.string().min(1),
  })
  .strict();

export const StepSchema = z.discriminatedUnion("type", [ClaudeStepSchema, ShellStepSchema]);

export const DefaultsSchema = z
  .object({
    model: z.string().optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    allowed_tools: z.array(z.string()).optional(),
    max_visits: z.number().int().positive().optional(),
    timeout_sec: z.number().positive().optional(),
    max_budget_usd: z.number().positive().optional(),
  })
  .strict();

export const FlowSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** worktree: isolated git worktree + branch per run. inplace: work directly in the repo. */
    workspace: z.enum(["worktree", "inplace"]).default("worktree"),
    defaults: DefaultsSchema.default({}),
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).default({}),
    steps: z.array(StepSchema).min(1),
  })
  .strict()
  .superRefine((flow, ctx) => {
    const ids = new Map<string, number>();
    flow.steps.forEach((s, i) => {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `duplicate step id "${s.id}"` });
      }
      if ((RESERVED_TARGETS as readonly string[]).includes(s.id)) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `"${s.id}" is a reserved word` });
      }
      ids.set(s.id, i);
    });

    flow.steps.forEach((s, i) => {
      for (const key of ["on_success", "on_failure"] as const) {
        const t = s[key];
        if (t && !(RESERVED_TARGETS as readonly string[]).includes(t) && !ids.has(t)) {
          ctx.addIssue({ code: "custom", path: ["steps", i, key], message: `unknown step "${t}"` });
        }
      }
      for (const key of ["pass_if", "fail_if"] as const) {
        const re = s[key];
        if (re) {
          try {
            new RegExp(re);
          } catch {
            ctx.addIssue({ code: "custom", path: ["steps", i, key], message: `invalid regex: ${re}` });
          }
        }
      }
      if (s.type === "claude" && s.resume) {
        const target = flow.steps[ids.get(s.resume) ?? -1];
        if (!target || target.type !== "claude") {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "resume"],
            message: `resume must reference a claude step, got "${s.resume}"`,
          });
        }
      }
    });
  });

export type Flow = z.infer<typeof FlowSchema>;
export type Step = z.infer<typeof StepSchema>;
export type ClaudeStep = z.infer<typeof ClaudeStepSchema>;
export type ShellStep = z.infer<typeof ShellStepSchema>;
