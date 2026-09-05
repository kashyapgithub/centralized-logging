/**
 * commands.js — lets a trusted external client (Claude, via
 * `query_logs.py command`) tell this extension to do something, by way of
 * a small `extension_commands` table in the same Supabase project.
 *
 * Flow: query_logs.py INSERTs a row with the service key -> this extension
 * polls for pending rows with the anon key -> executes -> PATCHes the row
 * with status + result -> query_logs.py (still polling) prints the result.
 *
 * Requires scripts/remote_control_schema.sql to have been run — see that
 * file for the RLS trade-off it makes before enabling this.
 */

import { isAllowed } from "./allowlist.js";
import {
  attachDebugger,
  detachDebugger,
  isAttached,
  captureLocalStorageSnapshot,
} from "./debugger-capture.js";
import { logSender } from "./log-sender.js";

async function getSupabaseConfig() {
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get([
    "supabaseUrl",
    "supabaseAnonKey",
  ]);
  return { supabaseUrl, supabaseAnonKey };
}

/**
 * @param {object} deps
 * @param {(hostname: string) => number | undefined} deps.findTabIdByHostname
 * @param {() => string[]} deps.getAttachedHostnames
 * @returns an async function safe to call from a chrome.alarms listener
 */
export function createCommandPoller({ findTabIdByHostname, getAttachedHostnames }) {
  return async function pollAndExecuteCommands() {
    const { supabaseUrl, supabaseAnonKey } = await getSupabaseConfig();
    if (!supabaseUrl || !supabaseAnonKey) return;

    let pending;
    try {
      const res = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/extension_commands` +
          `?status=eq.pending&order=created_at.asc&limit=20`,
        { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` } }
      );
      pending = await res.json();
    } catch (err) {
      console.warn("[central-log-capture] command poll failed:", err);
      return;
    }
    if (!Array.isArray(pending) || pending.length === 0) return;

    for (const cmd of pending) {
      const outcome = await executeCommand(cmd, { findTabIdByHostname, getAttachedHostnames });
      await reportCommandOutcome(supabaseUrl, supabaseAnonKey, cmd.id, outcome);
    }
  };
}

async function executeCommand(cmd, { findTabIdByHostname, getAttachedHostnames }) {
  try {
    switch (cmd.command) {
      case "flush":
        await logSender.flush();
        return { status: "done", result: { flushed: true } };

      case "status":
        return { status: "done", result: { attachedHostnames: getAttachedHostnames() } };

      case "attach": {
        if (!cmd.app_name) return { status: "failed", result: { error: "app_name is required" } };
        if (!(await isAllowed(`https://${cmd.app_name}`))) {
          return {
            status: "failed",
            result: { error: `${cmd.app_name} is not in the allowlist — add it in Settings first` },
          };
        }
        const tabId = findTabIdByHostname(cmd.app_name);
        if (tabId === undefined) {
          return { status: "failed", result: { error: `no open tab found for ${cmd.app_name}` } };
        }
        await attachDebugger(tabId);
        return { status: "done", result: { tabId, attached: isAttached(tabId) } };
      }

      case "detach": {
        const tabId = findTabIdByHostname(cmd.app_name);
        if (tabId === undefined) {
          return { status: "failed", result: { error: `no open tab found for ${cmd.app_name}` } };
        }
        await detachDebugger(tabId);
        return { status: "done", result: { tabId, attached: false } };
      }

      case "localstorage_snapshot": {
        const tabId = findTabIdByHostname(cmd.app_name);
        if (tabId === undefined || !isAttached(tabId)) {
          return {
            status: "failed",
            result: {
              error:
                "that tab isn't open and attached — make sure the domain is allowlisted and the page is loaded",
            },
          };
        }
        const snapshot = await captureLocalStorageSnapshot(tabId);
        return { status: "done", result: { local_storage: snapshot } };
      }

      default:
        return { status: "failed", result: { error: `unknown command '${cmd.command}'` } };
    }
  } catch (err) {
    return { status: "failed", result: { error: String(err) } };
  }
}

async function reportCommandOutcome(supabaseUrl, supabaseAnonKey, id, { status, result }) {
  try {
    await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/extension_commands?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ status, result, completed_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.warn("[central-log-capture] couldn't report command outcome:", err);
  }
}
