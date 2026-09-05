/**
 * log-sender.js — batches log rows in memory and POSTs them to the
 * `app_logs` table via Supabase's REST endpoint, using the anon key.
 *
 * The anon key is intentionally used here rather than the service key: the
 * RLS policy from the centralized-logging skill's setup_schema.sql
 * restricts the anon key to INSERT only, so even if this extension's
 * storage were somehow read, the key it holds can't read or tamper with
 * existing log history.
 */

const MAX_BATCH_SIZE = 50;

class LogSender {
  constructor() {
    this.queue = [];
  }

  /** Add one row to the queue; auto-flushes once the batch is large enough. */
  async enqueue(row) {
    this.queue.push(row);
    if (this.queue.length >= MAX_BATCH_SIZE) {
      await this.flush();
    }
  }

  /** Send everything currently queued. Safe to call even if queue is empty. */
  async flush() {
    if (this.queue.length === 0) return;

    const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get([
      "supabaseUrl",
      "supabaseAnonKey",
    ]);

    if (!supabaseUrl || !supabaseAnonKey) {
      // Not configured yet — drop silently rather than pile up forever.
      // The options page nudges the user to set these before anything works.
      this.queue = [];
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);

    try {
      await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/app_logs`, {
        method: "POST",
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      // A dead network / misconfigured Supabase project must never crash
      // the extension. Log to the extension's own console and move on.
      console.error("[central-log-capture] flush failed:", err);
    }
  }
}

export const logSender = new LogSender();
