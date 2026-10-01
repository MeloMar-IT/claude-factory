# Changelog

Changes that are merged but not yet in a release go under **Unreleased**. Newest first.

## Unreleased

- Commits from the ticket, chore and ci-fix flows end with "Automated by Spaghetti Code Foundry (run …)", commits from the cross-review flow end with "Written by Claude, reviewed by Codex (Spaghetti Code Foundry run …)", and the plan and result comments on Jira and Linear say "Spaghetti Code Foundry". The subject lines ("Resolve #N", "Fix CI", "factory: …") stay as they are.
- Comments from the ticket flows (`github-issue`, `github-pr`, `github-auto`) say "Spaghetti Code Foundry": questions, plan, approval request, result and split. The hidden `<!-- claude-factory run=… -->` marker and the `claude-factory` label stay.
- The web UI, the app's own messages (CLI help and banner, notifications, the push-protection message, label descriptions, the failure comment on issues) and the docs say "Spaghetti Code Foundry". Label names, folders, branch names and the hidden `<!-- claude-factory` marker stay as they are.
- The data folder is now `~/.spaghetti-code-foundry` (`SCF_HOME`, else `FACTORY_HOME`, still win). On the first start of any `scf` command except help, `~/.claude-factory` is copied there in one step (config, runs, flows, blocks, learnings, queue, locks, evals) and kept as a backup with a note file `MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt`. Paths into the old folder in copied `*.json` files and in `config.yaml` are rewritten, and run worktrees are repaired with `git worktree repair`. The move waits while a run is running (runs now record their `pid`), space is short or the folder is busy, and is tried again on later starts and every minute by an idle server; any failure leaves everything as it was. A server on the old folder refuses changes after the move and restarts onto the new one. If the note exists but the new folder is missing, `scf` refuses to run and says how to recover. `scf service status` and `tools/area-lock` follow the new folder; run `scf service install` once. See "Upgrading from claude-factory" in the user guide.

- New command `scf` (Spaghetti Code Foundry) and package name `spaghetti-code-foundry`; `factory` keeps working and prints a short note. Settings work as `SCF_…` or `FACTORY_…` (`SCF_…` wins); steps and notify commands get every `FACTORY_…` variable also as `SCF_…`. The login service is now `com.spaghetti-code-foundry.server` — run `scf service install` once to replace the old one; if that fails, the old service is put back.

- Comments and pull requests from the issue pipelines say "Spaghetti Code Foundry" (PR titles "Foundry: #…"). Both the old `<!-- claude-factory` and the new `<!-- spaghetti-code-foundry` markers are recognised, so approvals, answers and splits work with comments from before and after the rename; new comments still carry the old marker.
- A server waiting to restart on a new version stops starting new runs, so it restarts once the active ones are done.
- Dependencies named by a shortened title ("Story 7 — …" for "Website Story 7 — …") are found.
- Gitflow: an issue is closed as soon as it is merged into `develop`.
- Gitflow: a feature branch is deleted on GitHub once it is merged into `develop`.
- Fix: a split is no longer skipped when a comment merely mentions the split marker; issues that depended on a split issue now wait for its parts.
- Coding agents may run the project's build and tests; `agent_env` passes settings such as `JAVA_HOME`.
- Gitflow pipeline (`issue-gitflow`, `release-daily`): a feature branch per issue merged into `develop`, parallel runs on different code areas, a daily release pull request `develop` → `main`, a size limit with automatic splitting.
- Too-big issues are split into new issues automatically when the split risk is low.
- One-label pipeline (`Factory_go`) with questions up front, a 0–100 risk score and a human check above 75.
- Flow-writing guide for AI assistants (`docs/FLOW_AUTHORING.md`, `factory flow-guide`).
