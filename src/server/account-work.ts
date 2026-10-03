import { basename } from "node:path";
import { StoreError } from "../auth/store.js";
import { getUser, listUsers, takeStopWork } from "../auth/users.js";
import type { AccountCancelCounts, Scheduler } from "../queue/scheduler.js";

/** How often the server looks for blocked and deleted accounts, in ms. */
export const ACCOUNT_SWEEP_MS = 2000;

/** True when the account exists and is not blocked; false also when the accounts cannot be read. Never throws. */
export function accountActive(id: string): boolean {
  try {
    return getUser(id)?.status === "active";
  } catch {
    return false;
  }
}

const errName = (e: unknown) => (e instanceof Error ? e.name : "error");

/**
 * Returns the sweep: it drops the queued jobs of blocked and deleted accounts and handles each stop-work request once.
 * It never throws. Logs carry account ids only, never a name, e-mail or path.
 */
export function accountSweeper(scheduler: Scheduler, log: (msg: string) => void): () => void {
  /** The stop-work request of each account this process has already acted on (until the request is removed). */
  const handled = new Map<string, string>();
  /** Problems already logged, so a problem that stays is logged once. */
  const told = new Set<string>();
  const tell = (key: string, msg: string) => {
    if (told.has(key)) return;
    told.add(key);
    log(msg);
  };

  return () => {
    let users;
    try {
      users = listUsers();
    } catch (e) {
      const kind = e instanceof StoreError ? e.kind : errName(e);
      tell("users", `! accounts: users.json ${kind}; jobs queued by accounts wait`);
      return;
    }
    told.delete("users");

    for (const u of users) {
      if (u.status !== "blocked" || u.stopWork === undefined) continue;
      const act = (request: string) => {
        if (handled.get(u.id) === request) return;
        const c = scheduler.cancelAccount(u.id, { stopWork: true });
        handled.set(u.id, request);
        log(`account ${u.id} stop-work: cancelled ${c.queued} queued, ${c.running} running, ${c.waiting} waiting`);
      };
      try {
        takeStopWork(u.id, act);
        handled.delete(u.id);
        told.delete(`take ${u.id}`);
      } catch (e) {
        if (e instanceof StoreError) {
          tell(`take ${u.id}`, `! account ${u.id}: the stop-work request could not be removed: ${basename(e.file)} ${e.kind}`);
        } else {
          tell(`take ${u.id}`, `! could not cancel the work of account ${u.id}: ${errName(e)}`);
        }
      }
    }

    try {
      for (const r of scheduler.enforceAccounts(users.map((u) => ({ id: u.id, blocked: u.status === "blocked" })))) {
        log(`account ${r.accountId} ${r.why}: cancelled ${r.queued} queued, 0 running, 0 waiting`);
      }
      told.delete("enforce");
    } catch (e) {
      tell("enforce", `! could not cancel the work of blocked accounts: ${errName(e)}`);
    }
  };
}

/**
 * Cancels the work of an account at once, so an API call need not wait for the sweep. A plain block or delete drops
 * the queued jobs; `stopWork` also takes the pending stop-work request (so the sweep does not repeat it) and cancels
 * the running and waiting runs. Logs the counts with the account id only.
 */
export function cancelAccountNow(scheduler: Scheduler, log: ((msg: string) => void) | undefined, id: string, why: "blocked" | "deleted", stopWork = false): AccountCancelCounts {
  let counts: AccountCancelCounts = { queued: 0, running: 0, waiting: 0 };
  if (stopWork) {
    takeStopWork(id, () => {
      counts = scheduler.cancelAccount(id, { stopWork: true });
    });
  } else {
    counts = scheduler.cancelAccount(id);
  }
  log?.(`account ${id} ${stopWork ? "stop-work" : why}: cancelled ${counts.queued} queued, ${counts.running} running, ${counts.waiting} waiting`);
  return counts;
}
