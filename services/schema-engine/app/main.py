"""Tremurex schema-engine: stateless JSON Schema inference sidecar.

Holds no state and makes no outbound network calls (CLAUDE.md §7.1).
"""

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.inference import infer_schema

app = FastAPI(title="tremurex-schema-engine", version="0.0.0")


class InferRequest(BaseModel):
    samples: list[Any] = Field(min_length=1)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "schema-engine"}


@app.post("/infer")
def infer(request: InferRequest) -> dict[str, Any]:
    return {"schema": infer_schema(request.samples)}
