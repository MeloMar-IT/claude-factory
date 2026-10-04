import { breakerWhy, currentState, switchStories } from "./guard.js";

export const MONITOR_USAGE = `usage: scf monitor off      Stop the monitor from making bug stories
       scf monitor on       Let it make bug stories again
       scf monitor status   Print the state`;

const UNREADABLE = "monitor-guard.json cannot be read";

/** `scf monitor off|on|status`. Only reads and writes the state file: no config, no GitHub. Prints through `out`; returns the exit code. */
export function monitorCommand(positionals: string[], out: (line: string) => void): number {
  const [sub, ...rest] = positionals;
  if ((sub !== "off" && sub !== "on" && sub !== "status") || rest.length) throw new Error(MONITOR_USAGE);
  if (sub === "status") {
    const s = currentState();
    if (s.state === "unreadable") {
      out(`bug stories are stopped: ${UNREADABLE} (scf monitor on starts a fresh file)`);
      return 1;
    }
    if (s.state === "breaker") out(`bug stories: stopped by the circuit breaker since ${s.since} (${breakerWhy(s)}); scf monitor on switches them on again`);
    else out(s.state === "off" ? `bug stories: off since ${s.since} (by ${s.by})` : "bug stories: on");
    return 0;
  }
  const r = switchStories(sub, "cli");
  if (r.state === "unreadable") {
    out(`bug stories are stopped: ${UNREADABLE} (scf monitor on starts a fresh file)`);
    return 0;
  }
  if (!r.changed) {
    out(r.state === "off" ? `bug stories are already off since ${r.since}` : "bug stories are already on");
    return 0;
  }
  out(`bug stories are ${r.state}`);
  if ("closed" in r && r.closed) out("the circuit breaker is closed; the counts start anew");
  if ("reset" in r && r.reset) out(`the state file could not be read: it was kept as monitor-guard.json.broken and a fresh one was started`);
  return 0;
}
