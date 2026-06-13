"""Addon wiring tests with a fake flow and a fake core client (no network)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from proxy_addon.forwarder import TremurexAddon


class FakeClient:
    """Stand-in for httpx.AsyncClient that records calls."""

    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []

    async def post(self, url: str, json: Any) -> SimpleNamespace:
        self.posts.append({"url": url, "json": json})
        return SimpleNamespace(status_code=202)

    async def aclose(self) -> None:
        pass


def make_flow(url: str, status: int, content_type: str, raw: bytes) -> SimpleNamespace:
    response = SimpleNamespace(
        status_code=status,
        headers={"content-type": content_type},
        raw_content=raw,
    )
    # SimpleNamespace.headers is a plain dict, which has .get — matches usage.
    return SimpleNamespace(request=SimpleNamespace(pretty_url=url), response=response)


async def drain() -> None:
    """Let detached forward tasks run to completion."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_forwards_monitored_json_response() -> None:
    addon = TremurexAddon(core_url="http://core:4000")
    addon._client = FakeClient()  # type: ignore[assignment]
    addon._hosts = frozenset({"api.example.com:443"})

    flow = make_flow(
        "https://api.example.com/v1/users/1", 200, "application/json", b'{"id": 1}'
    )
    addon.response(flow)  # type: ignore[arg-type]
    await drain()

    client: FakeClient = addon._client  # type: ignore[assignment]
    assert client.posts == [
        {
            "url": "http://core:4000/ingest",
            "json": {"url": "https://api.example.com/v1/users/1", "body": {"id": 1}},
        }
    ]


@pytest.mark.asyncio
async def test_skips_unmonitored_host() -> None:
    addon = TremurexAddon()
    addon._client = FakeClient()  # type: ignore[assignment]
    addon._hosts = frozenset({"api.example.com:443"})

    addon.response(  # type: ignore[arg-type]
        make_flow("https://other.test/x", 200, "application/json", b"{}")
    )
    await drain()
    client: FakeClient = addon._client  # type: ignore[assignment]
    assert client.posts == []


@pytest.mark.asyncio
async def test_skips_non_json_body_even_if_header_lies() -> None:
    addon = TremurexAddon()
    addon._client = FakeClient()  # type: ignore[assignment]
    addon._hosts = frozenset({"api.example.com:443"})

    addon.response(  # type: ignore[arg-type]
        make_flow("https://api.example.com/x", 200, "application/json", b"<html>")
    )
    await drain()
    client: FakeClient = addon._client  # type: ignore[assignment]
    assert client.posts == []


@pytest.mark.asyncio
async def test_core_outage_never_raises_into_the_flow() -> None:
    class ExplodingClient(FakeClient):
        async def post(self, url: str, json: Any) -> SimpleNamespace:
            import httpx

            raise httpx.ConnectError("core is down")

    addon = TremurexAddon()
    addon._client = ExplodingClient()  # type: ignore[assignment]
    addon._hosts = frozenset({"api.example.com:443"})

    # Must not raise — the response hook is fire-and-forget.
    addon.response(  # type: ignore[arg-type]
        make_flow("https://api.example.com/x", 200, "application/json", b"{}")
    )
    await drain()
