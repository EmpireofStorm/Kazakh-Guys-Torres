"""Bounded local file decoding shared by HTTP uploads and the clip CLI."""

import json
from pathlib import Path
import subprocess

import cv2
import numpy as np

from audio import SAMPLE_RATE, WINDOW_SAMPLES

MAX_FILE_BYTES = 100 * 1024 * 1024
INPUT_LIMITS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,wav,flac,mp3,ogg,aac"]


def analyze_media(path: Path, video, audio, frame_count: int = 8, additional_evidence: bool = False, generated_image=None):
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
    result = {"videoRisk": None, "voiceRisk": None, "generatedFrameEvidence": None, "framesSampled": 0, "facesFound": 0,
              "voiceSeconds": None, "mediaDurationSeconds": duration, "errors": {}, "calibrated": False, "frames": []}
    if additional_evidence:
        result.update(additionalEvidence=True, voiceStartSeconds=WINDOW_SAMPLES / SAMPLE_RATE)
    if video_stream and (video is not None or generated_image is not None):
        capture = cv2.VideoCapture(str(path))
        scores = []
        generated_scores = []
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
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                # Bound CPU face detection on high-resolution uploads.
                if max(frame.shape[:2]) > 1280:
                    scale = 1280 / max(frame.shape[:2])
                    frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                analyzed = {"deepfakeProbability": 0.0, "faceDetected": False, "model": "UCF-DeepfakeBench"}
                if video is not None:
                    try:
                        analyzed = video(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                    except Exception as error:
                        result["errors"]["video"] = str(error)
                        video = None
                if generated_image is not None:
                    try:
                        generated_score = float(generated_image(rgb))
                        if not np.isfinite(generated_score) or not 0 <= generated_score <= 1:
                            raise ValueError("Generated-frame detector returned an invalid score")
                        generated_scores.append(generated_score)
                        analyzed["generatedImageScore"] = generated_score
                    except Exception as error:
                        result["errors"]["generatedVideo"] = str(error)
                        generated_image = None
                result["framesSampled"] += 1
                result["frames"].append({"seconds": round(float(index / fps), 3), **analyzed})
                if analyzed["faceDetected"]:
                    scores.append(analyzed["deepfakeProbability"])
            if not scores and "video" not in result["errors"]:
                result["errors"]["video"] = "No face detected in sampled frames"
        except Exception as error:
            result["errors"]["video"] = str(error)
            if generated_image is not None:
                result["errors"]["generatedVideo"] = str(error)
        finally:
            capture.release()
        result["facesFound"] = len(scores)
        result["videoRisk"] = float(np.mean(scores)) if scores else None
        if generated_scores:
            # ponytail: frame summaries, not a calibrated video classifier; validate temporal aggregation before replacing UCF.
            result["generatedFrameEvidence"] = {
                "model": "CommunityForensics", "meanScore": float(np.mean(generated_scores)),
                "flaggedFrames": sum(score >= .5 for score in generated_scores),
                "sampledFrames": len(generated_scores), "threshold": .5,
            }
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
            if not np.isfinite(waveform).all():
                raise ValueError("Audio contains non-finite samples")
            # AAC/MP3 float decoding may overshoot full scale; match bounded PCM playback.
            np.clip(waveform, -1, 1, out=waveform)
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
