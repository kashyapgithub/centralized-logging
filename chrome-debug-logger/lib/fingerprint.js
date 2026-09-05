/**
 * fingerprint.js — same idea as the fingerprinting in the centralized-logging
 * skill's logger_client.py/.js: hash (errorType + message-with-digits-
 * stripped) so 400 occurrences of "user 4821 not found" / "user 77 not
 * found" collapse into one fingerprint in app_error_groups, not 400.
 */

export async function fingerprint(errorType, message) {
  const normalized = String(message || "").replace(/\d+/g, "#");
  const raw = `${errorType || ""}:${normalized}`;
  const bytes = new TextEncoder().encode(raw);
  const digestBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digestBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}
