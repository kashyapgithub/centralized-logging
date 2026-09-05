"""
logger_client.py — centralized logging client for Python apps.

Talks to server.py over plain HTTP — no account, no API key. Copy this file
into the target app. Batches events in memory and flushes them in the
background, so a log call never blocks the request/response path.

Usage:
    from logger_client import CentralLogger

    logger = CentralLogger(app_name="my-python-app")   # defaults to http://127.0.0.1:4317

    logger.info("worker started", context={"pid": os.getpid()})
    logger.warn("slow query", context={"duration_ms": 4200})

    try:
        risky_operation()
    except Exception:
        logger.exception("risky_operation failed", context={"job_id": job.id})

    logger.flush()   # optional — call on graceful shutdown to drain the queue
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
import queue
import re
import socket
import sys
import threading
import time
import traceback
from typing import Any, Optional

import requests

_DIGITS_RE = re.compile(r"\d+")
DEFAULT_SERVER_URL = os.environ.get("LOG_SERVER_URL", "http://127.0.0.1:4317")


def _fingerprint(error_type: Optional[str], message: str) -> str:
    """
    Hash (error_type + message-with-digits-stripped) so that, e.g.,
    "user 4821 not found" and "user 77 not found" collapse into the same
    fingerprint instead of showing up as two separate 'distinct' errors.
    """
    normalized = _DIGITS_RE.sub("#", message or "")
    raw = f"{error_type or ''}:{normalized}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


class CentralLogger:
    """
    Batched, non-blocking logger that writes rows into the local log
    server (server.py) via a plain HTTP POST — no headers, no auth.
    """

    def __init__(
        self,
        app_name: str,
        server_url: str = DEFAULT_SERVER_URL,
        environment: str = "production",
        flush_interval_seconds: float = 2.0,
        max_batch_size: int = 50,
    ) -> None:
        self.app_name = app_name
        self.environment = environment
        self._endpoint = f"{server_url.rstrip('/')}/logs"
        self._host = socket.gethostname()
        self._queue: "queue.Queue[dict]" = queue.Queue()
        self._max_batch_size = max_batch_size
        self._flush_interval = flush_interval_seconds

        self._stop_event = threading.Event()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()
        atexit.register(self.flush)

    # -- public logging API --------------------------------------------------

    def debug(self, message: str, **kwargs: Any) -> None:
        self._enqueue("debug", message, **kwargs)

    def info(self, message: str, **kwargs: Any) -> None:
        self._enqueue("info", message, **kwargs)

    def warn(self, message: str, **kwargs: Any) -> None:
        self._enqueue("warn", message, **kwargs)

    def error(self, message: str, **kwargs: Any) -> None:
        self._enqueue("error", message, **kwargs)

    def fatal(self, message: str, **kwargs: Any) -> None:
        self._enqueue("fatal", message, **kwargs)

    def exception(self, message: str, **kwargs: Any) -> None:
        """
        Call this from inside an `except:` block — captures the current
        exception's type and full traceback automatically.
        """
        exc_type, exc_value, exc_tb = sys.exc_info()
        error_type = exc_type.__name__ if exc_type else None
        stack_trace = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        self._enqueue(
            "error",
            message,
            error_type=error_type,
            stack_trace=stack_trace,
            **kwargs,
        )

    # -- internals ------------------------------------------------------------

    def _enqueue(
        self,
        level: str,
        message: str,
        *,
        error_type: Optional[str] = None,
        stack_trace: Optional[str] = None,
        context: Optional[dict] = None,
        request_id: Optional[str] = None,
        session_id: Optional[str] = None,
        user_ref: Optional[str] = None,
        tags: Optional[list] = None,
        duration_ms: Optional[float] = None,
        source_file: Optional[str] = None,
        source_line: Optional[int] = None,
        source_function: Optional[str] = None,
    ) -> None:
        row = {
            "app_name": self.app_name,
            "environment": self.environment,
            "host": self._host,
            "level": level,
            "message": message,
            "error_type": error_type,
            "stack_trace": stack_trace,
            "context": context or {},
            "fingerprint": _fingerprint(error_type, message),
            "request_id": request_id,
            "session_id": session_id,
            "user_ref": user_ref,
            "tags": tags or [],
            "duration_ms": duration_ms,
            "source_file": source_file,
            "source_line": source_line,
            "source_function": source_function,
        }
        self._queue.put(row)

    def _run(self) -> None:
        """Background thread: batch up queued rows and flush periodically."""
        while not self._stop_event.is_set():
            time.sleep(self._flush_interval)
            self._drain_and_send()

    def _drain_and_send(self) -> None:
        batch = []
        while len(batch) < self._max_batch_size:
            try:
                batch.append(self._queue.get_nowait())
            except queue.Empty:
                break
        if not batch:
            return
        try:
            requests.post(self._endpoint, json=batch, timeout=5)
        except requests.RequestException:
            # Logging must never crash the app it's logging for. If the log
            # server isn't running, drop the batch silently rather than raise.
            pass

    def flush(self) -> None:
        """Force an immediate send of whatever's queued. Call on shutdown."""
        self._drain_and_send()
