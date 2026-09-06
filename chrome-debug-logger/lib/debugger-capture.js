/**
 * debugger-capture.js — the actual "DevTools you never have to open" layer.
 *
 * Uses chrome.debugger (Chrome DevTools Protocol) rather than an injected
 * console-override script, so it catches everything DevTools itself would:
 * console output, uncaught exceptions/rejections, AND failed/error network
 * responses — without the target page being able to detect or block it by
 * overriding window.console.
 *
 * Trade-off: attaching shows Chrome's "<extension> is debugging this
 * browser" banner on the tab. That's exactly why attach/detach is gated by
 * the domain allowlist in allowlist.js, not run on every tab.
 */

import { fingerprint } from "./fingerprint.js";
import { logSender } from "./log-sender.js";

const attachedTabs = new Set();

// -- attach / detach --------------------------------------------------------

export async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Log.enable"),
      chrome.debugger.sendCommand({ tabId }, "Network.enable"),
    ]);
  } catch (err) {
    // Common causes: tab already has DevTools open, or another extension's
    // debugger is attached. Not fatal — just means this tab isn't captured.
    console.warn(`[central-log-capture] couldn't attach to tab ${tabId}:`, err);
    attachedTabs.delete(tabId);
  }
}

export async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached (e.g. tab closed) — nothing to do.
  }
}

export function isAttached(tabId) {
  return attachedTabs.has(tabId);
}

/** Exposed for lib/commands.js — lets a remote "localstorage_snapshot"
 *  command reuse the exact same capture logic as automatic error capture. */
export { captureLocalStorageSnapshot };

/** Called from background.js's chrome.debugger.onDetach listener, so our
 *  bookkeeping stays correct if Chrome (or the user) detaches for us. */
export function forgetTab(tabId) {
  attachedTabs.delete(tabId);
}

// -- event -> log row translation --------------------------------------------

function levelFromConsoleType(type) {
  const map = { warning: "warn", error: "error" };
  return map[type] || (type === "debug" ? "debug" : "info");
}

function formatConsoleArgs(args) {
  return (args || [])
    .map((a) => {
      if (a.value !== undefined) {
        return typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value);
      }
      return a.description || a.unserializableValue || `[${a.type}]`;
    })
    .join(" ");
}

function formatStack(stackTrace) {
  if (!stackTrace || !stackTrace.callFrames) return null;
  return stackTrace.callFrames
    .map((f) => `  at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
    .join("\n");
}

/** Snapshot localStorage for the tab — only called for actual errors, never
 *  on every console line, to keep this from becoming a continuous scrape. */
async function captureLocalStorageSnapshot(tabId) {
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: "JSON.stringify(window.localStorage)",
      returnByValue: true,
    });
    const raw = result?.result?.value;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Builds the chrome.debugger.onEvent listener. Every event that matters
 * gets recorded into the local in-memory buffer (recordLocal) so the
 * standalone log viewer works instantly, with zero server round-trips. Only a
 * subset also gets forwarded to the backend (logSender) — raw network
 * *requests* and successful responses stay viewer-only, since shipping
 * every request on a busy page to the DB would drown out the real
 * problems it's meant to surface.
 */
export function createEventHandler({ getTabHostname, getSessionId, recordLocal, getForwardConfig }) {
  return async function onDebuggerEvent(source, method, params) {
    const tabId = source.tabId;
    if (tabId === undefined) return;

    let type, level, message, errorType = null, stackTrace = null, context = {}, tags = [];
    let category; // which forwardConfig key decides whether this leaves the browser

    switch (method) {
      case "Runtime.consoleAPICalled":
        type = "console";
        category = "console";
        level = levelFromConsoleType(params.type);
        message = formatConsoleArgs(params.args);
        stackTrace = formatStack(params.stackTrace);
        tags = ["console", params.type];
        break;

      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails;
        type = "exception";
        category = "exceptions";
        level = "error";
        message = details.exception?.description || details.text || "Uncaught exception";
        errorType = details.exception?.className || "Error";
        stackTrace = formatStack(details.stackTrace);
        tags = ["uncaught-exception"];
        break;
      }

      case "Log.entryAdded": {
        const entry = params.entry;
        type = "browser-log";
        category = "browserLog";
        level = entry.level === "error" ? "error" : entry.level === "warning" ? "warn" : "info";
        message = entry.text;
        errorType = entry.source; // e.g. "network", "javascript", "security"
        stackTrace = formatStack(entry.stackTrace);
        tags = ["browser-log", entry.source];
        break;
      }

      // Raw outgoing request — always in the local viewer (that's the "see
      // everything, like DevTools' Network tab" bit); only forwarded to
      // the backend if the user has explicitly turned on "raw network
      // traffic" in the popup, since it's high-volume.
      case "Network.requestWillBeSent":
        type = "network-request";
        category = "networkRaw";
        level = "debug";
        message = `→ ${params.request.method} ${params.request.url}`;
        context = { method: params.request.method, url: params.request.url };
        tags = ["network", "request"];
        break;

      case "Network.responseReceived": {
        const { response } = params;
        const isProblem = response.status >= 400;
        type = "network-response";
        // A failure counts under "network failures"; a normal 2xx/3xx only
        // ships to the backend if "raw network traffic" is turned on too.
        category = isProblem ? "networkFailures" : "networkRaw";
        level = isProblem ? (response.status >= 500 ? "error" : "warn") : "info";
        message = `← ${response.status} ${response.url}`;
        errorType = isProblem ? "NetworkResponse" : null;
        context = { status: response.status, url: response.url, mimeType: response.mimeType };
        tags = ["network", "response", String(response.status)];
        break;
      }

      case "Network.loadingFailed":
        type = "network-failed";
        category = "networkFailures";
        level = "error";
        message = `✕ Network request failed: ${params.errorText}`;
        errorType = "NetworkFailure";
        context = { errorText: params.errorText, canceled: !!params.canceled };
        tags = ["network", "failed"];
        break;

      default:
        return; // not an event type we care about
    }

    // Only pay the cost of a localStorage snapshot for things worth
    // investigating — not for routine info/debug lines or raw requests.
    if (level === "error" || level === "fatal") {
      context.local_storage = await captureLocalStorageSnapshot(tabId);
    }

    const row = {
      timestamp: new Date().toISOString(),
      type,
      level,
      message,
      error_type: errorType,
      stack_trace: stackTrace,
      context,
      tags,
    };

    // Always goes in the local buffer -> the log viewer sees it instantly,
    // no external setup required beyond running server.py. The forwarding
    // toggle only ever restricts what leaves the browser, never what you
    // can see in the viewer.
    recordLocal(tabId, row);

    const forwardConfig = getForwardConfig();
    if (forwardConfig[category]) {
      await logSender.enqueue({
        app_name: getTabHostname(tabId) || "unknown-site",
        environment: "browser",
        host: "chrome-extension",
        level: row.level,
        message: row.message,
        error_type: row.error_type,
        stack_trace: row.stack_trace,
        context: row.context,
        fingerprint: await fingerprint(row.error_type, row.message),
        session_id: getSessionId(tabId),
        tags: row.tags,
      });
    }
  };
}
