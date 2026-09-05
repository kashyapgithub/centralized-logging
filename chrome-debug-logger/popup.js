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

  for (const [, hostname] of attachedTabs) {
    const li = document.createElement("li");
    li.textContent = `● ${hostname}`;
    listEl.appendChild(li);
  }
}

async function getCurrentHostname() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).hostname;
  } catch {
    return null;
  }
}

/**
 * Reads recent error/fatal rows for the current tab's hostname straight
 * from Supabase. Requires scripts/remote_control_schema.sql to have been
 * run (it's what grants the anon key SELECT on app_logs — by default the
 * key is insert-only).
 */
async function renderRecentErrors() {
  const listEl = document.getElementById("errorList");
  listEl.innerHTML = "";

  const hostname = await getCurrentHostname();
  if (!hostname) {
    listEl.innerHTML = '<li class="empty">Not on a regular web page.</li>';
    return;
  }

  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get([
    "supabaseUrl",
    "supabaseAnonKey",
  ]);
  if (!supabaseUrl || !supabaseAnonKey) {
    listEl.innerHTML = '<li class="empty">Set up Supabase in Settings first.</li>';
    return;
  }

  try {
    const params = new URLSearchParams({
      app_name: `eq.${hostname}`,
      level: "in.(error,fatal)",
      order: "created_at.desc",
      limit: "5",
      select: "created_at,message",
    });
    const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/app_logs?${params}`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
    });
    const rows = await res.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.innerHTML = `<li class="empty">No recent errors for ${hostname}.</li>`;
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const time = new Date(row.created_at).toLocaleTimeString();
      li.textContent = `${time} — ${row.message}`;
      listEl.appendChild(li);
    }
  } catch {
    listEl.innerHTML = '<li class="empty">Couldn\'t reach Supabase — check your connection.</li>';
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

renderStatus();
renderRecentErrors();
