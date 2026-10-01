# Changelog

Changes that are merged but not yet in a release go under **Unreleased**. Newest first.

## Unreleased

- Gitflow: an issue is closed as soon as it is merged into `develop`.
- Gitflow: a feature branch is deleted on GitHub once it is merged into `develop`.
- Fix: a split is no longer skipped when a comment merely mentions the split marker; issues that depended on a split issue now wait for its parts.
- Coding agents may run the project's build and tests; `agent_env` passes settings such as `JAVA_HOME`.
- Gitflow pipeline (`issue-gitflow`, `release-daily`): a feature branch per issue merged into `develop`, parallel runs on different code areas, a daily release pull request `develop` → `main`, a size limit with automatic splitting.
- Too-big issues are split into new issues automatically when the split risk is low.
- One-label pipeline (`Factory_go`) with questions up front, a 0–100 risk score and a human check above 75.
- Flow-writing guide for AI assistants (`docs/FLOW_AUTHORING.md`, `factory flow-guide`).
