/**
 * background.js — orchestrator. Keeps this file thin; the real logic lives
 * in lib/*.js so each concern (allowlist, capture, sending) can be read and
 * changed independently.
 */

import { isAllowed } from "./lib/allowlist.js";
import {
  attachDebugger,
  detachDebugger,
  isAttached,
  forgetTab,
  createEventHandler,
} from "./lib/debugger-capture.js";
import { logSender } from "./lib/log-sender.js";
import { createCommandPoller } from "./lib/commands.js";

// Per-tab metadata the event handler needs but shouldn't have to fetch
// itself on every single event.
const tabHostnames = new Map(); // tabId -> hostname
const tabSessions = new Map(); // tabId -> a rough per-navigation session id

// In-memory ring buffer per tab, purely local — this is what makes the log
// viewer work instantly with zero Supabase setup. Capped so a chatty tab
// can't grow this without bound.
const MAX_BUFFERED_ROWS = 500;
const localLogs = new Map(); // tabId -> row[]

function recordLocal(tabId, row) {
  let buffer = localLogs.get(tabId);
  if (!buffer) {
    buffer = [];
    localLogs.set(tabId, buffer);
  }
  buffer.push(row);
  if (buffer.length > MAX_BUFFERED_ROWS) buffer.shift();
}

const onDebuggerEvent = createEventHandler({
  getTabHostname: (tabId) => tabHostnames.get(tabId),
  getSessionId: (tabId) => tabSessions.get(tabId),
  recordLocal,
});
chrome.debugger.onEvent.addListener(onDebuggerEvent);

// If Chrome (or the user, or another extension) detaches the debugger out
// from under us, forget the tab so our bookkeeping doesn't lie.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) forgetTab(source.tabId);
});

// -- attach/detach as the user navigates --------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !tab.url || !tab.url.startsWith("http")) {
    return;
  }

  const hostname = new URL(tab.url).hostname;
  tabHostnames.set(tabId, hostname);
  tabSessions.set(tabId, `${tabId}-${Date.now()}`);

  const allowed = await isAllowed(tab.url);
  if (allowed && !isAttached(tabId)) {
    await attachDebugger(tabId);
  } else if (!allowed && isAttached(tabId)) {
    await detachDebugger(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebugger(tabId);
  tabHostnames.delete(tabId);
  tabSessions.delete(tabId);
  localLogs.delete(tabId);
});

// -- flushing -----------------------------------------------------------------
// MV3 service workers can be suspended between events, so a plain
// setInterval isn't reliable — chrome.alarms survives that. log-sender.js
// also auto-flushes as soon as a batch fills up, so busy tabs still send
// near-real-time; this alarm just guarantees quiet tabs flush eventually.
chrome.alarms.create("flush-logs", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flush-logs") logSender.flush();
});

// -- remote commands, from query_logs.py's `command` subcommand ---------------
// Requires scripts/remote_control_schema.sql to have been run once — see
// that file for what it adds and the RLS trade-off it makes.

function findTabIdByHostname(hostname) {
  for (const [tabId, host] of tabHostnames.entries()) {
    if (host === hostname) return tabId;
  }
  return undefined;
}

function getAttachedHostnames() {
  return [...tabHostnames.entries()]
    .filter(([tabId]) => isAttached(tabId))
    .map(([, hostname]) => hostname);
}

const pollAndExecuteCommands = createCommandPoller({ findTabIdByHostname, getAttachedHostnames });

// 30s in dev/unpacked mode; Chrome enforces a 1-minute floor for packed
// extensions, so this silently becomes a 1-minute poll if ever published.
chrome.alarms.create("poll-commands", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll-commands") pollAndExecuteCommands();
});

// -- messages from the popup/options UI ----------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    const attached = [...tabHostnames.entries()].filter(([tabId]) => isAttached(tabId));
    sendResponse({ attachedTabs: attached });
    return true;
  }
  if (message?.type === "FLUSH_NOW") {
    logSender.flush().then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
  if (message?.type === "GET_LOGS") {
    const tabId = findTabIdByHostname(message.hostname);
    sendResponse({ rows: tabId !== undefined ? localLogs.get(tabId) || [] : [] });
    return true;
  }
  if (message?.type === "CLEAR_LOGS") {
    const tabId = findTabIdByHostname(message.hostname);
    if (tabId !== undefined) localLogs.set(tabId, []);
    sendResponse({ ok: true });
    return true;
  }
});
