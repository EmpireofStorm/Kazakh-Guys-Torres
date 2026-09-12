"""Local UCF frame and AASIST3 audio inference for SENTINEL."""

from __future__ import annotations

import base64
import binascii
from contextlib import asynccontextmanager
import io
import logging
import os
from pathlib import Path
import threading
import tempfile
import subprocess

from fastapi import FastAPI, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
import numpy as np
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
import soundfile as sf
from media import analyze_media, MAX_FILE_BYTES

MODELS_DIR = Path(os.environ.get("SENTINEL_MODELS_DIR", Path(__file__).parent / "models"))
DEVICE = os.environ.get("SENTINEL_DEVICE", "cpu")
MAX_BASE64 = 8 * 1024 * 1024
logger = logging.getLogger("sentinel.detector")
# ponytail: one model operation at a time; add batching when multiple callers need throughput.
model_lock = threading.Lock()
models: dict = {}


def get_model(kind: str):
    if kind not in models:
        if kind == "video":
            from video import VideoDetector
            models[kind] = VideoDetector(MODELS_DIR, DEVICE)
        else:
            from audio import AudioDetector
            models[kind] = AudioDetector(MODELS_DIR, DEVICE)
    return models[kind]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm the frame detector before Electron's eight-second request deadline starts.
    try:
        with model_lock:
            get_model("video")
    except Exception:
        logger.exception("Video detector unavailable at startup; run setup_models.py")
    yield


app = FastAPI(title="SENTINEL detector", version="0.2.0", lifespan=lifespan)


class LimitRequestBody:
    """Cap bytes before multipart parsing can spool an unbounded upload."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        limit = MAX_FILE_BYTES + 1024 * 1024 if scope["path"].endswith("/analyze/media") else MAX_BASE64 + 1024
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            return await JSONResponse({"detail": "Request body is too large"}, status_code=413)(scope, receive, send)
        size = 0

        async def limited_receive():
            nonlocal size
            message = await receive()
            size += len(message.get("body", b""))
            if size > limit:
                raise HTTPException(413, "Request body is too large")
            return message

        await self.app(scope, limited_receive, send)


app.add_middleware(LimitRequestBody)


class AnalyzeRequest(BaseModel):
    jpegBase64: str = Field(min_length=1, max_length=MAX_BASE64)
    capturedAt: int | None = None


class AnalyzeResponse(BaseModel):
    deepfakeProbability: float = Field(ge=0, le=1, allow_inf_nan=False)
    faceDetected: bool
    model: str


class AudioRequest(BaseModel):
    audioBase64: str = Field(min_length=1, max_length=MAX_BASE64)


class AudioResponse(BaseModel):
    voiceRisk: float = Field(ge=0, le=1, allow_inf_nan=False)
    analyzedSeconds: float
    model: str = "AASIST3"


class FusionRequest(BaseModel):
    voiceRisk: float = Field(ge=0, le=1, allow_inf_nan=False)
    videoRisk: float = Field(ge=0, le=1, allow_inf_nan=False)


def decode_base64(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise HTTPException(422, "Expected raw base64 without a data URL prefix") from error


def decode_frame(value: str) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(decode_base64(value))) as image:
            if image.format != "JPEG" or min(image.size) < 32 or image.width * image.height > 16_000_000:
                raise ValueError("Expected JPEG, at least 32x32 and at most 16 megapixels")
            return np.asarray(image.convert("RGB"))
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise HTTPException(422, str(error)) from error


def decode_audio(value: str) -> tuple[np.ndarray, int]:
    try:
        with sf.SoundFile(io.BytesIO(decode_base64(value))) as audio:
            if (audio.format not in ("WAV", "FLAC") or not 8000 <= audio.samplerate <= 192000
                    or not 1 <= audio.channels <= 8 or not 0 < audio.frames / audio.samplerate <= 30):
                raise ValueError("Expected WAV/FLAC, 8-192 kHz, 1-8 channels, and at most 30 seconds")
            return audio.read(dtype="float32", always_2d=True), audio.samplerate
    except (ValueError, RuntimeError) as error:
        raise HTTPException(422, str(error)) from error


def infer(kind: str, *inputs):
    if not model_lock.acquire(blocking=False):
        raise HTTPException(503, "Detector is busy; try again shortly")
    try:
        return get_model(kind).analyze(*inputs)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except Exception as error:
        logger.exception("%s inference unavailable", kind)
        raise HTTPException(503, f"{kind.capitalize()} detector unavailable; check service logs and model setup") from error
    finally:
        model_lock.release()


@app.get("/health")
def health():
    return {
        "status": "ok", "backend": "UCF+AASIST3", "device": DEVICE,
        "videoLoaded": "video" in models,
        "audioLoaded": "audio" in models and models["audio"].model is not None,
        "audioWeightsPresent": (MODELS_DIR / "aasist3-weights/model.safetensors").is_file(),
    }


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(request: AnalyzeRequest):
    return infer("video", decode_frame(request.jpegBase64))


@app.post("/analyze/audio", response_model=AudioResponse)
def analyze_audio(request: AudioRequest):
    waveform, sample_rate = decode_audio(request.audioBase64)
    return {"voiceRisk": infer("audio", waveform, sample_rate),
            "analyzedSeconds": min(len(waveform) / sample_rate, 64600 / 16000), "model": "AASIST3"}


@app.post("/combine")
def combine(request: FusionRequest):
    # This endpoint is an explicit caller action. Scores are uncalibrated.
    risk = 1 - (1 - request.voiceRisk) * (1 - request.videoRisk)
    return {"combinedRisk": risk, "tier": "high" if risk > .75 else "medium" if risk >= .3 else "low",
            "method": "noisy-OR", "calibrated": False}


@app.post("/analyze/media")
async def analyze_upload(file: UploadFile, additional_evidence: bool = Form(False, alias="additionalEvidence")):
    try:
        with tempfile.TemporaryDirectory(prefix="sentinel-media-") as directory:
            path = Path(directory) / "upload"
            size = 0
            with path.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise HTTPException(413, "Media exceeds 100 MiB")
                    output.write(chunk)
            return await run_in_threadpool(analyze_media, path,
                lambda frame: infer("video", frame), lambda wave, rate: infer("audio", wave, rate),
                additional_evidence=additional_evidence)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise HTTPException(422, "Could not decode media; use a video or audio file up to five minutes") from error
    finally:
        await file.close()
