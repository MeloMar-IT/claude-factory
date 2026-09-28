# claude-factory user guide

claude-factory runs **flows**: pipelines of steps that code, test, review and ship changes with
AI coding agents on your own machine. This guide walks through the web UI, writing your own
flows, automating work from GitHub, choosing models, and keeping it all safe.

- [1. Start](#1-start)
- [2. Run a flow](#2-run-a-flow)
- [3. Follow, approve and resume runs](#3-follow-approve-and-resume-runs)
- [4. Write your own flows](#4-write-your-own-flows)
- [5. Models, agents and routing](#5-models-agents-and-routing)
- [6. Automate with watchers](#6-automate-with-watchers)
- [7. Settings and safety](#7-settings-and-safety)
- [8. Costs, dashboard and evals](#8-costs-dashboard-and-evals)
- [9. Command line](#9-command-line)
- [10. Troubleshooting](#10-troubleshooting)

---

## 1. Start

Install it (see the [README](../README.md)), then start the UI from the repository you want
to work on:

```bash
cd ~/code/my-project
factory ui
```

The UI opens at **http://localhost:4777**. It only listens on your own machine. The path in the
top-right corner is the repository runs work on by default.

| Page | What it is for |
|---|---|
| **Flows** | Your flows and the built-in ones: edit, create, run |
| **Library** | Reusable blocks of steps to drop into flows |
| **Runs** | Everything that ran or is running; the ones that need you on top |
| **Watchers** | Automatic runs from GitHub issues, PR comments, red CI, or a schedule |
| **Models** | Which agents and models are available, and which model runs which step |
| **Dashboard** | Spend, success rate, where runs fail, eval results |
| **Settings** | Budget, safety, notifications, bot identity, disk clean-up |

Everything the UI does is also available from the command line (see [section 9](#9-command-line)).

---

## 2. Run a flow

Pick a flow on the left, press **▶ Run**, describe the task and start it.

![Run dialog](images/run-dialog.png)

- **Task** — what you want done, in plain language. Flows use it in their prompts.
- **Repository** — the local git repository to work on.
- **Variables** — settings the flow exposes, e.g. `test_cmd`. Leave `auto` to let the factory
  detect the test command (npm/pnpm/yarn, pytest, Go, Cargo, Gradle, Maven, Make).

**Your checkout is never touched.** Depending on the flow's *workspace* setting, a run works in:

| Workspace | Where the run works |
|---|---|
| `worktree` (default) | A new git worktree on a `factory/<run-id>` branch of your repository |
| `empty` | An empty folder; the flow clones what it needs (used by the GitHub flows) |
| `inplace` | Directly in the repository — only for flows you trust |

When a run finishes, its branch stays in your repository. Review it, merge it, or delete it.

---

## 3. Follow, approve and resume runs

### The runs list

![Runs](images/runs.png)

Runs that wait for a decision or stopped with a question are listed under **Needs you**. At
most *N* runs execute at the same time (Settings → Runs at the same time); the rest queue.

### A run

Open a run to follow it live.

![Live log](images/run-log.png)

- **Live log** — each step as it starts and ends, with the agent's tool calls, duration, cost or
  tokens.
- **Steps & transcripts** — every step with its outcome. Open an agent step to read the whole
  conversation: what it said, each command it ran and the output, and the final result. The
  label next to the step name shows which agent and model ran it (here Claude on Haiku wrote the
  code, and Codex reviewed it).

  ![Steps and transcripts](images/run-steps.png)

- **Changes** — the complete diff the run made, including uncommitted work.

  ![Changes](images/run-diff.png)

### Approvals

An **approval** step pauses the run until a person decides. Approve or reject in the UI, with
`factory approve <run-id>` / `factory reject <run-id>`, or — for GitHub flows — by commenting
`/approve` or `/reject` on the issue (only people with write access count).

![Waiting for approval](images/run-waiting.png)

### When something goes wrong

- **Resume** continues a stopped, failed, cancelled or interrupted run from the step where it
  stopped, with everything it already did kept. Fix the cause first (e.g. answer the question,
  fix the environment), then press **↻ Resume**.
- **Retry from step…** re-runs from any earlier step.
- **Cancel** stops a running run; you can resume it later.

Runs survive restarts: if the factory stops mid-run, the run is marked *interrupted* and can be
resumed (watchers do this automatically).

---

## 4. Write your own flows

### The editor

![Flow editor](images/flows.png)

Edit a flow **visually** (left) or as **YAML** (tab at the top). The graph on the right shows
how steps connect: grey = next, green = on success, red dashed = on failure, purple = route.

![YAML view](images/flow-yaml.png)

- **Save to** — *this repo* (`<repo>/.claude-factory/flows/`, shared with your team through git)
  or *global* (`~/.claude-factory/flows/`, just for you). Saving a built-in flow creates your own
  copy that overrides it.
- **✨ Draft flow with Claude** — describe what you want and Claude writes the YAML.
  **Ask Claude** changes the open flow the same way.
- **+ From library** inserts a block from the [Library](#the-block-library).

### Step types

| Type | What it does |
|---|---|
| **Agent** (`type: claude`) | Runs Claude Code or Codex with a prompt |
| **Shell** | Runs a command; exit code 0 = success |
| **Approval** | Pauses until a person approves (→ on success) or rejects (→ on failure) |
| **Parallel** | Runs several agent/shell steps at once; succeeds when all succeed |
| **Sub-flow** | Runs another flow inline, in the same workspace |

### Controlling the path

Steps run top to bottom. Each step can change that:

- **On success / On failure** — `next` (default on success), `fail` (default on failure), `end`
  (finish as succeeded), `stop` (pause for a human), or a step id to jump to.
- **Routes** — on success, jump to a step when the output matches a pattern, e.g.
  `^ROUTE: small` → `quick_fix`. The first match wins.
- **Pass if / Fail if** — patterns that decide success from the output, e.g. an agent that must
  end with `VERDICT: APPROVE`.
- **Only reachable via jumps** — the step is skipped in the normal order (for fix-up handlers).
- **Max visits** — how often a step may run in one run (default 5); guards loops like
  test → fix → test.
- **When resumed, restart at** — for a step that stops the run, where a resume should continue.

A typical fix loop:

```yaml
steps:
  - id: implement
    type: claude
    prompt: "{{task}}"

  - id: run_tests
    type: shell
    run: npm test
    on_failure: fix_tests

  - id: fix_tests
    type: claude
    jump_only: true
    max_visits: 3
    prompt: |
      The tests fail. Fix the code.
      {{steps.run_tests.output}}
    on_success: run_tests
```

### Passing information between steps

In **agent prompts** you can use:

| Template | Value |
|---|---|
| `{{task}}` | The run's task |
| `{{vars.name}}` | A flow variable |
| `{{steps.<id>.output}}` | Output of an earlier step (also `.ok`, `.exit_code`) |
| `{{learnings}}` | Lessons saved by earlier runs in this repo |
| `{{run.history}}` | Which steps ran so far and how they ended |
| `{{workdir}}`, `{{run.id}}`, `{{run.branch}}` | Where and what this run is |

**Shell commands** may only template trusted values (`{{vars.*}}`, `{{workdir}}`, `{{run.*}}`).
Task text and step outputs could contain anything, so shell steps read them from environment
variables instead: `$FACTORY_TASK`, `$FACTORY_OUT_<STEP_ID>`, `$FACTORY_VAR_<NAME>`,
`$FACTORY_RUN_ID`, `$FACTORY_BRANCH`.

An agent step can **continue the session** of an earlier agent step ("Continue session of"), so
it remembers the conversation.

### Variables

Flow variables (`vars:`) have defaults in the flow and can be overridden per run, per watcher,
or per repository in `<repo>/.claude-factory/config.yaml`:

```yaml
vars:
  test_cmd: ./gradlew test
```

### The block library

![Block library](images/library.png)

Blocks are ready-made groups of steps: pull a GitHub issue, plan, code, run tests with a fix
loop, code review, cross-review by Codex, commit, push, open a PR, wait for CI, secret scan,
Jira and Linear, and more. Insert one with **+ From library** in the editor. Turn any step into
your own block with **☆ Save as block**.

---

## 5. Models, agents and routing

![Models](images/models.png)

### Agents

Agent steps run on one of two command-line agents:

- **Claude Code** — uses your Claude login (or an API key).
- **Codex** — OpenAI's Codex CLI with your ChatGPT login. Install it with
  `npm i -g @openai/codex` (or use the one inside the ChatGPT desktop app) and run `codex login`.

The **Coding agents** panel shows whether each is installed and logged in.

### Model specs

Wherever you can pick a model — a step, a flow's defaults, a routing rule, an eval — you write a
*model spec*:

| Spec | Runs on |
|---|---|
| `sonnet`, `opus`, `haiku` | Claude Code, Anthropic |
| `codex` | Codex, its default OpenAI model |
| `codex:gpt-5` | Codex with a specific model |
| `ollama:qwen3-coder:30b` | Claude Code on a local Ollama model |
| `codex:ollama:gpt-oss:20b` | Codex on a local Ollama model |
| `lmstudio:<model>` | Claude Code on LM Studio |

You can also set **Agent** and **Provider** separately on a step.

### Providers and local models

Anthropic, OpenAI, Ollama (`localhost:11434`) and LM Studio (`localhost:1234`) are built in.
Add your own (another Ollama host, or any Anthropic-compatible API) under **Add a provider**.
Local models cost nothing and keep your code on your machine; runs record them at $0. Choose
models trained for coding and tool use (e.g. `qwen3-coder`, `gpt-oss`) — general chat models
often fail to call tools. Use **Try a model** to check one works before you rely on it.

### Routing

**Rules** decide which model runs which step. The first matching rule wins — even over models
written in flows and blocks. A rule matches on a step id pattern, a flow name pattern and/or a
visit number (`From visit 2` = only retries). The presets add common rules:

- **Retries on Opus** — fix steps use Opus from their second attempt.
- **Codex reviews Claude's code** — review steps run on Codex.
- **Small jobs on a local model** — triage and learning steps run locally.

Without a matching rule, a step uses its own model, then the flow's default, then the
**Default model**.

**Fallback models** are tried in order when a model hits a rate or usage limit. With *continue
on the first free one when a budget runs out*, runs switch to the first free fallback (local or
ChatGPT) instead of pausing when the daily or run budget is used up.

---

## 6. Automate with watchers

A watcher checks GitHub on a schedule and starts runs by itself — as long as the factory is
running (see [Keep it running](#keep-it-running)). GitHub access uses the `gh` CLI's login.

![Watchers](images/watchers.png)

### Sources

| Source | Starts a run when… | Default flow |
|---|---|---|
| **Issues** | an open issue has the trigger label | `github-issue` |
| **Review comments** | someone comments on a factory PR (branch `factory/*`) | `pr-feedback` |
| **CI failures** | the latest CI run of a workflow on the default branch failed | `ci-fix` |
| **Schedule** | it is time for the chore (every N, or once a day at a set time) | `chore` |

![Add a watcher](images/watcher-form.png)

For a **schedule**, the chore text becomes the run's task; presets cover dependency updates,
flaky tests, test coverage, docs and lint. The `chore` flow opens a pull request only if
something changed. Intervals: `30s`, `5m`, `1h`, `7d`; or set **Once a day at** `17:00` with a
time zone.

### How issue watchers use labels

For each issue with the trigger label the watcher sets status labels, so you can follow along
in GitHub:

| Label (default name) | Meaning |
|---|---|
| `factory:working` | A run is working on it |
| `factory:needs-info` | The factory asked a question on the issue — reply and it continues |
| `factory:waiting-approval` | Waiting for `/approve` or `/reject` on the issue |
| `factory:done` | Finished |
| `factory:failed` | Failed; the reason is commented on the issue. Remove the label to retry |

Watchers can use your own label names, skip issues with certain labels (e.g. `wontfix`), remove
labels when done, pause while a pull request is open, and run one issue at a time. These are
set in `~/.claude-factory/config.yaml`:

```yaml
watchers:
  - id: plan
    source: issues
    flow: issue-plan
    github_repo: acme/webshop
    label: Factory_ready
    exclude_labels: [wontfix]
    status_labels: {working: Factory_planning, done: Factory_planned, needs_info: Factory_needs_info, failed: Factory_ERROR}
    remove_on_done: [Factory_ready]
```

### Example: a label-driven daily pipeline

The built-in flows `issue-plan`, `issue-code-daily` and `daily-pr` form a pipeline:

1. Label an issue **`Factory_ready`** → Opus writes a plan and posts it on the issue (or asks
   questions, or says the issue is not a coding task or too big and proposes a split).
2. Read the plan, comment if needed, and label it **`Factory_code`** → the issue is coded on the
   day's branch `factory/daily-YYYY-MM-DD`: tests before and after, up to 3 fix rounds, two
   review rounds by Codex with Claude fixing the findings, documentation, commit
   `Resolve #N: …`, push, and a report on the issue. After 3 failed fix rounds it labels the
   issue as failed and comments why — nothing is pushed.
3. **Once a day** (e.g. 17:00) the day's branch goes to `main` in one pull request that closes
   all its issues, after a full test run and build. No new coding starts until you merge it.

### Keep it running

Watchers only run while `factory ui` (or `factory serve`) runs. To keep the factory running in
the background on macOS, also after a restart:

```bash
factory service install     # uninstall | status
```

---

## 7. Settings and safety

![Settings](images/settings.png)

**Budget & capacity** — the daily budget stops new work when today's (estimated) spend reaches
it; paused runs continue the next day. Flows can also cap one run (`limits.max_cost_usd`).

**Safety**

- **Protected branches** — pushes to these branches (default `main`, `master`, `develop`,
  `release/*`) are refused during runs, whoever tries. Claude Code is not allowed to run
  `git push` at all, and Codex's sandbox has no network access by default — pushing is a flow
  step.
- **Secret scan** — every push is checked for API keys, tokens, private keys, connection
  strings and `.env`/key files in the new commits. Findings are shown masked and the push is
  refused. For a false positive, add `factory:allow-secret` to the line or a pattern to
  `.claude-factory/secret-allow` in the repository.
- **Sandboxing** — *Sandbox agents' shell commands* limits what agents' shell commands can
  write to the run's workspace. Shell steps marked **Run in Docker** (like the test steps) run
  in the Docker image you set, with only the workspace mounted.
- **Approval steps** in flows let you decide before anything irreversible happens (e.g.
  `require_approval=yes` for `github-pr`).

**Notifications** — macOS notifications, a Slack webhook, or your own command, for the run
outcomes you choose.

**Bot identity** — by default commits and comments are made as you. Set a bot name/email and a
token (or a GitHub App) to make them as a bot instead.

**Disk** — every run keeps its workspace so you can inspect or resume it. Remove old ones here
or with `factory clean` (branches in your repositories are kept).

Global settings are stored in `~/.claude-factory/config.yaml`; runs in `~/.claude-factory/runs/`.

---

## 8. Costs, dashboard and evals

### What the dollar amounts mean

The costs shown are **estimates at API prices**, as reported by Claude Code. Whether you pay
them depends on how the agents are logged in:

- Claude Code with a **Claude subscription** (Pro/Max): no per-token charges; usage counts
  toward your plan's limits.
- Claude Code with an **API key** (`ANTHROPIC_API_KEY`): billed per token — the amounts are
  real.
- Codex with your **ChatGPT login**: included in your ChatGPT plan; recorded as $0 with the
  token count. With `CODEX_API_KEY` you can set a price per token for the provider.
- **Local models**: free, recorded as $0.

Budgets use these amounts either way, so they also protect your subscription limits.

### Dashboard

![Dashboard](images/dashboard.png)

Spend today and over 30 days, success rate, runs that need a human, cost per day, results per
flow and per repository, the steps where runs fail most, and eval results.

### Evals

An eval suite runs sample tasks through one or more flows and models and scores them, so you
can compare, for example, Sonnet, Codex and a local model on your own code:

```yaml
# evals/my-suite.yaml
name: my-suite
flows: [quick]
cases:
  - name: add-multiply
    repo: fixtures/calc            # a folder or git repo, relative to this file
    task: Add a multiply(a, b) function to calc.js.
    vars: {test_cmd: node --test}
    check: node --test             # exit 0 = pass
```

```bash
factory eval evals/my-suite.yaml --models sonnet,codex,ollama:qwen3-coder
```

The report shows pass rate, average cost, tokens, time and fix loops per variant, and appears on
the Dashboard.

---

## 9. Command line

| Command | What it does |
|---|---|
| `factory ui [--port 4777] [--no-open]` | Web UI, queue and watchers |
| `factory serve [--port 4777]` | The same without opening a browser |
| `factory service install \| uninstall \| status` | Run `factory serve` in the background (macOS) |
| `factory run <flow> --task "…" [--var k=v] [--repo dir]` | Run a flow |
| `factory resume <run-id> [--from <step>]` | Continue a run |
| `factory approve <run-id> [--note "…"]` / `factory reject …` | Decide on a waiting run |
| `factory flows` / `factory blocks` | List flows / library blocks |
| `factory new <name> [--from <flow>] [--global]` | Create a flow from a template |
| `factory validate <flow or file>` | Check a flow |
| `factory watch [flow] --var github_repo=o/r [--source …] [--once]` | Run one watcher from the terminal |
| `factory eval <suite.yaml> [--flows a,b] [--models …]` | Run an eval suite |
| `factory clean [--older-than 7] [--purge] [--dry-run]` | Remove old run workspaces |

Flows are looked up in `<repo>/.claude-factory/flows/`, then `~/.claude-factory/flows/`, then the
built-in ones.

---

## 10. Troubleshooting

**A watcher shows an error.** Check that `gh auth status` works in the terminal where the
factory runs and that you have access to the repository. **Check now** on the Watchers page
retries immediately.

**"codex CLI not found" or "not logged in".** Install Codex (`npm i -g @openai/codex`, or the
ChatGPT desktop app) and run `codex login`. The Models page shows the status.

**A local model says it is done but changed nothing.** The model is not good at tool use. Try a
coding model (`qwen3-coder`, `gpt-oss`) and use **Try a model** on the Models page.

**A run stopped with "daily budget reached".** It continues automatically the next day, or when
you raise the budget and resume it.

**A push was refused.** Either the branch is protected, or the secret scan found something —
the step output lists the file, line and kind of secret.

**Tests fail for reasons unrelated to the change.** Set the right command with the `test_cmd`
variable, per repository in `<repo>/.claude-factory/config.yaml`.
