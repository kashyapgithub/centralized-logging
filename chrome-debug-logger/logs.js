/**
 * logs.js — the "copy-paste into any LLM" viewer. Polls background.js's
 * in-memory ring buffer (no local server needed) and renders it live.
 */

const POLL_INTERVAL_MS = 1000;
const HOSTNAME_REFRESH_MS = 3000;

const hostnameSelect = document.getElementById("hostnameSelect");
const logEl = document.getElementById("log");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");
const copyStatus = document.getElementById("copyStatus");
const filterCheckboxes = [...document.querySelectorAll("#filters input[type=checkbox]")];

let currentHostname = null;
let currentRows = [];

function activeTypes() {
  return new Set(filterCheckboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.type));
}

async function refreshHostnames() {
  const { attachedTabs } = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  const hostnames = [...new Set((attachedTabs || []).map(([, hostname]) => hostname))];

  const previousValue = hostnameSelect.value;
  hostnameSelect.innerHTML = "";
  if (hostnames.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No captured tabs open";
    hostnameSelect.appendChild(opt);
    currentHostname = null;
    return;
  }
  for (const hostname of hostnames) {
    const opt = document.createElement("option");
    opt.value = hostname;
    opt.textContent = hostname;
    hostnameSelect.appendChild(opt);
  }
  // Keep the user's selection if it's still valid, otherwise pick the first.
  hostnameSelect.value = hostnames.includes(previousValue) ? previousValue : hostnames[0];
  currentHostname = hostnameSelect.value;
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
  if (!currentHostname) {
    currentRows = [];
    renderRows();
    return;
  }
  const { rows } = await chrome.runtime.sendMessage({ type: "GET_LOGS", hostname: currentHostname });
  currentRows = rows || [];
  renderRows();
}

hostnameSelect.addEventListener("change", () => {
  currentHostname = hostnameSelect.value;
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
  if (!currentHostname) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS", hostname: currentHostname });
  currentRows = [];
  renderRows();
});

// -- kick off polling loops ---------------------------------------------------

refreshHostnames().then(pollLogs);
setInterval(refreshHostnames, HOSTNAME_REFRESH_MS);
setInterval(pollLogs, POLL_INTERVAL_MS);
