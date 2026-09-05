/**
 * logger_client.js — centralized logging client for Node.js apps.
 *
 * Talks to server.py over plain HTTP — no account, no API key. Zero
 * dependencies (uses the built-in `fetch`, Node 18+). Copy this file into
 * the target app. Batches events in memory and flushes on a timer, so a
 * log call never blocks the request/response path.
 *
 * Usage:
 *   const { CentralLogger } = require('./logger_client');
 *
 *   const logger = new CentralLogger({ appName: 'my-node-app' }); // defaults to http://127.0.0.1:4317
 *
 *   logger.info('server started', { context: { port: 3000 } });
 *
 *   try {
 *     await chargeCard(order);
 *   } catch (err) {
 *     logger.error(err, { context: { orderId: order.id }, requestId: req.id });
 *   }
 *
 *   process.on('SIGTERM', () => logger.flush());
 */

const os = require('os');
const crypto = require('crypto');

const DEFAULT_SERVER_URL = process.env.LOG_SERVER_URL || 'http://127.0.0.1:4317';

/**
 * Hash (errorType + message-with-digits-stripped) so repeats of the same
 * underlying bug collapse into one fingerprint instead of showing up as
 * separate 'distinct' errors just because an id in the message differs.
 */
function fingerprint(errorType, message) {
  const normalized = String(message || '').replace(/\d+/g, '#');
  const raw = `${errorType || ''}:${normalized}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

class CentralLogger {
  /**
   * @param {object} opts
   * @param {string} opts.appName
   * @param {string} [opts.serverUrl] defaults to http://127.0.0.1:4317 (or LOG_SERVER_URL)
   * @param {string} [opts.environment='production']
   * @param {number} [opts.flushIntervalMs=2000]
   * @param {number} [opts.maxBatchSize=50]
   */
  constructor({
    appName,
    serverUrl = DEFAULT_SERVER_URL,
    environment = 'production',
    flushIntervalMs = 2000,
    maxBatchSize = 50,
  }) {
    this.appName = appName;
    this.environment = environment;
    this.endpoint = `${serverUrl.replace(/\/$/, '')}/logs`;
    this.host = os.hostname();
    this.maxBatchSize = maxBatchSize;
    this.queue = [];

    this._timer = setInterval(() => this._drainAndSend(), flushIntervalMs);
    this._timer.unref?.(); // don't keep the process alive just for this
  }

  // -- public logging API -----------------------------------------------

  debug(message, opts = {}) {
    this._enqueue('debug', message, opts);
  }

  info(message, opts = {}) {
    this._enqueue('info', message, opts);
  }

  warn(message, opts = {}) {
    this._enqueue('warn', message, opts);
  }

  /**
   * Accepts either a plain string message or an Error object — if given an
   * Error, the stack trace and error type are captured automatically.
   */
  error(messageOrError, opts = {}) {
    this._logErrorLike('error', messageOrError, opts);
  }

  fatal(messageOrError, opts = {}) {
    this._logErrorLike('fatal', messageOrError, opts);
  }

  // -- internals -----------------------------------------------------------

  _logErrorLike(level, messageOrError, opts) {
    if (messageOrError instanceof Error) {
      this._enqueue(level, messageOrError.message, {
        ...opts,
        errorType: messageOrError.name,
        stackTrace: messageOrError.stack,
      });
    } else {
      this._enqueue(level, messageOrError, opts);
    }
  }

  _enqueue(level, message, opts = {}) {
    const {
      errorType = null,
      stackTrace = null,
      context = {},
      requestId = null,
      sessionId = null,
      userRef = null,
      tags = [],
      durationMs = null,
      sourceFile = null,
      sourceLine = null,
      sourceFunction = null,
    } = opts;

    this.queue.push({
      app_name: this.appName,
      environment: this.environment,
      host: this.host,
      level,
      message,
      error_type: errorType,
      stack_trace: stackTrace,
      context,
      fingerprint: fingerprint(errorType, message),
      request_id: requestId,
      session_id: sessionId,
      user_ref: userRef,
      tags,
      duration_ms: durationMs,
      source_file: sourceFile,
      source_line: sourceLine,
      source_function: sourceFunction,
    });

    if (this.queue.length >= this.maxBatchSize) {
      this._drainAndSend();
    }
  }

  async _drainAndSend() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
    } catch {
      // Logging must never crash the app it's logging for — drop silently
      // if the log server isn't reachable rather than throw.
    }
  }

  /** Force an immediate send of whatever's queued. Call on shutdown. */
  async flush() {
    await this._drainAndSend();
  }
}

module.exports = { CentralLogger };
