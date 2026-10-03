# Usability check: "what happens next?"

Goal: the owner can say what to do next, from the screen alone, within 10 seconds.

## How to run it

- One person shows the screens, the owner answers. Do not explain anything first.
- Show one screen at a time (the title, the action line and the why line, as on **Your turn**).
- Ask: **"What do you do next?"** Start a clock. Write down the seconds and whether the answer was right.
- Use the answer key at the end only after all five are done.

## The five screens

**1.** Title: `Story 42`
- Action: `Answer 1 question`
- Why: `It has questions before it starts`

**2.** Title: `Story 43`
- Action: `Reply /approve or /reject`
- Why: `The plan is risky and waits for your decision`

**3.** Title: `Story 44`
- Action: `Look at the output of the step and fix the cause, then remove the `factory:failed` label to start over`
- Why: `The step baseline_failed failed: its command ended with an error`

**4.** Title: `Story 45`
- Action: `Nothing — it continues by itself`
- Why: `The usage limit is reached`

**5.** Title: `Story 55`
- Action: `Sign in again: run "claude" in a terminal and type /login`
- Why: `Claude Code is signed out (its login has expired)`

## Result

| # | Seconds | Right / wrong | Note |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

It passes when all five are right within 10 seconds. Write down every miss.

## Answer key

1. Answer the question on the issue (or reply `/defaults`).
2. Reply `/approve` or `/reject` on the issue.
3. Fix the cause, then remove the `factory:failed` label (or resume the run).
4. Nothing. It is tried again after the limit resets.
5. Sign in again to Claude Code.

## Where each scenario comes from

All scenarios of the automated test (`tests/helpers/scenarios.ts`). Epic #31 could not be read when they were written; add its cases there as new entries.

| Id | Real case | Source |
|---|---|---|
| `questions` | The Foundry asks questions before it builds an issue | issue #42 (Q1 comment) |
| `approve-plan` | A risky plan waits for the owner's decision | issue #42 (plan with risk gate) |
| `failed-baseline` | The tests already fail before any change, so the run stops | issue #42 (baseline_failed, Factory_ERROR comment) |
| `session-limit` | The session limit pauses the run until it resets | changelog (hotfix: session limit pauses like a usage limit) |
| `signed-out` | The agent is signed out; the owner has to sign in again | changelog (hotfix: pause when the agent is signed out) |
| `closed-while-working` | An issue is closed on GitHub while its run is still working | changelog (hotfix: issues closed on GitHub) |
| `interrupted` | The server restarted during a run | kind only |
| `watcher-error` | A watcher cannot reach GitHub | issue #56 (cannot access … with gh) |
| `working` | A story is being built | kind only |
| `release-schedule` | Finished work waits for the scheduled release | kind only |
| `release-pr` | The release pull request waits to be merged | kind only |
| `waits-for-stories` | A story waits for three stories that wait for the owner | issue #21 and its blockers (#61, #11, #64) |
| `approval-by-hand` | A run started by hand waits for approval | kind only |
| `daily-budget` | The daily budget is used up | kind only |

## Where to record the result

In the follow-up issue "Next step 11b — Usability check with the owner: 5 scenarios, 10 seconds each" (no `Factory_go` label). The Foundry could not open it; open it with this link, then post the filled-in table there:

<https://github.com/MeloMar-IT/spaghetti-code-foundry/issues/new?title=Next%20step%2011b%20%E2%80%94%20Usability%20check%20with%20the%20owner%3A%205%20scenarios%2C%2010%20seconds%20each&body=Epic%3A%20%2331.%20Follow-up%20of%20%2342.%20Run%20the%20check%20in%20%60docs%2FUSABILITY_CHECK.md%60%20and%20post%20the%20filled-in%20table%20here.%0A%0A-%20%5B%20%5D%20All%205%20done%2C%20each%20with%20time%20and%20answer%0A-%20%5B%20%5D%20Every%20miss%20has%20a%20note>
