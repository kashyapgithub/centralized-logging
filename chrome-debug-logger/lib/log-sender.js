/**
 * log-sender.js — batches log rows in memory and POSTs them to the local
 * log server's /logs endpoint. Plain HTTP, no API key — this only ever
 * talks to a server running on the user's own machine.
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

    const { serverUrl } = await chrome.storage.local.get(["serverUrl"]);
    if (!serverUrl) {
      // Not configured yet — drop silently rather than pile up forever.
      // The options page nudges the user to set this before anything works.
      this.queue = [];
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);

    try {
      await fetch(`${serverUrl.replace(/\/$/, "")}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      // A stopped server must never crash the extension. Log to the
      // extension's own console and move on.
      console.error("[central-log-capture] flush failed — is server.py running?", err);
    }
  }
}

export const logSender = new LogSender();
