# claude-factory — notes for coding agents

An AI coding factory: YAML **flows** of agent steps (Claude Code / Codex CLI) and shell steps, run
headlessly against git repositories, with a web UI and GitHub watchers. Node.js + TypeScript (ESM),
no frameworks. This repository is **public** — never commit private data, paths or secrets.

## Commands

```bash
npm ci                 # install
npm run build          # TypeScript → dist/ (the CLI runs from dist/)
npm test               # vitest; ~40 s; must pass before anything is committed
node scripts/build-flows.mjs   # regenerate flows/*.yaml (see below)
```

## Layout

| Path | What |
|---|---|
| `src/engine/` | Runs a flow: steps, jumps, budgets, resume (`runner.ts`, `execute.ts`, `state.ts`) |
| `src/steps/` | Step runners: `claude.ts` (Claude Code CLI), `codex.ts`, `shell.ts` |
| `src/agents/` | Picking agent/provider/model, fallbacks on limits |
| `src/flow/` | Flow schema (zod) and loading; `blocks.ts` for the block library |
| `src/queue/` | Scheduler (concurrency, locks), GitHub watchers, dependencies |
| `src/server/` | HTTP API (`api-*.ts`) and the server; the UI calls it |
| `ui/` | Web UI: plain JavaScript modules, no build step, no framework |
| `flows/` | Built-in flows — **generated**, do not edit by hand |
| `blocks/` | Reusable step blocks (YAML) |
| `tools/` | Helper scripts the flows call (`$FACTORY_TOOLS/…`) |
| `scripts/build-flows.mjs` | Generates `flows/*.yaml` from `blocks/` and code |
| `docs/` | `USER_GUIDE.md`, `FLOW_AUTHORING.md` (flow format for AI assistants), `CHANGELOG.md` |
| `tests/` | vitest; `tests/fixtures/` has fake `claude`, `codex` and `gh` |

## Rules

- **Never edit `flows/*.yaml` directly.** Change `scripts/build-flows.mjs` (or `blocks/`), run
  `node scripts/build-flows.mjs`, and commit both.
- **Tests never use real services.** They use the fakes in `tests/fixtures/` (fake `claude`, `codex`,
  `gh` on PATH, a bare git repo as the remote). Extend the fakes when a flow needs a new call.
  `tests/setup.ts` gives every test run a temporary data folder — never read or write the real
  `~/.claude-factory`.
- Every change comes with tests, and `npm run build && npm test` passes.
- **Every API route needs a rule** in `src/server/permissions.ts` and an example in
  `tests/permissions.test.ts`.
- **Add a line to `docs/CHANGELOG.md`** (under "Unreleased") for every change, and update
  `docs/USER_GUIDE.md` when behaviour users see changes. If the flow format changes, update
  `docs/FLOW_AUTHORING.md` too — `tests/guide.test.ts` checks its examples.
- No new dependencies unless the issue asks for one.
- Security rules: enforce permissions on the server; never put untrusted text (issue text, step
  output, task) into shell commands — use the `$FACTORY_…` environment variables; secrets never
  appear in API responses, logs or agent environments.
- Keep backward compatibility for existing installs (config, runs, flows, watchers, the markers in
  GitHub comments such as `<!-- claude-factory run=… -->`).
- Plain, short English in user-facing text and docs.
