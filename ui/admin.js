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

/** The `notify` setting from the raw values of the Settings controls (strings for text, booleans for checkboxes). */
export function notifyFrom(v) {
  const t = (x) => String(x ?? "").trim();
  return {
    macos: !!v.macos,
    slack_webhook: t(v.slack) || undefined,
    command: t(v.command) || undefined,
    on: v.on,
    successes: !!v.successes,
    throttle_minutes: t(v.throttle) === "" ? 5 : Number(v.throttle),
    quiet_hours: t(v.quietFrom) && t(v.quietTo) ? { from: t(v.quietFrom), to: t(v.quietTo) } : undefined,
    daily_summary_at: t(v.summaryAt) || undefined,
  };
}

/** The `server` setting from the raw values of the Network controls. */
export function serverFrom(v) {
  return {
    listen: String(v.listen ?? "").trim() || "127.0.0.1",
    allowed_hosts: String(v.hosts ?? "").split(/[\s,]+/).filter(Boolean),
    allow_insecure_http: !!v.insecure,
  };
}

async function saveConfig(mutate, okMsg) {
  const config = await api.config();
  mutate(config);
  await api.saveConfig(config);
  toast(okMsg);
}

// ── watchers ──

/** The watcher as config.yaml has it: without what GET /api/watchers adds (the config rejects unknown keys). */
/** The watcher's `owner` from the form field: left out of the saved config when empty. */
export const ownerSetting = (text) => String(text ?? "").trim() || undefined;
export const watcherConfig =({ status: _status, state: _state, ...cfg } = {}) => cfg;
/** The watcher's own state with its "?". */
export const watcherStateMark = (w) => (w.state ? statusMark(w.state, `state-${w.state.name}`) : null);

const SOURCES = {
  issues: "Issues with a label → run a flow (default issue-gitflow)",
  schedule: "On a schedule → run a flow (default release-daily)",
  monitor: "The Foundry itself → find its own problems",
};
// No shipped flow for these any more; still shown for a watcher that already uses them.
const OLD_SOURCES = {
  "pr-feedback": "Review comments on Foundry PRs → your flow",
  "ci-failures": "CI red on the default branch → your flow",
};
const DEFAULT_FLOWS = { issues: "issue-gitflow", schedule: "release-daily" };
const CHORES = [
  ["Dependencies", "Update dependencies that have known security vulnerabilities (npm audit / pip-audit / cargo audit etc.) to the smallest fixed version. Do not do major upgrades."],
  ["Flaky tests", "Run the test suite 3 times. If any test fails only sometimes, find why it is flaky and make it deterministic. Do not delete or skip tests."],
  ["Test coverage", "Find the most important untested code path (business logic, not trivial getters) and add focused tests for it."],
  ["Docs", "Check that README and docs match the code (commands, options, examples). Fix anything outdated."],
  ["Lint / TODOs", "Run the linter and fix the warnings that are safe to fix. Resolve TODO/FIXME comments that are quick and clearly specified."],
];
/** A monitor has no repository, flow, labels or owner: only these fields are saved (a changed source drops the rest). */
export const monitorEntry = ({ id, every, enabled }) => ({ id, source: "monitor", every, enabled });

export const describeWatcher = (w) => {
  const flow = w.flow === "default" ? DEFAULT_FLOWS[w.source] ?? "(no flow)" : w.flow;
  return {
    monitor: "checks the Foundry itself for problems",
    issues: `issues labelled “${w.label}” → ${flow}`,
    "pr-feedback": `PR review comments → ${flow}`,
    "ci-failures": `CI failures on ${w.branch ?? "the default branch"} → ${flow}`,
    schedule: `${w.at ? `daily at ${w.at}${w.timezone ? ` ${w.timezone}` : ""}` : `every ${w.every}`}: ${(w.task ?? "").slice(0, 60)}${(w.task ?? "").length > 60 ? "…" : ""} → ${flow}`,
  }[w.source];
};

async function editWatcher(existing, flows) {
  const w = existing ?? { id: "", source: "issues", flow: "issue-gitflow", github_repo: "", label: "claude-factory", every: "5m", max_per_tick: 1, enabled: true, vars: {} };
  return modal(existing ? `Edit watcher ${w.id}` : "Add a watcher", (close) => {
    const id = input(w.id, { class: "mono", placeholder: "my-repo", disabled: !!existing });
    const repo = input(w.github_repo, { class: "mono", placeholder: "owner/repo" });
    const flow = input(w.flow, { class: "mono", list: "watcher-flows" });
    const source = h("select", { onChange: () => {
      if (DEFAULT_FLOWS[source.value] && Object.values(DEFAULT_FLOWS).includes(flow.value)) flow.value = DEFAULT_FLOWS[source.value];
      if (source.value === "schedule" && /^\d+(s|m)$/.test(every.value)) every.value = "7d";
      showFor();
    } }, Object.entries({ ...SOURCES, ...(OLD_SOURCES[w.source] ? { [w.source]: OLD_SOURCES[w.source] } : {}) }).map(([v, label]) => h("option", { value: v, selected: w.source === v }, label)));
    const task = h("textarea", { rows: 3, placeholder: "What the chore should do each time", value: w.task ?? "" });
    const branch = input(w.branch ?? "", { class: "mono", placeholder: "default branch" });
    const exclude = input((w.exclude_labels ?? []).join(", "), { class: "mono", placeholder: "e.g. geni, wontfix" });
    const at = input(w.at ?? "", { class: "mono", placeholder: "HH:MM (optional)" });
    const tz = input(w.timezone ?? "", { class: "mono", placeholder: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const label = input(w.label, { class: "mono" });
    const every = input(w.every, { class: "mono", placeholder: "5m" });
    const max = input(String(w.max_per_tick), { type: "number", min: 1 });
    const vars = h("textarea", { rows: 3, class: "mono", placeholder: "test_cmd=npm test\nrequire_approval=yes", value: Object.entries(w.vars ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") });
    const owner = input(w.owner ?? "", { placeholder: "name@example.com" });
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
      const next = source.value === "monitor" ? monitorEntry({ id: id.value.trim(), every: every.value.trim(), enabled: enabled.el.checked }) : { ...kept, id: id.value.trim(), source: source.value, flow: flow.value.trim(), github_repo: repo.value.trim(), label: label.value.trim(),
        every: every.value.trim(), max_per_tick: Number(max.value) || 1, enabled: enabled.el.checked, vars: parsedVars,
        task: source.value === "schedule" ? task.value.trim() : undefined,
        branch: source.value === "ci-failures" ? branch.value.trim() || undefined : undefined,
        exclude_labels: list(exclude),
        owner: ownerSetting(owner.value),
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
    const repoField = f("GitHub repo", repo);
    const flowField = f("Flow", flow);
    const maxField = f("Max new runs per check", max);
    const varsField = f("Variables for each run", vars, "One name=value per line. github_repo and issue/pr are set automatically.");
    const ownerField = f("Owner of the runs", owner, "E-mail of an account. Empty: the first admin.");
    const showFor = () => {
      const mon = source.value === "monitor";
      for (const el of [repoField, flowField, maxField, varsField, ownerField]) el.style.display = mon ? "none" : "";
      labelField.style.display = source.value === "issues" ? "" : "none";
      // a monitor needs only an id and an interval
      taskField.style.display = source.value === "schedule" ? "" : "none";
      atField.style.display = source.value === "schedule" ? "" : "none";
      branchField.style.display = source.value === "ci-failures" ? "" : "none";
    };
    showFor();
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("datalist", { id: "watcher-flows" }, flows.map((x) => h("option", { value: x.name }))),
      h("div", { class: "grid" }, f("Id", id), repoField),
      f("Source", source),
      h("div", { class: "grid" }, flowField, labelField, branchField),
      taskField,
      atField,
      h("div", { class: "grid" }, f("Check every", every, "e.g. 5m, 1h — for chores: how often it runs, e.g. 1d, 7d"), maxField),
      varsField,
      ownerField,
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
          w.github_repo ? h("span", { class: "mono" }, w.github_repo) : null,
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
          w.source === "monitor" ? `every ${w.every}` : w.source === "schedule" ? (w.at ? `checks every ${w.every}` : `max 1 run per ${w.every}`) : `every ${w.every} · max ${w.max_per_tick} per check`,
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
  const successes = check(c.notify.successes, "Also notify when a run succeeds");
  const throttle = input(c.notify.throttle_minutes ?? 5, { type: "number", min: 1 });
  const quietFrom = input(c.notify.quiet_hours?.from ?? "", { type: "time" });
  const quietTo = input(c.notify.quiet_hours?.to ?? "", { type: "time" });
  const summaryAt = input(c.notify.daily_summary_at ?? "", { type: "time" });
  const on = ["succeeded", "failed", "stopped", "waiting", "cancelled"].map((s) => [s, check(c.notify.on.includes(s), s)]);
  const botName = input(c.bot.name ?? "", { placeholder: "claude-factory[bot]" });
  const botEmail = input(c.bot.email ?? "", { class: "mono" });
  const botToken = input(c.bot.gh_token_env ?? "", { class: "mono", placeholder: "FACTORY_GH_TOKEN" });
  const appId = input(c.github_app?.app_id ?? "", { class: "mono" });
  const instId = input(c.github_app?.installation_id ?? "", { class: "mono" });
  const keyPath = input(c.github_app?.private_key_path ?? "", { class: "mono", placeholder: "/path/to/app.private-key.pem" });
  const sbxClaude = check(c.sandbox.claude, "Sandbox agents' shell commands by default");
  const secrets = check(c.secret_scan !== false, "Block pushes that add secrets (API keys, tokens, private keys, .env files)");
  const hotfix = check(c.hotfix_to_main === true, "Hotfixes: build bug stories on a hotfix branch and merge them into main without a person (only the unchanged built-in issue-gitflow)");
  const sbxImage = input(c.sandbox.docker_image ?? "", { class: "mono", placeholder: "e.g. node:22" });
  const selfUpdate = check(c.self_update?.enabled === true, "Self-update: when main of the Foundry's own repository has new commits, build and test them and restart on the new version without a person");
  const selfRepo = input(c.self_update?.repo ?? "", { class: "mono", placeholder: "owner/name" });
  const net = c.server ?? { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false };
  const listenSel = h("select", {}, ["127.0.0.1", "::1", "0.0.0.0", "::"].map((a) => h("option", { value: a }, a)));
  listenSel.value = net.listen;
  const hostsIn = input(net.allowed_hosts.join(", "), { class: "mono", placeholder: "mymac.local" });
  const insecure = check(net.allow_insecure_http, "Allow plain HTTP from other computers");
  const err = h("div");

  const save = async () => {
    const next = {
      ...c,
      server: serverFrom({ listen: listenSel.value, hosts: hostsIn.value, insecure: insecure.el.checked }),
      daily_budget_usd: num(budget),
      cost_limits: limits.el.checked,
      concurrency: Number(conc.value) || 1,
      protected_branches: protectedB.value.split(",").map((s) => s.trim()).filter(Boolean),
      secret_scan: secrets.el.checked,
      hotfix_to_main: hotfix.el.checked,
      self_update: { enabled: selfUpdate.el.checked, repo: selfRepo.value.trim() || undefined },
      notify: notifyFrom({
        macos: macos.el.checked, slack: slack.value, command: cmd.value, on: on.filter(([, x]) => x.el.checked).map(([s]) => s),
        successes: successes.el.checked, throttle: throttle.value, quietFrom: quietFrom.value, quietTo: quietTo.value, summaryAt: summaryAt.value,
      }),
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
    section("Network",
      h("p", { class: "muted", style: { margin: 0 } }, "Who can reach this page. For other computers, use HTTPS through a proxy on this Mac (see the user guide)."),
      info.listening && info.listening !== net.listen ? h("p", { class: "status bad", style: { margin: 0 } }, `Now listening on ${info.listening} — restart the server to use ${net.listen}`) : null,
      h("div", { class: "grid" },
        f("Listen on", listenSel, "127.0.0.1: this Mac only. 0.0.0.0 and :: reach all networks (needs an admin account). Needs a restart."),
        f("Allowed host names", hostsIn, "Names people type, comma-separated, e.g. mymac.local.")),
      insecure.row,
      h("p", { class: "muted", style: { margin: "4px 0 0", fontSize: "12.5px" } }, "Warning: with plain HTTP, passwords and session cookies cross the network unencrypted. Use it only on a network you trust.")),
    section("Safety",
      f("Protected branches", protectedB, "Pushes to these are refused during runs (glob patterns, comma-separated). Also enable branch protection on GitHub."),
      secrets.row,
      hotfix.row,
      selfUpdate.row,
      f("Repository the Foundry may update from", selfRepo, "owner/name. Updates come only when the checkout's origin is this repository. Needs one stop and start of the Foundry after upgrading."),
      sbxClaude.row,
      f("Docker image for sandboxed shell steps", sbxImage, "Steps marked “Run in Docker” (like tests) run in this image with only the workspace mounted.")),
    section("Notifications",
      macos.row,
      h("p", { class: "muted", style: { margin: "4px 0 10px", fontSize: "12.5px" } },
        "Tells you only when something waits for you. ",
        info.clickThrough === true ? "A click opens the item." : info.clickThrough === false ? "Install terminal-notifier (brew install terminal-notifier) and restart to open the item with a click." : ""),
      successes.row,
      h("div", { class: "grid" },
        f("At most one notification every … minutes", throttle),
        f("Quiet hours from", quietFrom, "Leave both empty for no quiet hours."),
        f("Quiet hours to", quietTo),
        f("Daily summary at", summaryAt, "Empty: no summary.")),
      h("div", { class: "grid" }, f("Slack webhook", slack), f("Command", cmd, "Runs with $FACTORY_STATUS, $FACTORY_RUN_ID, $FACTORY_MESSAGE.")),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Run the command when a run is:"), on.map(([, x]) => x.row))),
    section("Bot identity",
      h("p", { class: "muted", style: { margin: 0 } }, "By default commits and comments are made as you (your git config and gh login)."),
      h("div", { class: "grid" }, f("Commit author name", botName), f("Commit author email", botEmail), f("Env var with the bot's GitHub token", botToken, "Used as GH_TOKEN for gh and git pushes."))),
    diskSection(section),
    section("GitHub App (optional, preferred over a token)",
      h("div", { class: "grid" }, f("App ID", appId), f("Installation ID", instId), f("Private key file", keyPath))));
}
