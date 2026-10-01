import { api } from "./api.js";
import { h, modal, mount, timeAgo, toast } from "./dom.js";
import { nextList, statusMark, watcherNext } from "./next.js";

const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
const check = (checked, label) => {
  const el = h("input", { type: "checkbox", style: { width: "auto" }, checked: !!checked });
  return { el, row: h("label", { class: "row", style: { gap: "6px" } }, el, h("span", {}, label)) };
};
const num = (el) => (el.value.trim() === "" ? undefined : Number(el.value));

async function saveConfig(mutate, okMsg) {
  const config = await api.config();
  mutate(config);
  await api.saveConfig(config);
  toast(okMsg);
}

// ── watchers ──

/** The watcher as config.yaml has it: without what GET /api/watchers adds (the config rejects unknown keys). */
export const watcherConfig = ({ status: _status, state: _state, ...cfg } = {}) => cfg;
/** The watcher's own state with its "?". */
export const watcherStateMark = (w) => (w.state ? statusMark(w.state, `state-${w.state.name}`) : null);

const SOURCES = {
  issues: "Issues with a label → run a flow",
  "pr-feedback": "Review comments on Foundry PRs → pr-feedback",
  "ci-failures": "CI red on the default branch → ci-fix PR",
  schedule: "On a schedule → run a chore (PR if anything changed)",
};
const DEFAULT_FLOWS = { issues: "github-issue", "pr-feedback": "pr-feedback", "ci-failures": "ci-fix", schedule: "chore" };
const CHORES = [
  ["Dependencies", "Update dependencies that have known security vulnerabilities (npm audit / pip-audit / cargo audit etc.) to the smallest fixed version. Do not do major upgrades."],
  ["Flaky tests", "Run the test suite 3 times. If any test fails only sometimes, find why it is flaky and make it deterministic. Do not delete or skip tests."],
  ["Test coverage", "Find the most important untested code path (business logic, not trivial getters) and add focused tests for it."],
  ["Docs", "Check that README and docs match the code (commands, options, examples). Fix anything outdated."],
  ["Lint / TODOs", "Run the linter and fix the warnings that are safe to fix. Resolve TODO/FIXME comments that are quick and clearly specified."],
];
const describeWatcher = (w) => {
  const flow = w.flow === "github-issue" ? DEFAULT_FLOWS[w.source] : w.flow;
  return {
    issues: `issues labelled “${w.label}” → ${flow}`,
    "pr-feedback": `PR review comments → ${flow}`,
    "ci-failures": `CI failures on ${w.branch ?? "the default branch"} → ${flow}`,
    schedule: `${w.at ? `daily at ${w.at}${w.timezone ? ` ${w.timezone}` : ""}` : `every ${w.every}`}: ${(w.task ?? "").slice(0, 60)}${(w.task ?? "").length > 60 ? "…" : ""} → ${flow}`,
  }[w.source];
};

async function editWatcher(existing, flows) {
  const w = existing ?? { id: "", source: "issues", flow: "github-issue", github_repo: "", label: "claude-factory", every: "5m", max_per_tick: 1, enabled: true, vars: {} };
  return modal(existing ? `Edit watcher ${w.id}` : "Add a watcher", (close) => {
    const id = input(w.id, { class: "mono", placeholder: "my-repo", disabled: !!existing });
    const repo = input(w.github_repo, { class: "mono", placeholder: "owner/repo" });
    const flow = input(w.flow, { class: "mono", list: "watcher-flows" });
    const source = h("select", { onChange: () => {
      if (Object.values(DEFAULT_FLOWS).includes(flow.value)) flow.value = DEFAULT_FLOWS[source.value];
      if (source.value === "schedule" && /^\d+(s|m)$/.test(every.value)) every.value = "7d";
      showFor();
    } }, Object.entries(SOURCES).map(([v, label]) => h("option", { value: v, selected: w.source === v }, label)));
    const task = h("textarea", { rows: 3, placeholder: "What the chore should do each time", value: w.task ?? "" });
    const branch = input(w.branch ?? "", { class: "mono", placeholder: "default branch" });
    const exclude = input((w.exclude_labels ?? []).join(", "), { class: "mono", placeholder: "e.g. geni, wontfix" });
    const at = input(w.at ?? "", { class: "mono", placeholder: "HH:MM (optional)" });
    const tz = input(w.timezone ?? "", { class: "mono", placeholder: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const label = input(w.label, { class: "mono" });
    const every = input(w.every, { class: "mono", placeholder: "5m" });
    const max = input(String(w.max_per_tick), { type: "number", min: 1 });
    const vars = h("textarea", { rows: 3, class: "mono", placeholder: "test_cmd=npm test\nrequire_approval=yes", value: Object.entries(w.vars ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") });
    const enabled = check(w.enabled, "Enabled");
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const save = h("button", { class: "primary", onClick: async () => {
      const parsedVars = {};
      for (const line of vars.value.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const i = line.indexOf("=");
        if (i < 1) return (err.textContent = `vars: "${line}" should be name=value`);
        parsedVars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const list = (el) => el.value.split(",").map((x) => x.trim()).filter(Boolean);
      // Keep settings this form doesn't show (status label names, pauses, …).
      const kept = watcherConfig(existing ?? {});
      const next = { ...kept, id: id.value.trim(), source: source.value, flow: flow.value.trim(), github_repo: repo.value.trim(), label: label.value.trim(),
        every: every.value.trim(), max_per_tick: Number(max.value) || 1, enabled: enabled.el.checked, vars: parsedVars,
        task: source.value === "schedule" ? task.value.trim() : undefined,
        branch: source.value === "ci-failures" ? branch.value.trim() || undefined : undefined,
        exclude_labels: list(exclude),
        at: source.value === "schedule" ? at.value.trim() || undefined : undefined,
        timezone: source.value === "schedule" ? tz.value.trim() || undefined : undefined };
      try {
        await saveConfig((c) => {
          if (!existing && c.watchers.some((x) => x.id === next.id)) throw new Error(`a watcher "${next.id}" already exists`);
          c.watchers = existing ? c.watchers.map((x) => (x.id === existing.id ? next : x)) : [...c.watchers, next];
        }, `Watcher ${next.id} saved`);
        close(true);
      } catch (e) {
        err.textContent = e.message;
      }
    } }, "Save watcher");
    const labelField = h("div", { class: "grid" }, f("Trigger label", label), f("Skip issues with these labels", exclude));
    const atField = h("div", { class: "grid" }, f("Once a day at", at, "Instead of every interval"), f("Time zone", tz));
    const taskField = h("div", {}, f("Chore", task, "Becomes the run's task. The flow opens a PR only if something changed."),
      h("div", { class: "chips", style: { marginTop: "6px" } }, CHORES.map(([name, text]) => h("button", { class: "chip", type: "button", onClick: () => (task.value = text) }, name))));
    const branchField = f("Branch to watch", branch);
    const showFor = () => {
      labelField.style.display = source.value === "issues" ? "" : "none";
      taskField.style.display = source.value === "schedule" ? "" : "none";
      atField.style.display = source.value === "schedule" ? "" : "none";
      branchField.style.display = source.value === "ci-failures" ? "" : "none";
    };
    showFor();
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("datalist", { id: "watcher-flows" }, flows.map((x) => h("option", { value: x.name }))),
      h("div", { class: "grid" }, f("Id", id), f("GitHub repo", repo)),
      f("Source", source),
      h("div", { class: "grid" }, f("Flow", flow), labelField, branchField),
      taskField,
      atField,
      h("div", { class: "grid" }, f("Check every", every, "e.g. 5m, 1h — for chores: how often it runs, e.g. 1d, 7d"), f("Max new runs per check", max)),
      f("Variables for each run", vars, "One name=value per line. github_repo and issue/pr are set automatically."),
      enabled.row, err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
}

/** " · last successful check 5m ago", or a short text when there is none yet. */
export const lastOkText = (st) => (!st ? "" : st.lastOk ? ` · last successful check ${timeAgo(st.lastOk)}` : " · no successful check yet");

export async function renderWatchers(main) {
  const [watchers, flows] = await Promise.all([api.watchers(), api.flows()]);
  const reload = () => renderWatchers(main);
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Watchers"),
      h("span", { class: "muted" }, "Poll GitHub and start runs automatically while this server runs"),
      h("span", { class: "spacer" }),
      h("button", { onClick: reload }, "↻"),
      h("button", { class: "primary", onClick: async () => (await editWatcher(null, flows)) && reload() }, "+ Add watcher")),
    watchers.length ? h("div", { class: "watcher-list" }, watchers.map((w) => {
      const st = w.status;
      return h("div", { class: "card" },
        h("div", { class: "row" },
          h("b", { class: "mono" }, w.id),
          watcherStateMark(w),
          h("span", { class: "mono" }, w.github_repo),
          h("span", { class: "muted" }, describeWatcher(w)),
          h("span", { class: "spacer" }),
          w.enabled ? h("button", { class: "small", onClick: async () => { toast("Checking…"); await api.tickWatcher(w.id).catch((e) => toast(e.message, "error")); reload(); } }, "Check now") : null,
          h("button", { class: "small", onClick: async () => (await editWatcher(w, flows)) && reload() }, "Edit"),
          h("button", { class: "small danger", onClick: async () => {
            if (!confirm(`Delete watcher ${w.id}?`)) return;
            await saveConfig((c) => (c.watchers = c.watchers.filter((x) => x.id !== w.id)), "Deleted");
            reload();
          } }, "Delete")),
        h("div", { class: "muted", style: { fontSize: "12.5px" } },
          w.source === "schedule" ? (w.at ? `checks every ${w.every}` : `max 1 run per ${w.every}`) : `every ${w.every} · max ${w.max_per_tick} per check`,
          w.exclude_labels?.length ? ` · skips ${w.exclude_labels.join(", ")}` : "",
          w.pause_while_pr_open ? ` · pauses while a ${w.pause_while_pr_open}* PR is open` : "",
          w.enabled ? lastOkText(st) : "",
          st?.nextTick ? ` · next ${new Date(st.nextTick).toLocaleTimeString()}` : ""),
        w.enabled && watcherNext(w).length ? h("div", {}, h("div", { class: "muted", style: { fontSize: "12.5px", marginTop: "6px" } }, "What happens next:"), nextList(watcherNext(w))) : null,
        st?.lastError ? h("details", {}, h("summary", {}, "Error details"), h("pre", { class: "mono" }, st.lastError)) : null,
        st?.lastActions?.length ? h("details", {}, h("summary", {}, `Recent activity (${st.lastActions.length})`), h("pre", { class: "mono" }, st.lastActions.join("\n"))) : null);
    })) : h("div", { class: "empty" },
      h("p", {}, "No watchers yet. A watcher checks a GitHub repo on a schedule and runs a flow: for labelled issues, review comments, red CI on the default branch, or a recurring chore."),
      h("button", { class: "primary", onClick: async () => (await editWatcher(null, flows)) && reload() }, "+ Add watcher")),
    h("p", { class: "muted", style: { marginTop: "16px" } },
      "Watchers run inside this server. To keep them running after you close the terminal or restart your Mac: ",
      h("code", {}, "scf service install")));
}

// ── disk ──

function diskSection(section) {
  const days = input("7", { type: "number", min: 0, style: { width: "90px" } });
  const purge = check(false, "Also delete run logs");
  const paused = check(false, "Include stopped / waiting runs (they can't be resumed afterwards)");
  const out = h("div");
  const go = async (dryRun) => {
    if (!dryRun && !confirm("Remove these workspaces now? Branches in your repos are kept.")) return;
    try {
      const r = await api.clean({ olderThanDays: Number(days.value), purge: purge.el.checked, includePaused: paused.el.checked, dryRun });
      mount(out, h("p", { class: dryRun ? "muted" : "status ok", style: { margin: 0 } },
        `${dryRun ? "Would remove" : "Removed"} ${r.workspaces.length} workspace(s)${r.runs.length ? ` and ${r.runs.length} run(s)` : ""} · ${r.freedMb} MB`,
        r.kept.length ? ` · keeping ${r.kept.length} paused/running` : ""));
    } catch (e) {
      toast(e.message, "error");
    }
  };
  return section("Disk",
    h("p", { class: "muted", style: { margin: 0 } }, "Each run keeps its workspace (worktree or clone) so you can inspect or resume it. Clean up old ones here or with ", h("code", {}, "scf clean"), "."),
    h("div", { class: "row" }, h("span", {}, "Runs finished more than"), days, h("span", {}, "days ago")),
    purge.row, paused.row,
    h("div", { class: "row" }, h("button", { onClick: () => go(true) }, "Preview"), h("button", { class: "danger", onClick: () => go(false) }, "Clean up"), out));
}

// ── settings ──

export async function renderSettings(main) {
  const [c, info] = await Promise.all([api.config(), api.info()]);
  const budget = input(c.daily_budget_usd ?? "", { type: "number", step: "0.5", placeholder: "no limit" });
  const limits = check(c.cost_limits !== false, "Enforce cost limits (run, step and daily budgets)");
  const conc = input(String(c.concurrency), { type: "number", min: 1 });
  const protectedB = input(c.protected_branches.join(", "), { class: "mono" });
  const macos = check(c.notify.macos, "macOS notifications");
  const slack = input(c.notify.slack_webhook ?? "", { class: "mono", placeholder: "https://hooks.slack.com/services/…" });
  const cmd = input(c.notify.command ?? "", { class: "mono", placeholder: 'e.g. say "$FACTORY_STATUS"' });
  const on = ["succeeded", "failed", "stopped", "waiting", "cancelled"].map((s) => [s, check(c.notify.on.includes(s), s)]);
  const botName = input(c.bot.name ?? "", { placeholder: "claude-factory[bot]" });
  const botEmail = input(c.bot.email ?? "", { class: "mono" });
  const botToken = input(c.bot.gh_token_env ?? "", { class: "mono", placeholder: "FACTORY_GH_TOKEN" });
  const appId = input(c.github_app?.app_id ?? "", { class: "mono" });
  const instId = input(c.github_app?.installation_id ?? "", { class: "mono" });
  const keyPath = input(c.github_app?.private_key_path ?? "", { class: "mono", placeholder: "/path/to/app.private-key.pem" });
  const sbxClaude = check(c.sandbox.claude, "Sandbox agents' shell commands by default");
  const secrets = check(c.secret_scan !== false, "Block pushes that add secrets (API keys, tokens, private keys, .env files)");
  const sbxImage = input(c.sandbox.docker_image ?? "", { class: "mono", placeholder: "e.g. node:22" });
  const err = h("div");

  const save = async () => {
    const next = {
      ...c,
      daily_budget_usd: num(budget),
      cost_limits: limits.el.checked,
      concurrency: Number(conc.value) || 1,
      protected_branches: protectedB.value.split(",").map((s) => s.trim()).filter(Boolean),
      secret_scan: secrets.el.checked,
      notify: { macos: macos.el.checked, slack_webhook: slack.value.trim() || undefined, command: cmd.value.trim() || undefined, on: on.filter(([, x]) => x.el.checked).map(([s]) => s) },
      bot: { name: botName.value.trim() || undefined, email: botEmail.value.trim() || undefined, gh_token_env: botToken.value.trim() || undefined },
      github_app: appId.value.trim() ? { app_id: appId.value.trim(), installation_id: instId.value.trim(), private_key_path: keyPath.value.trim() } : undefined,
      sandbox: { claude: sbxClaude.el.checked || undefined, docker_image: sbxImage.value.trim() || undefined },
    };
    try {
      await api.saveConfig(next);
      mount(err);
      toast("Settings saved");
    } catch (e) {
      mount(err, h("div", { class: "errors" }, e.message));
    }
  };

  const section = (title, ...children) => h("div", { class: "card", style: { marginBottom: "14px" } }, h("h3", {}, title), ...children);
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Settings"), h("span", { class: "muted mono" }, info.configPath), h("span", { class: "spacer" }), h("button", { class: "primary", onClick: save }, "Save")),
    err,
    section("Budget & capacity",
      limits.row,
      h("p", { class: "muted", style: { margin: "4px 0 10px", fontSize: "12.5px" } }, "Off: costs are still recorded and shown (Dashboard, runs), but no run is ever stopped because of money — for fixed-price subscriptions. Claude's and Codex's own usage limits still pause runs."),
      h("div", { class: "grid" },
        f("Daily budget ($)", budget, `Spent today: $${info.spentToday.toFixed(2)}. When reached, runs pause (stopped) and resume the next day.`),
        f("Runs at the same time", conc))),
    section("Safety",
      f("Protected branches", protectedB, "Pushes to these are refused during runs (glob patterns, comma-separated). Also enable branch protection on GitHub."),
      secrets.row,
      sbxClaude.row,
      f("Docker image for sandboxed shell steps", sbxImage, "Steps marked “Run in Docker” (like tests) run in this image with only the workspace mounted.")),
    section("Notifications",
      macos.row,
      h("div", { class: "grid" }, f("Slack webhook", slack), f("Command", cmd, "Runs with $FACTORY_STATUS, $FACTORY_RUN_ID, $FACTORY_MESSAGE.")),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Notify when a run is:"), on.map(([, x]) => x.row))),
    section("Bot identity",
      h("p", { class: "muted", style: { margin: 0 } }, "By default commits and comments are made as you (your git config and gh login)."),
      h("div", { class: "grid" }, f("Commit author name", botName), f("Commit author email", botEmail), f("Env var with the bot's GitHub token", botToken, "Used as GH_TOKEN for gh and git pushes."))),
    diskSection(section),
    section("GitHub App (optional, preferred over a token)",
      h("div", { class: "grid" }, f("App ID", appId), f("Installation ID", instId), f("Private key file", keyPath))));
}
