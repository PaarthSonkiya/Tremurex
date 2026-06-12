"""Multi-sample JSON Schema inference (CLAUDE.md §8, §9).

Merges N samples into one JSON Schema (draft 2020-12) via genson. genson marks
a field `required` only when it appears in every merged object — that
intersection is exactly the multi-sample baselining semantic that keeps
conditionally-present fields from producing false positives.

Output is canonicalized (sorted object keys, sorted `required`) so identical
inputs serialize to byte-identical schemas (§7.4 determinism).

No enum inference by design (decision 2026-06-12): low-cardinality strings are
indistinguishable from undersampled free text, and inferred enums would cause
false enum-value-removed WARNINGs.
"""

from typing import Any

from genson import SchemaBuilder

SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def infer_schema(samples: list[Any]) -> dict[str, Any]:
    builder = SchemaBuilder(schema_uri=SCHEMA_DIALECT)
    for sample in samples:
        builder.add_object(sample)
    return _canonicalize(builder.to_schema())


def _canonicalize(node: Any) -> Any:
    if isinstance(node, dict):
        return {
            key: sorted(value) if key == "required" else _canonicalize(value)
            for key, value in sorted(node.items())
        }
    if isinstance(node, list):
        return [_canonicalize(item) for item in node]
    return node
