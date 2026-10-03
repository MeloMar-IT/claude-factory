# Lessons learned so far

What building and running Spaghetti Code Foundry has taught us, from the first commit
(27 September 2026) to early October 2026. In that week the Foundry went from a script that runs
one flow to a multi-user system that builds two repositories from their GitHub backlogs — one of
them its own.

This is a working document. Each lesson says what happened, what we changed, and the rule we
took from it. The design that came out of these lessons is in [DESIGN.md](DESIGN.md).

- [1. The short version](#1-the-short-version)
- [2. Stories and planning](#2-stories-and-planning)
- [3. Pipeline design](#3-pipeline-design)
- [4. Running several stories at once](#4-running-several-stories-at-once)
- [5. Branches and releases](#5-branches-and-releases)
- [6. Labels, state and GitHub](#6-labels-state-and-github)
- [7. Agents, logins and limits](#7-agents-logins-and-limits)
- [8. Speed](#8-speed)
- [9. Telling people what happens next](#9-telling-people-what-happens-next)
- [10. The Foundry building itself](#10-the-foundry-building-itself)
- [11. Tests](#11-tests)
- [12. Incidents](#12-incidents)
- [13. Still open](#13-still-open)

---

## 1. The short version

1. **The story is the bottleneck, not the code.** A clear, small story is built without help.
   A vague or big one costs questions, sent-back plans and merge conflicts.
2. **Fewer stages, fewer stops.** Every hand-over between stages is a place where work stands
   still. One label and one flow beat three labels and three flows.
3. **Ask people only what only people can decide** — and ask it up front, in one go.
4. **A score decides when a person is needed.** Most plans are safe to build; a 0–100 risk score
   sends only the risky ones to a person.
5. **Parallel work needs small stories, code-area locks and frequent merges** — all three.
6. **GitHub is slow to agree with itself.** Never act on a label you read a moment ago without
   asking again.
7. **A stopped run must say why, and what happens next, in plain words.** If the owner has to
   ask, the screen has failed.
8. **Every "do it again right away" needs a brake.** Immediate retries without a condition
   become endless loops.
9. **Shell steps do the facts, agents do the judgement.** Anything that can be checked by code
   is checked by code.
10. **A system that builds itself needs a way to notice its own faults.** Until it does, a person
    is its monitoring.

---

## 2. Stories and planning

**Big stories caused most of the trouble.** Stories that touched 30 files gave merge conflicts,
ran out of budget during planning, and blocked every other story in the same code. A story is
now limited (default: 15 files, 800 changed lines). A plan over the limit is split into smaller
issues with "Depends on" links.

- *Rule:* enforce the size in the flow; do not rely on people writing small stories.
- *Rule:* a low-risk split happens by itself; only a risky split waits for a person.

**Questions in the middle of the work are expensive.** A run that stops halfway to ask something
holds a branch that goes stale. The `epic-questions` flow now reads a whole batch of new issues
first and asks every question only the owner can answer, each with a recommendation. Replying
`/defaults` takes the recommendations.

**Plans were lost when the budget ran out.** Two plans were thrown away because the planning
agent hit its budget just before posting. Now shell steps still run after the budget is used,
so the draft is always posted, with the reviewer's notes.

**Not every plan needs a second opinion and a rewrite.** Review and revision of every plan cost
time for little gain. The plan is revised only when the review found something serious or the
risk is above 50.

**Dependencies must be written the same way everywhere.** "Depends on Story 7" did not match an
issue called "Website Story 7". The Foundry now matches `#N`, exact titles, contained titles,
and the story number within the same epic — and the split tool writes real issue numbers.

**Splitting changes what others depend on.** When an issue is split, stories that depended on it
started too early, because the original was closed. They now depend on the parts.

---

## 3. Pipeline design

**The first pipeline had three labels and stood still often.** Plan (label 1) → approve →
code (label 2) → pull request (label 3). Each step waited for a person or for another watcher's
next check. The second design has **one label** (`Factory_go`) and **one flow** that goes from
issue to merged code. A person is asked only when the risk score is above 75.

- *Rule:* count the hand-overs. Each one needs a reason.

**Keep both pipelines.** Some teams want a person at every stage. The human-in-the-loop pipeline
(`issue-plan` → `issue-code-daily` → `daily-pr`) is kept beside the gitflow one
(`epic-questions` → `issue-gitflow` → `release-daily`). Everything else was retired.

**Flows are generated, not hand-written.** With 40+ steps per flow, hand-edited YAML drifted.
`scripts/build-flows.mjs` builds every shipped flow from shared pieces, so a fix to "run the
tests and retry once" lands in every flow.

**A flow in use must not be deleted.** A watcher pointing at a missing flow fails silently at
its next check. Deleting a flow that a watcher uses is now refused.

**Two reviews are for risky changes only.** The second code review runs when the risk is above
50 or the first review found something serious.

---

## 4. Running several stories at once

Three stories at the same time on one repository gave merge conflicts nearly every time. The
cause was not one thing, so the fix was not either:

| Cause | What we did |
|---|---|
| Stories too big | Size limit and automatic split |
| Two stories in the same files | **Code-area locks**: a plan names its areas; a run claims them before coding |
| Branches living too long | Merge each finished story into `develop` at once |
| Files every story touches (the changelog) | Union merge: keep both sides |
| Locks that were too wide | Docs, Markdown files and whole test folders are not locked |

**Waiting must not hold a slot.** A run waiting for a code area used to sit in a slot doing
nothing. It now *steps aside*: it stops, frees the slot, and is resumed when the area is free.
(The first version of that resumed it far too eagerly — see [Incidents](#12-incidents).)

---

## 5. Branches and releases

**One rolling pull request per day did not scale.** While that pull request was open, no new
work could start, and nobody could tell why.

**Gitflow fits an automatic builder well:**

- Each story gets a `feature/…` branch from `develop`.
- A finished story is merged into `develop` right away, tests run on the result, and conflicts
  are resolved by an agent with the tests as the judge.
- Once a day `release-daily` opens one pull request from `develop` to `main`. A person merges it.
- An issue is closed when its work is merged, and feature branches are deleted after the merge.

**A dirty working tree breaks a merge silently.** A leftover file made `git checkout` fail, the
flow read that as "someone else pushed", and looped. Checkouts are now strict, leftovers are
committed first, and "moved" is only reported on a real rejection.

- *Rule:* in a shell step, never treat "the command failed" as one specific cause.

**A step that commits must accept "nothing to commit".**

---

## 6. Labels, state and GitHub

**Labels are the user interface on GitHub, so they must never lie.** We found issues that said
"working" with no run, closed issues still marked "needs attention", and waiting issues that
looked ready. The watcher now reconciles labels with the newest run at every check and tidies
closed issues.

**GitHub's list lags behind.** Right after a run finishes, the issue list can still show the old
labels. Acting on that started the same story twice. Before starting something a second time,
the watcher now asks GitHub for that one issue again.

**Order matters when two things must change.** Setting the label before starting the run left
issues stranded when the start failed. Start first, label second, and recover from leftovers.

**A marker in a comment is not proof.** An issue was treated as "already split" because a comment
merely mentioned the marker text. Markers are matched as whole lines of our own comments.

**GitHub has a request limit, and a busy watcher can use it up.** See
[Incidents](#12-incidents). Every loop that talks to GitHub is a risk.

**Plain label names.** `Factory_go`, `Factory_working`, `Factory_done`, `Factory_needs_info`,
`Factory_waiting`, `Factory_ERROR`. One label for people to set; the rest are set by the Foundry.

---

## 7. Agents, logins and limits

**The agent's environment must be clean.** A run started from inside another assistant session
inherited that session's variables, and the agent's login broke. Runs now strip host-session
variables before starting an agent.

**A lost login is not a failed run.** It pauses the work, says "signed out" in plain words, and
resumes by itself after the user signs in again.

**Limits come in many wordings.** "Usage limit", "session limit", "weekly limit", "model is at
capacity". Each new wording first showed up as an unexplained failure. Limits pause and retry;
capacity errors retry after 1 and 3 minutes.

**Desktop apps move their files.** An update of the Claude desktop app changed where the
bundled command-line tool lives. The Foundry now searches for it instead of assuming a path.

**Agents need the tools the project needs.** Coding agents could not run the build because the
build tool was not on their allowed list. They now get the common build and test tools, and
read-only git.

**Fixed-price subscriptions make dollar budgets misleading.** Costs are still recorded and
shown, but can be switched off as a limit (`cost_limits: false`).

**A false positive in a safety check stops everything.** The secret scan blocked a push because
of a line that only *looked* like the start of a private key. A check that blocks work must be
precise.

---

## 8. Speed

We measured where a story's time went. Most of it was not the agents thinking:

| Where the time went | What we did |
|---|---|
| Waiting for the watcher's next check | When a run ends, the watcher checks at once |
| Waiting for a code area | Step aside; narrower locks |
| Reviews and revisions on safe plans | Only when risk or findings call for it |
| Installing dependencies before every test run | Cached by the lock file's hash |
| A flaky test failing a whole run | Baseline and post-merge tests run once more on failure |

- *Rule:* if no person is needed, the next step starts right away.
- *Rule:* measure before speeding up; the slow part was waiting, not working.

---

## 9. Telling people what happens next

In a few days the owner had to ask "why is it stuck?" about fifteen times. Every answer existed —
in a log, on GitHub, in the watcher's memory — but not on the screen. That became an epic of its
own, and these are its lessons:

- **One sentence per story: who acts next, and what.** "Waits for #15, which waits for your
  decision on its plan" is better than a status word.
- **One page with only what waits for you** (*Your turn*), one button each, with a count in the
  navigation.
- **Say the root cause.** If A waits for B and B waits for you, A's text names *you*.
- **Say when nothing is needed.** "Nothing — it continues by itself" stops people from poking.
- **A wrong message is worse than none.** "Check that gh is logged in" was shown when the real
  cause was a request limit.
- **One vocabulary** in the app, on GitHub and in labels.
- **Notify only when the person is the blocker.**

---

## 10. The Foundry building itself

Since October the Foundry builds its own features from its own backlog (accounts and sign-in,
*Your turn*, the board, the health line and estimates were built this way).

**What works**

- The same gitflow as any repository: stories land on `develop`, a daily release goes to `main`.
- The server restarts itself on a new build, but only when no run is active.
- Changes made by hand go in as **hotfixes**: commit on `main`, merge `main` into `develop`.

**What to watch**

- **Old server, new flow.** A running server with yesterday's code and today's flow files
  stranded issues. The flow and the code that runs it must change together.
- **A bug in the builder blocks its own fix.** When flaky tests failed every story's baseline,
  no story could run — including one that would fix the tests. That is why a hand-made hotfix
  path must always exist.
- **Stories about security wait for a person** (`Factory_review_plan`), also when the Foundry
  is its own customer.
- **The repository is public.** Stories, logs and documents must not carry names, paths or
  secrets from other work.

---

## 11. Tests

- **No test uses a real service.** Fake `claude`, `codex` and `gh` programs and a local git
  remote make whole flows testable in seconds.
- **Tests must not depend on the machine being quiet.** Tests that expected an event "within
  two seconds" failed when several stories ran their tests at once — and because every story
  runs the test suite first, flaky tests stopped all work.
- **A test's environment must be clean**, like an agent's: variables from the surrounding
  session changed results.
- **The documents are tested too.** The flow examples in the authoring guide are validated, and
  the error messages listed in the user guide must match the code.

---

## 12. Incidents

| What happened | Cause | Fix | Lesson |
|---|---|---|---|
| Issues stuck with a "planning" label | Old server code with a new flow | Start the run before labelling; recover leftovers | Change code and flows together |
| Plans lost | Budget used up before posting | Shell steps run past the budget | Save work before spending the last cent |
| A story started twice | GitHub's list lagged | Ask again for that one issue | Never trust a list you read a moment ago |
| Agent login expired | Variables inherited from another session | Clean environment; pause on sign-out | Isolate what you start |
| Every baseline failed | Flaky timing tests under load | Tests no longer depend on timing | A flaky test is an outage in a self-building system |
| Merge loop | Dirty tree read as "branch moved" | Strict checkout; commit leftovers | One failure, one cause |
| All watchers failed for an hour | Runs that stepped aside were restarted every 25 seconds (600+ times) and used up GitHub's request limit | Resume only when the blocking run has stopped; no immediate check after a step-aside | Every "retry right away" needs a condition |

The last incident is the reason for the self-repair work: nothing reported the loop until
everything stopped, and the message on screen pointed at the wrong cause.

---

## 13. Still open

- **Self-monitoring.** A monitor that finds such problems, writes a bug story, and gets it fixed
  first, with hotfixes to `main` the gitflow way.
- **Refinement.** Helping people write good stories before they reach the backlog — as an
  architect who asks and checks, not as an author.
- **More than one machine.** Today agents and logins are those of one Mac.
- **E-mail** for password resets and notifications, and **per-user agent accounts**.
- **The running install does not yet take a hotfix by itself.**
