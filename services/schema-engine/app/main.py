"""Tremurex schema-engine: stateless JSON Schema inference sidecar.

Holds no state and makes no outbound network calls (CLAUDE.md §7.1).
"""

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.inference import infer_schema

app = FastAPI(title="tremurex-schema-engine", version="0.0.0")


# Core's baseline window caps at 100; 1000 is generous headroom while bounding
# how much genson work one request can demand (defends the engine against a DoS
# even though core is the only intended caller).
MAX_SAMPLES = 1000


class InferRequest(BaseModel):
    samples: list[Any] = Field(min_length=1, max_length=MAX_SAMPLES)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "schema-engine"}


@app.post("/infer")
def infer(request: InferRequest) -> dict[str, Any]:
    return {"schema": infer_schema(request.samples)}
