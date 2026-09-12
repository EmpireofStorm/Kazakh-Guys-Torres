"""Bounded local file decoding shared by HTTP uploads and the clip CLI."""

import json
from pathlib import Path
import subprocess

import cv2
import numpy as np

from audio import SAMPLE_RATE, WINDOW_SAMPLES

MAX_FILE_BYTES = 100 * 1024 * 1024
INPUT_LIMITS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,wav,flac,mp3,ogg,aac"]


def analyze_media(path: Path, video, audio, frame_count: int = 8, additional_evidence: bool = False):
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE_BYTES:
        raise ValueError("Choose a non-empty media file no larger than 100 MiB")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", *INPUT_LIMITS, "-show_format", "-show_streams", "-of", "json", str(path.resolve())],
        capture_output=True, check=True, timeout=15,
    )
    info = json.loads(probe.stdout)
    streams = info.get("streams", [])
    duration = float(info.get("format", {}).get("duration", 0))
    if not np.isfinite(duration) or not 0 < duration <= 300:
        raise ValueError("Media must have a known duration of at most five minutes")
    video_stream = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    if video_stream is None and not has_audio:
        raise ValueError("No video or audio stream found")
    result = {"videoRisk": None, "voiceRisk": None, "framesSampled": 0, "facesFound": 0,
              "voiceSeconds": None, "errors": {}, "calibrated": False, "frames": []}
    if additional_evidence:
        result.update(additionalEvidence=True, voiceStartSeconds=WINDOW_SAMPLES / SAMPLE_RATE)
    if video_stream and video is not None:
        capture = cv2.VideoCapture(str(path))
        scores = []
        try:
            if video_stream.get("width", 0) * video_stream.get("height", 0) > 16_000_000:
                raise ValueError("Video frames exceed 16 megapixels")
            count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
            fps = capture.get(cv2.CAP_PROP_FPS)
            if not capture.isOpened() or not np.isfinite([count, fps]).all() or count < 1 or fps <= 0:
                raise ValueError("Could not decode video")
            indices = np.linspace(0, count - 1, min(frame_count, int(count)), dtype=int)
            if additional_evidence:
                # Midpoint candidates avoid repeating the initial endpoint samples.
                candidates = np.unique(((np.arange(32) + .5) * int(count) / 32).astype(int))
                candidates = np.setdiff1d(candidates, indices)
                if not len(candidates):
                    raise ValueError("No additional video frames remain after the initial pass")
                indices = candidates[np.linspace(0, len(candidates) - 1, min(16, len(candidates)), dtype=int)]
            for index in indices:
                capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
                ok, frame = capture.read()
                if not ok:
                    raise ValueError("Could not decode a sampled video frame")
                # Bound CPU face detection on high-resolution uploads.
                if max(frame.shape[:2]) > 1280:
                    scale = 1280 / max(frame.shape[:2])
                    frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                analyzed = video(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                result["framesSampled"] += 1
                result["frames"].append({"seconds": round(float(index / fps), 3), **analyzed})
                if analyzed["faceDetected"]:
                    scores.append(analyzed["deepfakeProbability"])
            if not scores:
                result["errors"]["video"] = "No face detected in sampled frames"
        except Exception as error:
            result["errors"]["video"] = str(error)
        finally:
            capture.release()
        result["facesFound"] = len(scores)
        result["videoRisk"] = float(np.mean(scores)) if scores else None
    elif not video_stream:
        result["errors"]["video"] = "No video stream"
    if has_audio and audio is not None:
        try:
            extracted = subprocess.run(
                ["ffmpeg", "-v", "error", *INPUT_LIMITS, "-i", str(path.resolve()),
                 *(["-ss", str(WINDOW_SAMPLES / SAMPLE_RATE)] if additional_evidence else []),
                 "-t", str(WINDOW_SAMPLES / SAMPLE_RATE),
                 "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
                capture_output=True, check=True, timeout=30,
            )
            waveform = np.frombuffer(extracted.stdout, dtype="<f4").copy()
            # ponytail: tails of at least 1s use AASIST3 repeat-padding; raise the minimum after validation.
            if additional_evidence and len(waveform) < SAMPLE_RATE:
                raise ValueError("No additional voice evidence: fewer than one second of audio remains after 4.0375 seconds")
            result["voiceRisk"] = audio(waveform, SAMPLE_RATE)
            result["voiceSeconds"] = min(len(waveform), WINDOW_SAMPLES) / SAMPLE_RATE
        except Exception as error:
            result["errors"]["audio"] = str(error)
    elif not has_audio:
        result["errors"]["audio"] = "No audio stream"
    return result
