"""The mitmproxy addon: observe responses, forward monitored JSON to core.

Strictly passive (CLAUDE.md §2): the response hook reads the flow and never
mutates or delays it — forwarding to core happens on a detached task so the
user's traffic is never blocked, and every error is swallowed so a core
outage can never break the proxied connection.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx
from mitmproxy import http

from proxy_addon.capture import decode_json_body, parse_targets, should_forward

logger = logging.getLogger("tremurex.proxy")


class TremurexAddon:
    def __init__(
        self,
        core_url: str | None = None,
        refresh_seconds: float | None = None,
    ) -> None:
        self.core_url = (core_url or os.environ.get("CORE_URL", "http://core:4000")).rstrip("/")
        self.refresh_seconds = refresh_seconds or float(
            os.environ.get("TREMUREX_REFRESH_SECONDS", "30")
        )
        self._hosts: frozenset[str] = frozenset()
        self._client = httpx.AsyncClient(timeout=5.0)
        self._refresh_task: asyncio.Task[None] | None = None
        self._inflight: set[asyncio.Task[None]] = set()

    # --- mitmproxy lifecycle hooks ---

    def running(self) -> None:
        if self._refresh_task is None:
            self._refresh_task = asyncio.ensure_future(self._refresh_loop())

    async def done(self) -> None:
        if self._refresh_task is not None:
            self._refresh_task.cancel()
        for task in list(self._inflight):
            task.cancel()
        await self._client.aclose()

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.response is None:
            return
        url = flow.request.pretty_url
        content_type = flow.response.headers.get("content-type")
        if not should_forward(url, flow.response.status_code, content_type, self._hosts):
            return
        body = decode_json_body(flow.response.raw_content or b"")
        if body is None:
            return
        # Detach: never make the user's response wait on our bookkeeping.
        task = asyncio.ensure_future(self._forward(url, body))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    # --- internals ---

    async def _forward(self, url: str, body: Any) -> None:
        try:
            await self._client.post(f"{self.core_url}/ingest", json={"url": url, "body": body})
        except httpx.HTTPError as err:
            # Observe-only: a core outage must never affect proxied traffic.
            logger.warning("tremurex: forward to core failed: %s", err)

    async def _refresh_loop(self) -> None:
        while True:
            await self._refresh_targets()
            await asyncio.sleep(self.refresh_seconds)

    async def _refresh_targets(self) -> None:
        try:
            res = await self._client.get(f"{self.core_url}/proxy/targets")
            res.raise_for_status()
            self._hosts = parse_targets(res.json())
        except (httpx.HTTPError, ValueError) as err:
            logger.warning("tremurex: target refresh failed: %s", err)
