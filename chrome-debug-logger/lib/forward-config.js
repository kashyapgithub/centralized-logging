/**
 * forward-config.js — which categories of captured events actually get
 * sent to server.py, versus staying local-viewer-only.
 *
 * This is separate from the allowlist (allowlist.js decides WHICH SITES
 * get captured at all) and separate from logs.js's viewer filters (which
 * only affect what's DISPLAYED locally, never what's sent anywhere). This
 * file controls the one thing that leaves the browser.
 */

const STORAGE_KEY = "forwardConfig";

// Matches the original built-in behavior: console/exceptions/browser-log
// always forwarded, network failures forwarded, but raw/successful
// network traffic stays viewer-only unless explicitly turned on.
export const DEFAULT_FORWARD_CONFIG = {
  console: true,
  exceptions: true,
  browserLog: true,
  networkFailures: true,
  networkRaw: false,
};

export async function getForwardConfig() {
  const { [STORAGE_KEY]: config } = await chrome.storage.local.get({
    [STORAGE_KEY]: DEFAULT_FORWARD_CONFIG,
  });
  // Merge over defaults so a config saved before a new category existed
  // still gets a sane value for it, instead of `undefined`.
  return { ...DEFAULT_FORWARD_CONFIG, ...config };
}

export async function setForwardConfig(partial) {
  const current = await getForwardConfig();
  const merged = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}
