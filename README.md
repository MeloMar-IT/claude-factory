# Spaghetti Code Foundry

An AI coding factory that runs on your own machine. Put one label on a GitHub issue, and the
Foundry asks the open questions, plans, codes, tests, reviews and merges the story — and asks
you only when it has to.

Formerly **claude-factory**. The command is now `scf` (`factory` still works), the repository is [MeloMar-IT/spaghetti-code-foundry](https://github.com/MeloMar-IT/spaghetti-code-foundry) and the data folder is `~/.spaghetti-code-foundry`. The `<repo>/.claude-factory` folder, the labels (`claude-factory`, `factory:*`) and `factory/…` branches keep the old name.

![Your turn: only what waits for you](docs/images/your-turn.png)

Work is described as **flows**: YAML pipelines of agent steps (Claude Code or OpenAI's Codex
CLI), shell steps, approvals and branches. The Foundry runs them headlessly — from a GitHub
issue that gets a label, a task you type, a red CI build, or a schedule.

## What it does

- **From issue to merged code, hands-off.** One label (`Factory_go`) on an issue or a whole
  epic. The Foundry asks its questions up front, then builds each story in dependency order:
  plan, review of the plan, code, tests, code review, docs, merge.
- **A person only where a person is needed.** Every plan gets a risk score from 0 to 100; above
  75 you approve it first. Stories that are too big are split into smaller ones.
- **Always clear what happens next.** *Your turn* lists only what waits for you, one button
  each. The *Board* shows where every story is and why. A health line says when something is
  wrong with the Foundry itself.
- **Several stories at once.** Runs lock the parts of the code they change, so stories in
  different areas are built in parallel without merge conflicts.
- **Gitflow.** Each story on its own feature branch, merged into `develop` when it is done;
  one pull request a day from `develop` to `main` for you to merge.
- **Two agents, any model.** Steps run on Claude Code or Codex, on Anthropic, OpenAI or local
  models (Ollama, LM Studio). One vendor's model reviews the other's work. Routing rules pick
  the model per step, with fallbacks when a model hits a limit.
- **Your own flows.** Edit them visually or as YAML, reuse steps from a block library, or have
  any AI assistant write one.
- **Accounts and roles.** An admin makes flows, watchers and settings. Users run the flows the
  admin published, on their own repositories, and see only their own runs.
- **Safe by default.** Every run works in its own copy of the code. Pushes to protected
  branches and pushes that contain secrets are blocked. Approval steps, optional budgets,
  optional sandboxing (Claude Code's sandbox or Docker).
- **See everything.** Live logs, readable transcripts of every agent step, diffs, a dashboard,
  and resume, retry and approve buttons.

![The board: where every story is, and why](docs/images/board.png)

## Requirements

- Node.js 20 or newer and git
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), logged in
- [GitHub CLI](https://cli.github.com) (`gh`), logged in, for the GitHub flows
- Optional: [Codex CLI](https://developers.openai.com/codex) for Codex steps (the shipped flows
  use it for reviews), [Ollama](https://ollama.com) or LM Studio for local models, Docker for
  sandboxed test runs

Built and used on macOS.

## Install

```bash
git clone https://github.com/MeloMar-IT/spaghetti-code-foundry.git
cd spaghetti-code-foundry
npm install
npm run build
npm link            # gives the scf command (factory still works)
# or: ln -s "$PWD/dist/cli.js" ~/.local/bin/scf
#     ln -s "$PWD/dist/factory.js" ~/.local/bin/factory   # optional old name
```

If you linked the old name before, run `npm rm -g claude-factory` first.

**Already have a clone?** The repository was renamed from `MeloMar-IT/claude-factory`. GitHub
redirects the old address, but point your clone at the new one:

```bash
git remote set-url origin https://github.com/MeloMar-IT/spaghetti-code-foundry.git
# SSH: git remote set-url origin git@github.com:MeloMar-IT/spaghetti-code-foundry.git
git remote -v    # check
```

The folder of your clone can keep its name.

## Quick start

**1. Start it.**

```bash
scf ui      # web UI at http://localhost:4777
```

The first visit asks you to create the admin account. After that you sign in.

**2. Let it build your GitHub issues.** In the UI, open **Watchers** → **Add watcher**: your
repository (`owner/repo`), the flow `issue-gitflow` and the label `Factory_go`. Your repository
needs a `develop` branch; the Foundry creates it from `main` when it is missing.

**3. Put the label `Factory_go` on an issue.** Then watch **Your turn**: questions and risky
plans show up there. Everything else continues by itself, and once a day you get one pull
request from `develop` to `main`.

**Or run one flow by hand**, on a local repository:

```bash
cd ~/code/my-project
scf new my-flow                 # a small flow: implement, test, fix
scf run my-flow --task "Add a --json flag to the export command" --var test_cmd="npm test"
```

The run happens in a fresh worktree on a `factory/<run-id>` branch — your checkout is not
touched. Look at the result in the UI (Runs → the run → Changes) and merge the branch if you
like it.

To keep it running after you close the terminal: `scf service install`.

## Built-in flows

| Flow | What it does |
|---|---|
| `epic-questions` → `issue-gitflow` → `release-daily` | **Gitflow pipeline** (one label, `Factory_go`): questions up front; per issue a plan (risk gate, size limit with automatic splitting) and code on a feature branch, merged into `develop` by the Foundry — in parallel for different code areas; once a day one PR `develop` → `main` |
| `issue-plan` → `issue-code-daily` → `daily-pr` | **Human-in-the-loop pipeline** (two labels): the plan is posted first and you approve every plan (`Factory_code`) before any code is written; a daily PR, and no new coding while it is open |

Write your own flows in the editor or with any AI assistant ([FLOW_AUTHORING.md](docs/FLOW_AUTHORING.md)); `scf new <name>` starts from a small template. A flow that a watcher uses (also a disabled one) can't be deleted.

![The flow editor](docs/images/flows.png)

## Documentation

| Document | What it is |
|---|---|
| **[User guide](docs/USER_GUIDE.md)** | Everything, with screenshots: Your turn and the board, running and resuming flows, writing flows, watchers and labels, models and routing, accounts, safety, costs, the command line, troubleshooting |
| **[Design](docs/DESIGN.md)** | How the Foundry is built and why, with diagrams |
| **[Lessons learned](docs/LESSONS_LEARNED.md)** | What building and running it taught us, including the incidents |
| **[Flow authoring](docs/FLOW_AUTHORING.md)** | The complete flow format. Give it to any AI assistant (or use `scf flow-guide`), describe the flow you want, and check the result with `scf validate` |
| **[Changelog](docs/CHANGELOG.md)** | What changed |

## Development

The Foundry builds itself: its stories are GitHub issues in this repository, built with the
gitflow pipeline. `develop` holds the newest work; `main` is released once a day.

```bash
npm run build     # compile TypeScript to dist/
npm test          # vitest; uses fake claude, codex and gh CLIs — no network, no cost
npm run dev -- run my-flow --task "…"   # run the CLI from source
```

The shipped flows are generated: edit `blocks/*.yaml` or `scripts/build-flows.mjs`, then run
`node scripts/build-flows.mjs`. Never edit `flows/*.yaml` by hand. See [CLAUDE.md](CLAUDE.md)
for the rules coding agents follow in this repository.

## License

[MIT](LICENSE)
