/**
 * commands.js — lets a trusted external client (Claude, via
 * `query_logs.py command`) tell this extension to do something, by way of
 * the local log server's small command queue (server.py's `commands` table).
 *
 * Flow: query_logs.py POSTs /commands on the local server -> this
 * extension polls GET /commands/pending -> executes -> PATCHes
 * /commands/<id> with status + result -> query_logs.py (still polling)
 * prints the result.
 */

import {
  attachDebugger,
  detachDebugger,
  isAttached,
  captureLocalStorageSnapshot,
} from "./debugger-capture.js";
import { logSender } from "./log-sender.js";

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get(["serverUrl"]);
  return serverUrl;
}

/**
 * @param {object} deps
 * @param {(hostname: string) => number | undefined} deps.findTabIdByHostname
 * @param {() => string[]} deps.getAttachedHostnames
 * @returns an async function safe to call from a chrome.alarms listener
 */
export function createCommandPoller({ findTabIdByHostname, getAttachedHostnames }) {
  return async function pollAndExecuteCommands() {
    const serverUrl = await getServerUrl();
    if (!serverUrl) return;

    let pending;
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, "")}/commands/pending`);
      const data = await res.json();
      pending = data.commands;
    } catch (err) {
      console.warn("[central-log-capture] command poll failed — is server.py running?", err);
      return;
    }
    if (!Array.isArray(pending) || pending.length === 0) return;

    for (const cmd of pending) {
      const outcome = await executeCommand(cmd, { findTabIdByHostname, getAttachedHostnames });
      await reportCommandOutcome(serverUrl, cmd.id, outcome);
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
        // No separate allowlist re-check needed here: findTabIdByHostname
        // only ever returns tabs that background.js already validated as
        // allowlisted at navigation time (see background.js's tabAppNames).
        const tabId = findTabIdByHostname(cmd.app_name);
        if (tabId === undefined) {
          return {
            status: "failed",
            result: { error: `no open, allowlisted tab found for app_name '${cmd.app_name}'` },
          };
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

async function reportCommandOutcome(serverUrl, id, { status, result }) {
  try {
    await fetch(`${serverUrl.replace(/\/$/, "")}/commands/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, result }),
    });
  } catch (err) {
    console.warn("[central-log-capture] couldn't report command outcome:", err);
  }
}
