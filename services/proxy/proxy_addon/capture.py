"""Pure capture decisions — no mitmproxy, no I/O, fully unit-testable.

Mirrors core's proxy/match.ts host-key normalization so the addon's
pre-filter agrees with core's authoritative matching.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

_DEFAULT_PORTS = {"http": 80, "https": 443}


def host_key(url: str) -> str | None:
    """Return "host:port" with the scheme's default port filled in, or None.

    Only http(s) URLs are considered; anything else returns None.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    port = parts.port or _DEFAULT_PORTS[parts.scheme]
    return f"{parts.hostname}:{port}"


def is_json_content_type(content_type: str | None) -> bool:
    """True for application/json and +json media types (charset params ok)."""
    if not content_type:
        return False
    main = content_type.split(";", 1)[0].strip().lower()
    return main == "application/json" or main.endswith("+json")


def should_forward(
    url: str,
    status_code: int,
    content_type: str | None,
    hosts: frozenset[str],
) -> bool:
    """Whether a response is worth forwarding to core for inference.

    Forward only successful JSON responses whose host is monitored. The host
    set is just a pre-filter so the addon does not ship the user's entire
    browsing stream to core; core still matches authoritatively by full URL.
    """
    if not (200 <= status_code < 300):
        return False
    if not is_json_content_type(content_type):
        return False
    key = host_key(url)
    return key is not None and key in hosts


def decode_json_body(raw: bytes) -> Any | None:
    """Parse a response body as JSON, returning None if it is not valid JSON."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def parse_targets(payload: Any) -> frozenset[str]:
    """Extract the host set from core's /proxy/targets response, defensively."""
    if not isinstance(payload, dict):
        return frozenset()
    hosts = payload.get("hosts")
    if not isinstance(hosts, list):
        return frozenset()
    return frozenset(h for h in hosts if isinstance(h, str))
