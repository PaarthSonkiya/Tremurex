"""Tremurex schema-engine: stateless JSON Schema inference sidecar.

Holds no state and makes no outbound network calls (CLAUDE.md §7.1).
/infer lands in Milestone 2.
"""

from fastapi import FastAPI

app = FastAPI(title="tremurex-schema-engine", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "schema-engine"}
