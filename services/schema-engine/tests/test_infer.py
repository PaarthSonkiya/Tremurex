"""Golden-fixture tests for POST /infer (CLAUDE.md §9, multi-sample baselining §8).

Each fixture in tests/fixtures/infer/ holds samples and the expected merged
JSON Schema (draft 2020-12). Determinism (§7.4) is asserted at the byte level.
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "infer"
FIXTURES = sorted(FIXTURE_DIR.glob("*.json"))

client = TestClient(app)


def load(path: Path) -> dict:
    return json.loads(path.read_text())


@pytest.mark.parametrize("fixture_path", FIXTURES, ids=lambda p: p.stem)
def test_infer_matches_golden(fixture_path: Path) -> None:
    fixture = load(fixture_path)
    response = client.post("/infer", json={"samples": fixture["samples"]})
    assert response.status_code == 200
    assert response.json() == {"schema": fixture["expected_schema"]}


@pytest.mark.parametrize("fixture_path", FIXTURES, ids=lambda p: p.stem)
def test_infer_is_byte_deterministic(fixture_path: Path) -> None:
    """§7.4: identical inputs must yield byte-identical output."""
    fixture = load(fixture_path)
    first = client.post("/infer", json={"samples": fixture["samples"]})
    second = client.post("/infer", json={"samples": fixture["samples"]})
    assert first.content == second.content


@pytest.mark.parametrize("fixture_path", FIXTURES, ids=lambda p: p.stem)
def test_infer_output_is_canonical(fixture_path: Path) -> None:
    """Object keys sorted recursively and `required` sorted, so equal schemas
    always serialize to equal bytes regardless of sample key order."""
    fixture = load(fixture_path)
    schema = client.post("/infer", json={"samples": fixture["samples"]}).json()["schema"]
    assert json.dumps(schema) == json.dumps(schema, sort_keys=True)


def test_infer_ignores_sample_key_order() -> None:
    a = client.post("/infer", json={"samples": [{"x": 1, "y": "a"}]})
    b = client.post("/infer", json={"samples": [{"y": "a", "x": 1}]})
    assert a.content == b.content


def test_infer_declares_2020_12_dialect() -> None:
    response = client.post("/infer", json={"samples": [{"a": 1}]})
    assert response.json()["schema"]["$schema"] == "https://json-schema.org/draft/2020-12/schema"


def test_infer_rejects_empty_samples() -> None:
    response = client.post("/infer", json={"samples": []})
    assert response.status_code == 422


def test_infer_rejects_missing_samples() -> None:
    response = client.post("/infer", json={})
    assert response.status_code == 422


def test_infer_rejects_too_many_samples() -> None:
    """Bound genson work per request (DoS guard)."""
    response = client.post("/infer", json={"samples": [{} for _ in range(1001)]})
    assert response.status_code == 422


def test_infer_accepts_non_object_samples() -> None:
    """Top-level scalars/arrays are legal JSON responses too."""
    response = client.post("/infer", json={"samples": [[1, 2], [3]]})
    assert response.status_code == 200
    assert response.json()["schema"]["type"] == "array"
