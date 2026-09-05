/**
 * allowlist.js — which sites this extension is allowed to attach to.
 *
 * This exists specifically so the extension does NOT run on every site by
 * default. chrome.debugger can see everything a page does, including data
 * in localStorage — that's exactly what makes it useful for debugging your
 * own apps, and exactly why it should never touch your bank, email, or
 * anything else you didn't explicitly add.
 */

const STORAGE_KEY = "allowlist";

/** @returns {Promise<string[]>} the list of allowed domains, e.g. ["localhost", "myapp.com"] */
export async function getAllowlist() {
  const { [STORAGE_KEY]: allowlist } = await chrome.storage.local.get({
    [STORAGE_KEY]: [],
  });
  return allowlist;
}

/** @param {string[]} domains */
export async function setAllowlist(domains) {
  const cleaned = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
  return cleaned;
}

/**
 * True if `url`'s hostname is in the allowlist, or is a subdomain of an
 * allowlisted domain (e.g. "app.myapp.com" matches allowlisted "myapp.com").
 */
export async function isAllowed(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const allowlist = await getAllowlist();
  return allowlist.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}
