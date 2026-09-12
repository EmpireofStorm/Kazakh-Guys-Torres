"""SENTINEL detector HTTP adapter.

This service exposes ONLY the desktop adapter contract:

  POST /analyze  -> DetectorResult JSON

It does not invent UCF/AASIST3 function signatures. Replace `analyze()`
with the team's pretrained wrappers when those runtimes are checked in.
Until then this is a contract stub so HttpDetectorAdapter can be tested.
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="SENTINEL detector", version="0.1.0")


class AnalyzeRequest(BaseModel):
    jpegBase64: str = Field(min_length=1)
    capturedAt: int | None = None


class AnalyzeResponse(BaseModel):
    deepfakeProbability: float
    faceDetected: bool
    confidence: float | None = None
    model: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "backend": "contract-stub"}


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    has_frame = len(request.jpegBase64) > 32
    return AnalyzeResponse(
        deepfakeProbability=0.12 if has_frame else 0.0,
        faceDetected=has_frame,
        confidence=0.4,
        model="contract-stub",
    )
