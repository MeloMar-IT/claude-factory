# Changelog

Changes that are merged but not yet in a release go under **Unreleased**. Newest first.

## Unreleased

- The web UI, the app's own messages (CLI help and banner, notifications, the push-protection message, label descriptions, the failure comment on issues) and the docs say "Spaghetti Code Foundry". Label names, folders, branch names and the hidden `<!-- claude-factory` marker stay as they are.

- New command `scf` (Spaghetti Code Foundry) and package name `spaghetti-code-foundry`; `factory` keeps working and prints a short note. Settings work as `SCF_…` or `FACTORY_…` (`SCF_…` wins); steps and notify commands get every `FACTORY_…` variable also as `SCF_…`. The login service is now `com.spaghetti-code-foundry.server` — run `scf service install` once to replace the old one; if that fails, the old service is put back.

- Comments and pull requests from the issue pipelines say "Spaghetti Code Foundry" (PR titles "Foundry: #…"). Both the old `<!-- claude-factory` and the new `<!-- spaghetti-code-foundry` markers are recognised, so approvals, answers and splits work with comments from before and after the rename; new comments still carry the old marker.
- Fix: a split is no longer skipped when a comment merely mentions the split marker; issues that depended on a split issue now wait for its parts.
- Coding agents may run the project's build and tests; `agent_env` passes settings such as `JAVA_HOME`.
- Gitflow pipeline (`issue-gitflow`, `release-daily`): a feature branch per issue merged into `develop`, parallel runs on different code areas, a daily release pull request `develop` → `main`, a size limit with automatic splitting.
- Too-big issues are split into new issues automatically when the split risk is low.
- One-label pipeline (`Factory_go`) with questions up front, a 0–100 risk score and a human check above 75.
- Flow-writing guide for AI assistants (`docs/FLOW_AUTHORING.md`, `factory flow-guide`).
