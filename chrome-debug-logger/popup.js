import { getForwardConfig, setForwardConfig } from "./lib/forward-config.js";
import { getAppNameForUrl } from "./lib/allowlist.js";

async function renderStatus() {
  const { attachedTabs } = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  const listEl = document.getElementById("tabList");
  listEl.innerHTML = "";

  if (!attachedTabs || attachedTabs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No tabs on the allowlist are open right now.";
    listEl.appendChild(li);
    return;
  }

  for (const [, appName] of attachedTabs) {
    const li = document.createElement("li");
    li.textContent = `● ${appName}`;
    listEl.appendChild(li);
  }
}

/**
 * The current tab's app label, per the allowlist (see lib/allowlist.js) —
 * NOT just the raw hostname, since two projects can share a hostname
 * (e.g. two localhost ports) but always have distinct labels.
 */
async function getCurrentAppName() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  return getAppNameForUrl(tab.url);
}

/**
 * Reads recent error/fatal rows for the current tab's app_name from the
 * local log server.
 */
async function renderRecentErrors() {
  const listEl = document.getElementById("errorList");
  listEl.innerHTML = "";

  const appName = await getCurrentAppName();
  if (!appName) {
    listEl.innerHTML = '<li class="empty">This site isn\'t on the allowlist.</li>';
    return;
  }

  const { serverUrl } = await chrome.storage.local.get(["serverUrl"]);
  if (!serverUrl) {
    listEl.innerHTML = '<li class="empty">Set up the log server URL in Settings first.</li>';
    return;
  }

  try {
    const params = new URLSearchParams({
      app: appName,
      level: "error,fatal",
      minutes: "1440",
      limit: "5",
    });
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/logs/recent?${params}`);
    const { rows } = await res.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.innerHTML = `<li class="empty">No recent errors for ${appName}.</li>`;
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const time = new Date(row.created_at).toLocaleTimeString();
      li.textContent = `${time} — ${row.message}`;
      listEl.appendChild(li);
    }
  } catch {
    listEl.innerHTML = '<li class="empty">Couldn\'t reach the log server — is it running?</li>';
  }
}

document.getElementById("flushBtn").addEventListener("click", async (e) => {
  e.target.textContent = "Flushing...";
  await chrome.runtime.sendMessage({ type: "FLUSH_NOW" });
  e.target.textContent = "Flushed.";
  setTimeout(() => (e.target.textContent = "Flush queued logs now"), 1500);
});

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("openViewerBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("logs.html") });
});

// -- forward-to-backend toggles -----------------------------------------------

async function renderForwardConfig() {
  const config = await getForwardConfig();
  for (const input of document.querySelectorAll("#forwardConfig input[type=checkbox]")) {
    input.checked = !!config[input.dataset.key];
    input.addEventListener("change", async () => {
      await setForwardConfig({ [input.dataset.key]: input.checked });
      // No explicit save button — background.js picks this up immediately
      // via chrome.storage.onChanged, so it applies to the very next event.
    });
  }
}

renderForwardConfig();

renderStatus();
renderRecentErrors();
