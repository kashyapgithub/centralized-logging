/**
 * logs.js — the "copy-paste into any LLM" viewer. Polls background.js's
 * in-memory ring buffer (no local server needed) and renders it live.
 *
 * The dropdown lists app labels (from lib/allowlist.js), not raw
 * hostnames — two projects sharing a hostname (e.g. two localhost ports)
 * show up as distinct entries here, named whatever you labeled them.
 */

const POLL_INTERVAL_MS = 1000;
const APP_LIST_REFRESH_MS = 3000;

const appSelect = document.getElementById("hostnameSelect");
const logEl = document.getElementById("log");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");
const copyStatus = document.getElementById("copyStatus");
const filterCheckboxes = [...document.querySelectorAll("#filters input[type=checkbox]")];

let currentAppName = null;
let currentRows = [];

function activeTypes() {
  return new Set(filterCheckboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.type));
}

async function refreshAppList() {
  const { attachedTabs } = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  const appNames = [...new Set((attachedTabs || []).map(([, appName]) => appName))];

  const previousValue = appSelect.value;
  appSelect.innerHTML = "";
  if (appNames.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No captured tabs open";
    appSelect.appendChild(opt);
    currentAppName = null;
    return;
  }
  for (const appName of appNames) {
    const opt = document.createElement("option");
    opt.value = appName;
    opt.textContent = appName;
    appSelect.appendChild(opt);
  }
  // Keep the user's selection if it's still valid, otherwise pick the first.
  appSelect.value = appNames.includes(previousValue) ? previousValue : appNames[0];
  currentAppName = appSelect.value;
}

function formatRow(row) {
  const time = new Date(row.timestamp).toLocaleTimeString();
  return { time, ...row };
}

function renderRows() {
  const types = activeTypes();
  const visible = currentRows.filter((row) => types.has(row.type));

  logEl.innerHTML = "";
  if (visible.length === 0) {
    logEl.innerHTML = '<div class="empty">Nothing matching the current filters yet.</div>';
    return;
  }

  for (const row of visible) {
    const div = document.createElement("div");
    div.className = "row";
    const { time } = formatRow(row);
    div.innerHTML =
      `<span class="time">${time}</span>` +
      `<span class="level level-${row.level}">${row.level.toUpperCase()}</span>` +
      escapeHtml(row.message);
    if (row.stack_trace) {
      const stackDiv = document.createElement("div");
      stackDiv.className = "stack";
      stackDiv.textContent = row.stack_trace;
      div.appendChild(stackDiv);
    }
    logEl.appendChild(div);
  }
  // Keep the view pinned to the latest entry.
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Plain-text block, formatted to be pasted straight into a chat with an LLM. */
function buildCopyText() {
  const types = activeTypes();
  const visible = currentRows.filter((row) => types.has(row.type));
  return visible
    .map((row) => {
      const { time } = formatRow(row);
      let line = `[${time}] ${row.level.toUpperCase()} ${row.message}`;
      if (row.stack_trace) line += `\n${row.stack_trace}`;
      return line;
    })
    .join("\n");
}

async function pollLogs() {
  if (!currentAppName) {
    currentRows = [];
    renderRows();
    return;
  }
  const { rows } = await chrome.runtime.sendMessage({ type: "GET_LOGS", appName: currentAppName });
  currentRows = rows || [];
  renderRows();
}

appSelect.addEventListener("change", () => {
  currentAppName = appSelect.value;
  pollLogs();
});

for (const cb of filterCheckboxes) {
  cb.addEventListener("change", renderRows);
}

copyBtn.addEventListener("click", async () => {
  const text = buildCopyText();
  if (!text) {
    copyStatus.textContent = "Nothing to copy.";
  } else {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = `Copied ${text.split("\n").length} lines.`;
  }
  setTimeout(() => (copyStatus.textContent = ""), 2500);
});

clearBtn.addEventListener("click", async () => {
  if (!currentAppName) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS", appName: currentAppName });
  currentRows = [];
  renderRows();
});

// -- kick off polling loops ---------------------------------------------------

refreshAppList().then(pollLogs);
setInterval(refreshAppList, APP_LIST_REFRESH_MS);
setInterval(pollLogs, POLL_INTERVAL_MS);
