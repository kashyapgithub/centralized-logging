/**
 * allowlist.js — which sites this extension is allowed to attach to, and
 * what to call each one.
 *
 * Two jobs, both important:
 *
 * 1. Gatekeeping — the extension does NOT run on every site by default.
 *    chrome.debugger can see everything a page does, including
 *    localStorage — that's exactly what makes it useful for debugging your
 *    own apps, and exactly why it should never touch your bank, email, or
 *    anything else you didn't explicitly add.
 *
 * 2. Labeling — each entry has a `label`, which becomes `app_name` on
 *    every log forwarded to the backend. This is what lets you run two
 *    projects side by side (even both on `localhost`, different ports)
 *    and tell them apart everywhere: the popup dropdown, the log viewer,
 *    `query_logs.py --app <label>`, all of it.
 *
 * Entries are stored as { domain, label }. `domain` containing a ":" is
 * matched EXACTLY against the tab's host:port (so "localhost:3000" and
 * "localhost:4000" are distinct entries, on purpose — two local projects
 * sharing a hostname but not a port shouldn't collide into one app_name).
 * A `domain` without a ":" matches by hostname only, port-independent, and
 * also covers subdomains ("myapp.com" matches "app.myapp.com" too) — for
 * real domains this is almost always what you want.
 */

const STORAGE_KEY = "allowlist";

function normalizeEntry(entry) {
  // Accept old-format plain strings too, so a previously saved allowlist
  // (before labels existed) doesn't break — it just gets label = domain.
  if (typeof entry === "string") {
    const domain = entry.trim().toLowerCase();
    return { domain, label: domain };
  }
  const domain = (entry?.domain || "").trim().toLowerCase();
  const label = (entry?.label || domain).trim();
  return { domain, label };
}

/** @returns {Promise<{domain: string, label: string}[]>} */
export async function getAllowlist() {
  const { [STORAGE_KEY]: raw } = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return raw.map(normalizeEntry).filter((e) => e.domain);
}

/** @param {Array<string|{domain: string, label?: string}>} entries */
export async function setAllowlist(entries) {
  const seenDomains = new Set();
  const normalized = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (entry.domain && !seenDomains.has(entry.domain)) {
      seenDomains.add(entry.domain);
      normalized.push(entry);
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

function matchesEntry(entry, url) {
  if (entry.domain.includes(":")) {
    return url.host === entry.domain; // exact host:port — see file header
  }
  return url.hostname === entry.domain || url.hostname.endsWith(`.${entry.domain}`);
}

/**
 * Returns the label for the first allowlist entry matching `urlString`, or
 * null if nothing matches (i.e. this site isn't allowed at all). This is
 * what background.js uses both to decide whether to attach the debugger,
 * and — if so — what app_name to tag every log from this tab with.
 */
export async function getAppNameForUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  const allowlist = await getAllowlist();
  const match = allowlist.find((entry) => matchesEntry(entry, url));
  return match ? match.label : null;
}

/** True if `urlString` matches any allowlist entry at all. */
export async function isAllowed(urlString) {
  return (await getAppNameForUrl(urlString)) !== null;
}
