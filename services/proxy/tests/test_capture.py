from proxy_addon.capture import (
    decode_json_body,
    host_key,
    is_json_content_type,
    parse_targets,
    should_forward,
)


class TestHostKey:
    def test_fills_default_ports(self):
        assert host_key("https://api.example.com/v1/users") == "api.example.com:443"
        assert host_key("http://api.example.com/v1") == "api.example.com:80"

    def test_keeps_explicit_port(self):
        assert host_key("https://api.example.com:8443/v1") == "api.example.com:8443"

    def test_rejects_non_http(self):
        assert host_key("ftp://x.test/a") is None
        assert host_key("garbage") is None


class TestIsJsonContentType:
    def test_accepts_json_and_suffix(self):
        assert is_json_content_type("application/json")
        assert is_json_content_type("application/json; charset=utf-8")
        assert is_json_content_type("application/vnd.github+json")

    def test_rejects_others_and_missing(self):
        assert not is_json_content_type("text/html")
        assert not is_json_content_type(None)
        assert not is_json_content_type("")


class TestShouldForward:
    hosts = frozenset({"api.example.com:443"})

    def test_forwards_successful_json_for_monitored_host(self):
        assert should_forward(
            "https://api.example.com/v1/users", 200, "application/json", self.hosts
        )

    def test_skips_unmonitored_host(self):
        assert not should_forward(
            "https://other.test/x", 200, "application/json", self.hosts
        )

    def test_skips_non_2xx(self):
        assert not should_forward(
            "https://api.example.com/v1/users", 500, "application/json", self.hosts
        )
        assert not should_forward(
            "https://api.example.com/v1/users", 304, "application/json", self.hosts
        )

    def test_skips_non_json(self):
        assert not should_forward(
            "https://api.example.com/v1/users", 200, "text/html", self.hosts
        )

    def test_skips_when_no_targets(self):
        assert not should_forward(
            "https://api.example.com/v1/users", 200, "application/json", frozenset()
        )


class TestDecodeJsonBody:
    def test_parses_valid_json(self):
        assert decode_json_body(b'{"a": 1}') == {"a": 1}
        assert decode_json_body(b"[1, 2, 3]") == [1, 2, 3]

    def test_returns_none_for_invalid_or_empty(self):
        assert decode_json_body(b"") is None
        assert decode_json_body(b"<html></html>") is None
        assert decode_json_body(b"\xff\xfe") is None


class TestParseTargets:
    def test_extracts_string_hosts(self):
        assert parse_targets({"hosts": ["a:443", "b:80"]}) == frozenset({"a:443", "b:80"})

    def test_defensive_against_bad_shapes(self):
        assert parse_targets({}) == frozenset()
        assert parse_targets({"hosts": "nope"}) == frozenset()
        assert parse_targets([1, 2]) == frozenset()
        assert parse_targets({"hosts": ["ok", 5, None]}) == frozenset({"ok"})
