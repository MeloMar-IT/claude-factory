import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { githubKey, tryParseRepoUrl } from "./auth/repo-url.js";
import type { SelfUpdateConfig } from "./config.js";
import { redactText } from "./credentials/redact.js";
import { cleanLine } from "./errors.js";
import {
  branchOf, DEFAULT_STEPS, foundryDir, git, headOf, isClean, killSteps, loadUpdateState, readVersion, rollBack, runStep, short, updateFile, updateState,
  type FailStage, type UpdateStep,
} from "./self-update-state.js";
import { buildStamp, RESTART_CODE } from "./supervise.js";

export const CHECK_EVERY_MS = 300_000;

export type UpdateReason = "broken_state" | "needs_repair" | "not_git" | "unsupervised" | "wrong_repo" | "unreachable"
  | "not_main" | "local_changes" | "no_fast_forward" | "failed_before" | "building" | "runs";

export interface UpdateView {
  version?: { commit: string; date: string };
  update?: { waiting: boolean; commit?: string; text: string };
}

export interface UpdaterOptions {
  config: () => SelfUpdateConfig;
  /** The queue only. */
  idle: () => boolean;
  /** Called once, when a tested update waits: no new runs start. */
  drain: () => void;
  beforeExit: () => void;
  log: (m: string) => void;
  // for tests:
  dir?: string;
  file?: string;
  steps?: UpdateStep[];
  originRepo?: (url: string) => string | undefined;
  redact?: (text: string) => string;
  guarded?: boolean;
  exit?: (code: number) => void;
  everyMs?: number;
  checkEveryMs?: number;
}

type Check =
  | { kind: "none" }
  | { kind: "blocked"; reason: UpdateReason; commit?: string }
  | { kind: "stage"; commit: string }
  | { kind: "ready"; commit: string; head: string };

const STAGE_TEXT: Record<FailStage, string> = {
  install: "its install failed",
  build: "its build failed",
  test: "its tests failed",
  apply: "it could not be installed",
  start: "it did not start healthy",
};

/** Checks main of the Foundry's own repository and, when it is safe, builds, tests and installs it, then restarts. */
export class SelfUpdater {
  private dir: string;
  private file: string;
  private steps: UpdateStep[];
  private version: UpdateView["version"];
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;
  private working = false;
  private stopped = false;
  private drained = false;
  private lastCheck = 0;
  private lastLogged = "";
  private update: UpdateView["update"];

  constructor(private o: UpdaterOptions) {
    this.dir = o.dir ?? foundryDir();
    this.file = o.file ?? updateFile();
    this.steps = o.steps ?? DEFAULT_STEPS;
    this.version = readVersion(this.dir);
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    killSteps();
  }

  /** A step runs (staging or install): other restarts wait. */
  busy(): boolean {
    return this.working;
  }

  view(): UpdateView {
    return { ...(this.version ? { version: this.version } : {}), ...(this.update ? { update: this.update } : {}) };
  }

  /** One round. Never throws; one at a time. `force`: check now, not only every few minutes. */
  tick(force = false): Promise<void> {
    return (this.inflight ??= this.round(force).catch((e) => this.say(`self-update: stopped by an unexpected error (${cleanLine(String((e as Error)?.message ?? e)).slice(0, 120)})`)).finally(() => { this.inflight = undefined; }));
  }

  private say(m: string) {
    try {
      this.o.log(m);
    } catch {
      // a log that fails must not stop the update
    }
  }

  private async round(force: boolean): Promise<void> {
    if (this.stopped) return;
    const cfg = this.o.config();
    if (!cfg.enabled || !cfg.repo) {
      this.update = undefined;
      // switched off while it waited to restart: finish the drain on the unchanged version once the active runs are done
      if (this.drained && this.o.idle()) this.leave();
      return;
    }
    // a tested update waits for the runs: nothing to look at until the queue is idle
    if (this.drained && !this.o.idle()) return;
    const now = Date.now();
    if (!force && !this.drained && now - this.lastCheck < (this.o.checkEveryMs ?? CHECK_EVERY_MS)) return;
    this.lastCheck = now;

    const res = await this.check(cfg.repo);
    if (this.stopped) return;
    if (!this.o.config().enabled) return this.set(undefined); // switched off while it looked: the next round cleans up
    if (res.kind === "none") this.set(undefined);
    else if (res.kind === "blocked") this.block(res.reason, res.commit);
    if (res.kind === "stage") {
      this.set({ waiting: true, commit: res.commit, text: this.text("building", res.commit) });
      this.lastLogged = `building|${res.commit}`;
      this.say(`self-update: building and testing ${short(res.commit)}`);
      const ok = await this.stage(res.commit);
      if (this.stopped) return;
      if (!this.o.config().enabled) return this.set(undefined); // switched off while it built: no drain
      if (ok) this.waitForRuns(res.commit);
      else this.block("failed_before", res.commit);
      if (ok && !this.drained) {
        this.drained = true;
        this.say(`self-update: ${short(res.commit)} is tested; no new runs start, and it is installed when the active runs are done`);
        this.o.drain();
      }
      return;
    }
    if (res.kind === "ready") {
      if (!this.drained) {
        this.drained = true;
        this.say(`self-update: ${short(res.commit)} is tested; no new runs start, and it is installed when the active runs are done`);
        this.o.drain();
      }
      if (!this.o.idle()) return this.waitForRuns(res.commit);
      return this.install(res.commit, res.head, cfg.repo);
    }
    // nothing to install now: a drain that was announced has to end
    if (this.drained && this.o.idle()) this.leave();
  }

  private waitForRuns(commit: string) {
    this.set({ waiting: true, commit, text: this.text("runs", commit) });
  }

  private set(u: UpdateView["update"]) {
    this.update = u;
    if (!u) this.lastLogged = "";
  }

  private block(reason: UpdateReason, commit?: string) {
    const { state } = loadUpdateState(this.file);
    const text = this.text(reason, commit, state.failed);
    this.update = { waiting: ["not_main", "local_changes", "no_fast_forward", "failed_before", "building", "runs"].includes(reason), ...(commit ? { commit } : {}), text };
    const key = `${reason}|${commit ?? ""}`;
    if (key !== this.lastLogged) this.say(`self-update: ${text}`);
    this.lastLogged = key;
  }

  private text(reason: UpdateReason, commit?: string, failed?: { commit: string; stage: FailStage; back?: string }): string {
    const sha = commit ? short(commit) : "";
    const repo = this.o.config().repo ?? "";
    switch (reason) {
      case "broken_state": return "Self-update is stopped: self-update.json in the data folder could not be read. Check the checkout (git status, git log), then delete the file.";
      case "needs_repair": {
        const f = failed ?? loadUpdateState(this.file).state.failed;
        return `Self-update is stopped: the update to ${f ? short(f.commit) : "a new version"} failed and the Foundry could not go back to ${f?.back ? short(f.back) : "the version before it"}. Repair the checkout by hand (git status, npm ci, npm run build), then delete self-update.json in the data folder.`;
      }
      case "not_git": return "Self-update does nothing: the Foundry does not run from a git checkout.";
      case "unsupervised": return "Self-update does nothing: stop and start the Foundry once, so that it can go back after a bad update.";
      case "wrong_repo": return `Self-update does nothing: the origin of the checkout is not ${repo}.`;
      case "unreachable": return "Self-update does nothing: main could not be read from GitHub.";
      case "not_main": return `An update is waiting (${sha}): the checkout is not on main.`;
      case "local_changes": return `An update is waiting (${sha}): the checkout has local changes.`;
      case "no_fast_forward": return `An update is waiting (${sha}): the checkout has commits that are not on main.`;
      case "building": return `An update is waiting (${sha}): it is being built and tested.`;
      case "runs": return `An update is waiting (${sha}): it is installed when the active runs are done.`;
      case "failed_before": {
        const f = failed ?? loadUpdateState(this.file).state.failed;
        const x = f?.stage === "start" ? `it did not start healthy and the Foundry went back to ${f.back ? short(f.back) : "the previous version"}` : STAGE_TEXT[f?.stage ?? "install"];
        return `An update is waiting (${sha}): ${x}. The Foundry waits for a newer commit on main.`;
      }
    }
  }

  /** The whole check, in order. Nothing is fetched before the checkout is known to be on main, clean and at the right origin. */
  private async check(repo: string): Promise<Check> {
    const { state, broken } = loadUpdateState(this.file);
    const blocked = (reason: UpdateReason, commit?: string): Check => ({ kind: "blocked", reason, ...(commit ? { commit } : {}) });
    if (broken) return blocked("broken_state");
    if (state.failed?.backOk === false) return blocked("needs_repair");
    if (!this.version) return blocked("not_git");
    if (!(this.o.guarded ?? process.env.FACTORY_START_GUARD === "1")) return blocked("unsupervised");
    const origin = await git(this.dir, ["remote", "get-url", "origin"]);
    const name = origin.ok ? (this.o.originRepo ?? ((u: string) => tryParseRepoUrl(u)?.github))(origin.out) : undefined;
    if (!name || githubKey(name) !== githubKey(repo)) return blocked("wrong_repo");

    const ls = await git(this.dir, ["ls-remote", "origin", "refs/heads/main"]);
    const tip = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec(ls.out)?.[1];
    if (!ls.ok || !tip) {
      this.say(`self-update: main could not be read (${this.safe(ls.out).slice(0, 200) || "no answer"})`);
      return blocked("unreachable");
    }
    const head = await headOf(this.dir);
    if (!head) return blocked("not_git");
    if (tip === head) return { kind: "none" };
    if ((await branchOf(this.dir)) !== "main") return blocked("not_main", tip);
    if (!(await isClean(this.dir))) return blocked("local_changes", tip);
    if (state.failed?.commit === tip) return blocked("failed_before", tip);

    const fetched = await git(this.dir, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const got = fetched.ok ? await git(this.dir, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]) : undefined;
    if (!got?.ok || !/^[0-9a-f]{40}$/.test(got.out)) {
      this.say(`self-update: main could not be fetched (${this.safe(fetched.out).slice(0, 200)})`);
      return blocked("unreachable");
    }
    const commit = got.out; // what was fetched is what is tested and installed (main may have moved since ls-remote)
    if (commit === head) return { kind: "none" };
    if (state.failed?.commit === commit) return blocked("failed_before", commit);
    if (!(await git(this.dir, ["merge-base", "--is-ancestor", head, commit])).ok) return blocked("no_fast_forward", commit);
    return state.tested?.commit === commit ? { kind: "ready", commit, head } : { kind: "stage", commit };
  }

  private safe(text: string): string {
    try {
      return cleanLine((this.o.redact ?? redactText)(text));
    } catch {
      return "the output is not shown";
    }
  }

  /** The last 5 non-empty lines of a step's output, redacted first. */
  private lines(output: string): string[] {
    try {
      const text = (this.o.redact ?? redactText)(output);
      return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-5).map((l) => cleanLine(l).slice(0, 300));
    } catch {
      return ["the output is not shown"];
    }
  }

  private stageDir(): string {
    return join(dirname(this.file), "self-update-stage");
  }

  private async cleanStage() {
    const dir = this.stageDir();
    await git(this.dir, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
    await git(this.dir, ["worktree", "prune"]);
  }

  /** Builds and tests `commit` in a separate worktree. True: it passed and `tested` is written. */
  private async stage(commit: string): Promise<boolean> {
    this.working = true;
    try {
      updateState((s) => { s.tested = undefined; }, this.file);
      await this.cleanStage(); // a leftover of a server that was stopped while it built
      const fail = (stage: FailStage, output: string) => {
        const lines = this.lines(output);
        updateState((s) => { s.failed = { commit, stage, lines, at: new Date().toISOString() }; }, this.file);
        this.say(`self-update: ${short(commit)} failed at ${stage}: ${lines.join(" | ")}`);
        return false;
      };
      const added = await git(this.dir, ["worktree", "add", "--detach", this.stageDir(), commit]);
      if (!added.ok) return fail("install", added.out);
      for (const name of ["install", "build", "test"] as const) {
        const step = this.steps.find((s) => s.name === name);
        if (!step) continue;
        const r = await runStep(step, this.stageDir());
        if (r.killed || this.stopped) return false;
        if (!r.ok) return fail(name, r.output);
      }
      updateState((s) => {
        s.tested = { commit, at: new Date().toISOString() };
        s.failed = undefined;
      }, this.file);
      return true;
    } finally {
      try {
        await this.cleanStage();
      } catch {
        // the next staging removes what is left
      }
      this.working = false;
    }
  }

  /** Ends a drain without an update: the server restarts so that its watchers start again. */
  private leave() {
    this.say("self-update: nothing to install; restarting to start the watchers again");
    this.o.beforeExit();
    (this.o.exit ?? process.exit)(RESTART_CODE);
  }

  /** The reason when something the check relied on is no longer true: setting, origin, branch, changes, HEAD, the commit itself. */
  private async changed(commit: string, head: string, repo: string): Promise<UpdateReason | undefined> {
    const cfg = this.o.config();
    if (!cfg.enabled || cfg.repo !== repo) return "wrong_repo";
    const origin = await git(this.dir, ["remote", "get-url", "origin"]);
    const name = origin.ok ? (this.o.originRepo ?? ((u: string) => tryParseRepoUrl(u)?.github))(origin.out) : undefined;
    if (!name || githubKey(name) !== githubKey(repo)) return "wrong_repo";
    if ((await branchOf(this.dir)) !== "main") return "not_main";
    if (!(await isClean(this.dir))) return "local_changes";
    if ((await headOf(this.dir)) !== head) return "no_fast_forward";
    if (loadUpdateState(this.file).state.tested?.commit !== commit) return "no_fast_forward";
    return undefined;
  }

  /** Puts the tested commit in place, journals it, and restarts. The checkout is on main, clean and can fast-forward. */
  private async install(commit: string, from: string, repo: string): Promise<void> {
    this.working = true;
    try {
      // The check was a while ago (git calls, the idle test): everything it relied on must still hold, right before the journal.
      const changed = await this.changed(commit, from, repo);
      if (changed) return this.block(changed, commit);
      if (!updateState((s) => { s.pending = { from, to: commit, phase: "apply" }; }, this.file)) return;
      const pending = { from, to: commit, phase: "apply" as const };
      const back = async (lines?: string[]) => {
        await rollBack({ why: "apply", pending, log: (m) => this.say(`self-update: ${m}`), lines, dir: this.dir, file: this.file, steps: this.steps });
        this.leave();
      };
      const merged = await git(this.dir, ["merge", "--ff-only", "--quiet", commit]);
      if (!merged.ok) return back([this.safe(merged.out).slice(0, 300)]);
      const differs = !(await git(this.dir, ["diff", "--quiet", from, commit, "--", "package.json", "package-lock.json"])).ok;
      for (const name of differs ? (["install", "build"] as const) : (["build"] as const)) {
        const step = this.steps.find((s) => s.name === name);
        if (!step) continue;
        const r = await runStep(step, this.dir);
        if (r.killed || this.stopped) return; // cut off: the supervisor finishes going back at the next start
        if (!r.ok) return back(this.lines(r.output));
      }
      if ((await headOf(this.dir)) !== commit) return back();
      const stamp = buildStamp(join(this.dir, "dist"));
      updateState((s) => { s.pending = { from, to: commit, phase: "installed", stamp }; }, this.file);
      this.say(`self-update: installed ${short(commit)}; restarting`);
    } finally {
      this.working = false;
    }
    if (this.stopped) return;
    this.o.beforeExit();
    (this.o.exit ?? process.exit)(RESTART_CODE);
  }
}
