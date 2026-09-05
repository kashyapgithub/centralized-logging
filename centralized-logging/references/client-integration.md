# Client Integration — getting logs INTO `app_logs`

Every app writes events the same way underneath: an HTTPS `POST` to Supabase's
auto-generated REST endpoint for the `app_logs` table. No custom server to
write or host — Supabase's PostgREST layer *is* the ingest API.

```
POST {SUPABASE_URL}/rest/v1/app_logs
Headers:
  apikey: {SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY}
  Authorization: Bearer {same key}
  Content-Type: application/json
  Prefer: return=minimal
Body: a JSON object matching the app_logs columns (see database-schema.md)
```

Use the **service key** server-side (trusted environments — it bypasses RLS).
Use the **anon key** in browser/mobile/anything untrusted — the RLS policy
restricts it to insert-only, so a leaked key can't read or corrupt history.

This one recipe is enough for **any language** that can make an HTTPS request
— which is all of them. Below are ready-made versions for the common cases;
skip straight to "Generic HTTP / cURL" for anything else.

---

## Generic HTTP / cURL (works for literally any language)

```bash
curl -X POST "$SUPABASE_URL/rest/v1/app_logs" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
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
nothing Supabase-specific about the call beyond the two headers.

**Fingerprint, computed the same way everywhere:** hash of
`error_type + ":" + message-with-digits-replaced-by-#`. Any language's
standard-library SHA-256 can do this — the point is consistency, not a
specific algorithm.

---

## Node.js

Use `scripts/logger_client.js` as-is or as a starting point — zero
dependencies (built-in `fetch`, Node 18+). It batches writes and flushes on a
timer so logging never blocks the request path.

```js
const { CentralLogger } = require('./logger_client');

const logger = new CentralLogger({
  appName: 'my-node-app',
  environment: process.env.NODE_ENV,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
});

// plain event
logger.info('server started', { port: 3000 });

// caught exception — captures stack trace + fingerprint automatically
try {
  await chargeCard(order);
} catch (err) {
  logger.error(err, { orderId: order.id, requestId: req.id });
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
    supabase_url=os.environ["SUPABASE_URL"],
    supabase_key=os.environ["SUPABASE_SERVICE_KEY"],
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

No bundled client (keep the skill lean) — the generic pattern is short enough
to inline directly:

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
    req, _ := http.NewRequest("POST", os.Getenv("SUPABASE_URL")+"/rest/v1/app_logs", bytes.NewReader(body))
    key := os.Getenv("SUPABASE_SERVICE_KEY")
    req.Header.Set("apikey", key)
    req.Header.Set("Authorization", "Bearer "+key)
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Prefer", "return=minimal")
    _, err := http.DefaultClient.Do(req)
    return err
}
```

## Browser / client-side JS

Same shape, but use the **anon key** (never ship the service key to a
browser) and keep payloads free of anything sensitive, since RLS here is
insert-only, not "trusted":

```js
fetch(`${SUPABASE_URL}/rest/v1/app_logs`, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  },
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
