# Client Integration — getting logs INTO the local server

Every app writes events the same way underneath: a plain HTTP `POST` to
`server.py`'s `/logs` endpoint. No API key, no headers beyond
`Content-Type: application/json` — this is a local, single-user tool, not a
public API.

```
POST http://127.0.0.1:4317/logs
Content-Type: application/json
Body: a JSON object (or array of objects) matching the `logs` columns
      (see references/database-schema.md)
```

This one recipe is enough for **any language** that can make an HTTP
request — which is all of them. Below are ready-made versions for the
common cases; skip straight to "Generic HTTP / cURL" for anything else.

If the server runs on a different host/port than the default, set
`LOG_SERVER_URL` in the environment (both bundled clients read it) or pass
`server_url`/`serverUrl` explicitly in code.

---

## Generic HTTP / cURL (works for literally any language)

```bash
curl -X POST http://127.0.0.1:4317/logs \
  -H "Content-Type: application/json" \
  -d '{
    "app_name": "my-app",
    "environment": "production",
    "level": "error",
    "message": "payment webhook failed signature check",
    "error_type": "SignatureError",
    "stack_trace": "...",
    "context": {"order_id": "ord_123", "provider": "razorpay"},
    "fingerprint": "a1b2c3...",
    "request_id": "req_789"
  }'
```

Translate that into whatever HTTP client the language ships with (`fetch`,
`net/http`, `requests`, `HttpClient`, `Invoke-RestMethod`, ...). There is
nothing exotic about the call — it's the plainest possible JSON POST.

**Fingerprint, computed the same way everywhere:** hash of
`error_type + ":" + message-with-digits-replaced-by-#`. Any language's
standard-library SHA-256 can do this — the point is consistency, not a
specific algorithm.

---

## Node.js

Use `scripts/logger_client.js` as-is or as a starting point — zero
dependencies (built-in `fetch`, Node 18+). It batches writes and flushes on
a timer so logging never blocks the request path.

```js
const { CentralLogger } = require('./logger_client');

const logger = new CentralLogger({
  appName: 'my-node-app',
  environment: process.env.NODE_ENV,
  // serverUrl defaults to http://127.0.0.1:4317 (or LOG_SERVER_URL) — omit unless different
});

// plain event
logger.info('server started', { context: { port: 3000 } });

// caught exception — captures stack trace + fingerprint automatically
try {
  await chargeCard(order);
} catch (err) {
  logger.error(err, { context: { orderId: order.id }, requestId: req.id });
}

// global safety net — catches what nothing else caught
process.on('uncaughtException', (err) => logger.fatal(err));
process.on('unhandledRejection', (err) => logger.fatal(err));
```

## Python

Use `scripts/logger_client.py`. It uses a background thread so `.error()` /
`.info()` calls return immediately.

```python
from logger_client import CentralLogger

logger = CentralLogger(
    app_name="my-python-app",
    environment=os.environ.get("ENV", "production"),
    # server_url defaults to http://127.0.0.1:4317 (or LOG_SERVER_URL) — omit unless different
)

logger.info("worker started", context={"pid": os.getpid()})

try:
    process_job(job)
except Exception:
    logger.exception("job failed", context={"job_id": job.id})  # captures traceback

# Flask/FastAPI global handler
@app.exception_handler(Exception)
async def on_error(request, exc):
    logger.exception("unhandled request error", context={"path": str(request.url)})
    ...
```

## Go

No bundled client (keep the skill lean) — the generic pattern is short
enough to inline directly:

```go
type LogEvent struct {
    AppName     string                 `json:"app_name"`
    Environment string                 `json:"environment"`
    Level       string                 `json:"level"`
    Message     string                 `json:"message"`
    ErrorType   string                 `json:"error_type,omitempty"`
    StackTrace  string                 `json:"stack_trace,omitempty"`
    Context     map[string]interface{} `json:"context,omitempty"`
    RequestID   string                 `json:"request_id,omitempty"`
}

func LogEvent(ev LogEvent) error {
    body, _ := json.Marshal(ev)
    req, _ := http.NewRequest("POST", "http://127.0.0.1:4317/logs", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    _, err := http.DefaultClient.Do(req)
    return err
}
```

## Browser / client-side JS

Same shape — the local server's CORS is wide open, so this works straight
from a page:

```js
fetch('http://127.0.0.1:4317/logs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    app_name: 'my-web-app',
    environment: 'production',
    level: 'error',
    message: err.message,
    stack_trace: err.stack,
    context: { url: location.href, userAgent: navigator.userAgent },
  }),
});
```

(For a full browser capture solution rather than hand-adding this to a
page, see the `chrome-debug-logger` extension in the sibling folder — it
does this automatically for any site you allowlist.)

---

## What to capture at every call site

Don't just log the message — that's the one thing you can already see.
Capture what you can't reconstruct after the fact:

- Full `stack_trace`, uncut
- `context` with the actual input/state involved (payload, ids, flags)
- `request_id` / `session_id` so this row can be correlated with everything
  else that happened in the same request or session
- `environment` and `host` if the app runs in more than one place

That's what makes `query_logs.py trace --request-id ...` actually useful
later instead of a wall of disconnected one-liners.
