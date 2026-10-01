# Writing Spaghetti Code Foundry flows — reference for AI assistants

> **For people:** give this whole file to any AI assistant (ChatGPT, Claude, Gemini, a local
> model…), then describe the flow you want. Print it with `scf flow-guide`, or copy it from
> `docs/FLOW_AUTHORING.md`. Save the answer as `<repo>/.claude-factory/flows/<name>.yaml` (or
> `~/.spaghetti-code-foundry/flows/` for all repositories) and check it with
> `scf validate <name>.yaml`. The **Draft flow with Claude** button in the UI uses this same
> file.
>
> **For the AI assistant:** everything below is the complete, exact format. Follow it strictly.

## What you are writing

Spaghetti Code Foundry runs **flows**: YAML files describing a pipeline of steps that is executed
headlessly on the user's machine, against a git repository. Steps are:

- **agent steps** (`type: claude`) — run a coding agent (Claude Code, or OpenAI's Codex CLI)
  with a prompt, in the run's workspace. The agent can read and edit files.
- **shell steps** (`type: shell`) — run a shell command (`sh -c`) in the workspace. Exit code 0
  is success.
- **approval steps** — pause until a human approves or rejects.
- **parallel steps** — run a few agent/shell steps at the same time.
- **flow steps** — run another flow inline.

Steps run top to bottom. Jumps (`on_success`, `on_failure`, `routes`) make loops and branches.

## Your answer

Reply with **only** the complete flow as YAML in one ```` ```yaml ```` code fence — no other text,
unless the user asks for an explanation. Use **only** the fields listed here; unknown fields
make the flow invalid.

## Top-level fields

```yaml
name: my-flow                 # required; short, kebab-case; usually the file name
description: one line shown in the UI
workspace: worktree           # worktree (default) | inplace | empty — see below
one_per_repo: true            # optional: only one run of this flow (and other such flows) per repo at a time;
                              #   set it for flows that change code, leave it out for read-only flows
defaults:                     # optional, apply to every agent step unless the step overrides them
  model: claude-sonnet-5-5
  agent: claude               # claude | codex
  provider: anthropic
  effort: high                # low | medium | high | xhigh | max
  permission_mode: acceptEdits
  allowed_tools: [Read, Edit, Write, Glob, Grep, "Bash(npm *)"]
  max_visits: 5
  timeout_sec: 1800
  max_budget_usd: 5           # per agent step
limits:
  max_cost_usd: 20            # optional: the whole run stops when it has cost this much
sandbox:                      # optional
  claude: false               # true = agents' shell commands may only write inside the workspace
  docker_image: node:22       # image for shell steps with `sandbox: true`
vars:                         # optional: variables with defaults; the user can override them per run
  test_cmd: npm test
steps: [...]                  # required, at least one
```

**workspace**

| Value | The run works in… | Use for |
|---|---|---|
| `worktree` | a fresh git worktree + branch of the local repository | almost everything (the default) |
| `inplace` | the repository itself | rarely; changes land directly in the user's checkout |
| `empty` | an empty directory | flows that clone something themselves (e.g. `gh repo clone`) |

## Step fields (every type)

| Field | Meaning |
|---|---|
| `id` | **Required**, unique. Starts with a letter; letters, digits, `_`, `-`. Not `next`, `end`, `fail`, `stop`. |
| `type` | **Required**: `claude` \| `shell` \| `approval` \| `parallel` \| `flow` |
| `description` | Shown in the UI |
| `on_success` | Where to go when the step succeeds: a step id, `next` (default), `end`, `fail` or `stop` |
| `on_failure` | Where to go when it fails: a step id, `next`, `end`, `fail` (default) or `stop` |
| `routes` | List of `{if: <regex>, goto: <target>}`. On success, the first regex that matches the output decides where to go (checked before `on_success`). Regexes are multi-line: `^` and `$` match at line starts/ends. |
| `pass_if` | Regex the output must match, or the step counts as failed |
| `fail_if` | Regex; if the output matches, the step counts as failed |
| `jump_only` | `true` = skipped when running top to bottom; only reached by a jump (handlers, fix steps) |
| `max_visits` | How often this step may run in one run (loop guard; default 5). Exceeding it fails the run. |
| `timeout_sec` | Kill the step after this many seconds |
| `resume_from` | For a step that stops the run: when the run is resumed, restart at this step instead |

**Targets:** `next` = the following step (skipping `jump_only` steps) · `end` = the run succeeds ·
`fail` = the run fails · `stop` = the run stops as *stopped* (waits for a human; they can resume it).

## Step types

### `claude` — an agent step

```yaml
- id: implement
  type: claude
  prompt: |                         # required
    Implement this: {{task}}
    Add tests. Do not commit.
  model: claude-sonnet-5-5          # optional; see "Models" below
  agent: codex                      # optional: claude (default) or codex
  provider: ollama                  # optional: a provider name (anthropic, openai, ollama, lmstudio, or the user's own)
  effort: high                      # optional: low | medium | high | xhigh | max
  system_prompt: You are a careful senior engineer.   # optional, appended to the agent's system prompt
  permission_mode: acceptEdits      # optional: acceptEdits | auto | bypassPermissions | default | dontAsk | plan
  allowed_tools: [Read, Edit, Write, Glob, Grep, "Bash(npm test*)"]   # optional
  resume: plan                      # optional: continue the session of an earlier claude step (by id)
  max_budget_usd: 3                 # optional: stop this step at this cost
  sandbox: true                     # optional: agent's shell commands may only write inside the workspace
```

- The step **output** is the agent's final answer. It succeeds unless the agent errors (or
  `pass_if`/`fail_if` say otherwise).
- **Read-only steps** (plan, review): `permission_mode: dontAsk` with
  `allowed_tools: [Read, Glob, Grep]` — the agent can then only read.
- **Editing steps**: `permission_mode: acceptEdits` and the tools it needs, e.g. `Edit`, `Write`,
  `Bash(npm test*)`. `Bash(git push*)` is never allowed — pushing is a shell step.
- `resume: <id>` continues that step's conversation: the agent already knows the code, so fix
  and follow-up steps are cheaper and better. Only resume steps of the **same agent**.
- To make routing reliable, tell the agent to **end with a fixed line**, e.g.
  `End with exactly one line: VERDICT: APPROVE or VERDICT: CHANGES`, and route on it:
  `routes: [{if: "^VERDICT: APPROVE\\s*$", goto: docs}]`.

**Models**

| Spec | Means |
|---|---|
| `claude-opus-5-5` / `opus` | Claude Opus — best for planning, architecture, hard reviews |
| `claude-sonnet-5-5` / `sonnet` | Claude Sonnet — the default choice for coding |
| `haiku` | Claude Haiku — cheap, for simple summaries/classification |
| `codex` | The Codex CLI with its default model (often used as an independent second reviewer) |
| `codex:gpt-5` | Codex with a specific model |
| `ollama:qwen3-coder` | Claude Code on a local Ollama model |
| `codex:ollama:gpt-oss:20b` | Codex on a local Ollama model |

Leave `model` out to use the flow default / the user's routing rules.

### `shell` — a command

```yaml
- id: test
  type: shell
  run: "{{vars.test_cmd}}"          # required; runs with sh -c in the workspace; exit 0 = success
  sandbox: true                     # optional: run inside Docker (flow sandbox.docker_image)
```

The output is stdout + stderr (long output is trimmed to the end).

### `approval` — wait for a human

```yaml
- id: approve
  type: approval
  message: "Push the changes for {{vars.github_repo}}?"   # required
  on_failure: stop                  # a rejection goes to on_failure (default: fail)
```

Approved → `on_success`. Rejected → `on_failure`. The output is "approved by X: note" /
"rejected by X: note". Not allowed inside sub-flows.

### `parallel` — run steps at the same time

```yaml
- id: checks
  type: parallel
  steps: [lint, unit_tests]         # ids of claude or shell steps (at least 2), usually jump_only
- id: lint
  type: shell
  jump_only: true
  run: npm run lint
- id: unit_tests
  type: shell
  jump_only: true
  run: npm test
```

Succeeds when all of them succeed.

### `flow` — run another flow inline

```yaml
- id: release_checks
  type: flow
  flow: release-check               # a flow name
  vars: {test_cmd: "{{vars.test_cmd}}"}
```

Runs in the same workspace. May not contain approval steps.

## Templates and environment variables

In `prompt`, `message` and `vars` values, `{{…}}` placeholders are replaced:

| Placeholder | Value |
|---|---|
| `{{task}}` | The task text the user typed when starting the run |
| `{{vars.NAME}}` | A flow variable |
| `{{workdir}}` | The workspace path |
| `{{run.id}}`, `{{run.dir}}`, `{{run.branch}}` | Run id, the run's own folder (for logs/files), the run's branch |
| `{{steps.ID.output}}` | Output of a step that already ran (empty if it hasn't run yet) |
| `{{steps.ID.ok}}`, `{{steps.ID.exit_code}}` | Whether it succeeded; a shell step's exit code |
| `{{learnings}}` | Lessons saved by earlier runs in this repository (may be empty) |

A flow variable named **`agent_env`** is special: its `KEY=value` pairs (separated by `;` or new
lines) are added to the environment of every agent step — e.g. `agent_env: JAVA_HOME=/opt/jdk21`
so the agent can run `./gradlew`. (`PATH`, tokens, `FACTORY_*` and `SCF_*` can't be set this way.)

**Shell `run` may only use `{{vars.*}}`, `{{workdir}}` and `{{run.*}}`** — never `{{task}}` or
`{{steps.*}}` (that text is untrusted and would be a shell-injection risk). In shell steps, use
these environment variables instead (always quote them: `"$FACTORY_TASK"`):

| Variable | Value |
|---|---|
| `$FACTORY_TASK` | The task text |
| `$FACTORY_OUT_<STEP_ID>` | Output of a step; id upper-cased, `-` → `_` (step `run-tests` → `$FACTORY_OUT_RUN_TESTS`) |
| `$FACTORY_VAR_<NAME>` | A flow variable (`github_repo` → `$FACTORY_VAR_GITHUB_REPO`) |
| `$FACTORY_RUN_ID`, `$FACTORY_WORKDIR`, `$FACTORY_BRANCH` | Run id, workspace, branch |
| `$FACTORY_BASE_SHA` | The commit the run started from (`git diff $FACTORY_BASE_SHA` = everything the run changed) |
| `$FACTORY_TOOLS` | Folder with helper scripts (below) |
| `$FACTORY_LEARNINGS_FILE` | File where lessons for this repository are kept |

Every `FACTORY_…` variable is also set as `SCF_…` (e.g. `$SCF_TASK`); the built-in flows use `FACTORY_…`.

**Helper scripts** in `$FACTORY_TOOLS`:

| Script | Does |
|---|---|
| `"$FACTORY_TOOLS/detect-commands" test` | Prints the repository's test command (also `build`, `lint`) — use when `test_cmd` is `auto` |
| `"$FACTORY_TOOLS/test-summary" <marker-file>` | Summarises test reports newer than the marker file |
| `"$FACTORY_TOOLS/secret-scan" [range]` | Checks commits for secrets (pushes are always checked anyway) |

The Foundry always blocks pushes to protected branches (`main`, `master`, …) and pushes that
contain secrets — a flow cannot turn that off. Push to a new branch and open a pull request.

## Patterns

**Test → fix loop** (the fix continues the coding session; at most 3 fixes):

```yaml
- id: test
  type: shell
  run: "{{vars.test_cmd}}"
  on_failure: fix
- id: fix
  type: claude
  jump_only: true
  resume: implement
  max_visits: 3
  prompt: |
    The tests fail. Fix the code (never weaken or delete tests).
    {{steps.test.output}}
  on_success: test
```

**Review gate** (a second agent reviews; changes are fixed, then reviewed again):

```yaml
- id: review
  type: claude
  agent: codex
  permission_mode: dontAsk
  allowed_tools: [Read, Glob, Grep]
  max_visits: 3
  prompt: |
    Review the uncommitted changes (git diff HEAD) for bugs, edge cases and missing tests.
    Report only real problems. End with exactly one line: VERDICT: APPROVE or VERDICT: CHANGES
  routes: [{if: "^VERDICT: APPROVE\\s*$", goto: commit}]
- id: address_review
  type: claude
  resume: implement
  prompt: |
    Fix these review points:
    {{steps.review.output}}
  on_success: review
```

**Ask a human and wait** (stop the run; the user answers and resumes it):

```yaml
- id: plan
  type: claude
  permission_mode: dontAsk
  allowed_tools: [Read, Glob, Grep]
  prompt: |
    Plan: {{task}}
    If something important is unclear, list your questions and end with the line: NEEDS_INFO
    Otherwise write the plan and end with the line: READY
  routes: [{if: "^NEEDS_INFO\\s*$", goto: ask}]
- id: ask
  type: shell
  jump_only: true
  resume_from: plan               # after the human answered, plan again
  run: printf '%s\n' "$FACTORY_OUT_PLAN"
  on_success: stop
```

**Commit and push to the run's branch** (never to main):

```yaml
- id: commit
  type: shell
  run: |
    git add -A
    git commit -q -m "$FACTORY_TASK" && git log --oneline -1
- id: push
  type: shell
  run: git push -q -u origin HEAD && echo "pushed $(git branch --show-current)"
```

**Open a GitHub pull request** (needs the `gh` CLI):

```yaml
- id: open_pr
  type: shell
  run: |
    printf '%s\n\n%s\n' "$FACTORY_TASK" "$FACTORY_OUT_IMPLEMENT" > "{{run.dir}}/pr.md"
    gh pr create --fill --body-file "{{run.dir}}/pr.md"
```

**Work on a GitHub issue** (workspace `empty`; clone, read the issue, report back):

```yaml
workspace: empty
vars: {github_repo: owner/repo, issue: ""}
steps:
  - id: clone
    type: shell
    run: gh repo clone "$FACTORY_VAR_GITHUB_REPO" . -- -q && git checkout -q -b "factory/issue-$FACTORY_VAR_ISSUE"
  - id: issue
    type: shell
    run: gh issue view "$FACTORY_VAR_ISSUE" --repo "$FACTORY_VAR_GITHUB_REPO" --comments
  - id: implement
    type: claude
    prompt: |
      Implement this GitHub issue:
      {{steps.issue.output}}
  # … tests, review, commit, push, then:
  - id: report
    type: shell
    run: gh issue comment "$FACTORY_VAR_ISSUE" --repo "$FACTORY_VAR_GITHUB_REPO" --body "Done on branch $(git branch --show-current)"
```

## Checklist before you answer

1. Every jump target (`on_success`, `on_failure`, `routes[].goto`, `resume_from`, `resume`,
   `parallel.steps`) is an existing step id or `next`/`end`/`fail`/`stop`.
2. Fix/handler steps are `jump_only: true`, and every loop has a `max_visits`.
3. The step before a `jump_only` block ends with an explicit `on_success` (usually `end` or a
   later step), or the run falls through into the next non-jump step as intended.
4. Shell `run` uses only `{{vars.*}}`, `{{workdir}}`, `{{run.*}}`; everything else via
   `$FACTORY_…` env vars, quoted.
5. Agent prompts are specific: what to do, what not to do (e.g. "do not commit"), and — when
   the flow routes on the answer — the exact last line to write.
6. Read-only agent steps use `permission_mode: dontAsk` with read-only tools.
7. Nothing pushes to `main`; there is no `git push --force`.
8. Regexes in YAML strings escape backslashes: `"^VERDICT: APPROVE\\s*$"`.
9. Flows that change code have `one_per_repo: true`.

## Complete example

```yaml
name: feature-with-review
description: Sonnet implements the task with tests; Codex reviews; fix loops; commit
workspace: worktree
one_per_repo: true
defaults:
  model: claude-sonnet-5-5
  permission_mode: acceptEdits
  allowed_tools: [Read, Edit, Write, Glob, Grep, "Bash(npm *)", "Bash(git diff*)", "Bash(git status*)"]
  max_budget_usd: 5
limits:
  max_cost_usd: 25
vars:
  test_cmd: npm test
steps:
  - id: plan
    type: claude
    model: claude-opus-5-5
    effort: high
    permission_mode: dontAsk
    allowed_tools: [Read, Glob, Grep]
    prompt: |
      Plan how to implement this in the repository, with the files to change and the tests to add.
      Do not modify files.
      Task: {{task}}

  - id: implement
    type: claude
    prompt: |
      Implement the task following the plan. Add tests. Do not commit.
      Task: {{task}}
      Plan:
      {{steps.plan.output}}

  - id: test
    type: shell
    run: "{{vars.test_cmd}}"
    on_failure: fix

  - id: review
    type: claude
    agent: codex
    permission_mode: dontAsk
    allowed_tools: [Read, Glob, Grep]
    max_visits: 3
    prompt: |
      Review the uncommitted changes (git diff HEAD) for this task: {{task}}
      Report only real problems (bugs, edge cases, missing tests), each with file and fix.
      End with exactly one line: VERDICT: APPROVE or VERDICT: CHANGES
    routes: [{if: "^VERDICT: APPROVE\\s*$", goto: commit}]
    on_success: address_review

  - id: address_review
    type: claude
    jump_only: true
    resume: implement
    max_visits: 2
    prompt: |
      Fix the review points you agree with; explain in one line each why you skip the others.
      {{steps.review.output}}
    on_success: test

  - id: fix
    type: claude
    jump_only: true
    resume: implement
    max_visits: 3
    prompt: |
      The tests fail. Fix the code (never weaken or delete tests).
      {{steps.test.output}}
    on_success: test

  - id: commit
    type: shell
    jump_only: true
    run: |
      git add -A
      git commit -q -m "$FACTORY_TASK" && git log --oneline -1
    on_success: end
```
