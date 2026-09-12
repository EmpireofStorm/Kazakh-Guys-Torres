"""Contract and failure checks; no network or pretrained weights required."""

import asyncio
import base64
import io
from pathlib import Path
import subprocess
import tempfile

from fastapi.testclient import TestClient
import httpx
import numpy as np
from PIL import Image
import soundfile as sf

import server
from audio import prepare_audio, SAMPLE_RATE, WINDOW_SAMPLES


def check_additional_evidence(client):
    original_audio = server.models["audio"]
    windows = []

    class AudioWindows:
        def analyze(self, waveform, sample_rate):
            assert sample_rate == SAMPLE_RATE
            windows.append(waveform.copy())
            return .2

    server.models["audio"] = AudioWindows()
    try:
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "windows.wav"
            sf.write(wav, np.r_[np.full(WINDOW_SAMPLES, .1), np.full(WINDOW_SAMPLES, -.2)],
                     SAMPLE_RATE, subtype="FLOAT")
            clip = Path(directory) / "windows.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=4:d=8.1",
                            "-i", str(wav), "-c:v", "ffv1", "-c:a", "pcm_f32le", str(clip)], check=True, timeout=15)

            def upload(path, additional=False):
                response = client.post("/analyze/media", files={"file": (path.name, path.read_bytes())},
                                       data={"additionalEvidence": str(additional).lower()})
                assert response.status_code == 200, response.text
                return response.json()

            first, second = upload(clip), upload(clip, True)
            assert first["framesSampled"] == 8 and second["framesSampled"] == 16
            assert not ({frame["seconds"] for frame in first["frames"]} & {frame["seconds"] for frame in second["frames"]})
            assert "additionalEvidence" not in first and "voiceStartSeconds" not in first
            assert second["additionalEvidence"] is True and second["voiceStartSeconds"] == 4.0375
            assert first["voiceSeconds"] == second["voiceSeconds"] == 4.0375
            assert len(windows) == 2 and all(len(window) == WINDOW_SAMPLES for window in windows)
            np.testing.assert_allclose(windows[0], .1)
            np.testing.assert_allclose(windows[1], -.2)

            single_frame = Path(directory) / "single-frame.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip), "-frames:v", "1", "-an", "-c:v", "ffv1",
                            str(single_frame)], check=True, timeout=15)
            exhausted = upload(single_frame, True)
            assert exhausted["videoRisk"] is None and exhausted["framesSampled"] == 0
            assert "No additional video frames" in exhausted["errors"]["video"]
            for duration in (1, 4.5):
                sf.write(wav, np.full(int(SAMPLE_RATE * duration), .1), SAMPLE_RATE, subtype="FLOAT")
                short = upload(wav, True)
                assert short["voiceRisk"] is None and "fewer than one second" in short["errors"]["audio"]
            assert len(windows) == 2, "Short clips must not rerun the first audio window"
            sf.write(wav, np.full(int(SAMPLE_RATE * 5.5), .3), SAMPLE_RATE, subtype="FLOAT")
            partial = upload(wav, True)
            assert partial["voiceRisk"] == .2 and abs(partial["voiceSeconds"] - (5.5 - 4.0375)) < 1e-6
            invalid = client.post("/analyze/media", files={"file": (wav.name, wav.read_bytes())}, data={"additionalEvidence": "invalid"})
            assert invalid.status_code == 422
    finally:
        server.models["audio"] = original_audio


def main():
    client = TestClient(server.app)
    assert client.post("/analyze", json={"jpegBase64": "invalid!"}).status_code == 422
    assert client.post("/analyze", json={"jpegBase64": base64.b64encode(b"not JPEG").decode()}).status_code == 422
    jpeg = io.BytesIO()
    Image.new("RGB", (64, 64)).save(jpeg, format="JPEG")
    payload = {"jpegBase64": base64.b64encode(jpeg.getvalue()).decode()}
    original_dir = server.MODELS_DIR
    try:
        with tempfile.TemporaryDirectory() as directory:
            server.MODELS_DIR = Path(directory)
            assert client.post("/analyze", json=payload).status_code == 503
        class Video:
            def analyze(self, image):
                assert image.shape == (64, 64, 3) and image.dtype == np.uint8
                return {"deepfakeProbability": .8, "faceDetected": True, "model": "test"}
        server.models["video"] = Video()
        assert client.post("/analyze", json=payload).json()["deepfakeProbability"] == .8
        with server.model_lock:
            assert client.post("/analyze", json=payload).status_code == 503
        class Audio:
            model = True
            def analyze(self, waveform, sample_rate):
                assert waveform.shape in ((16000,), (16000, 1)) and sample_rate == 16000
                prepare_audio(waveform, sample_rate)
                return .2
        server.models["audio"] = Audio()
        wav = io.BytesIO()
        sf.write(wav, np.ones(16000) * .1, 16000, format="WAV")
        response = client.post("/analyze/audio", json={"audioBase64": base64.b64encode(wav.getvalue()).decode()})
        assert response.status_code == 200 and response.json()["voiceRisk"] == .2
        assert response.json()["analyzedSeconds"] == 1
        uploaded = client.post("/analyze/media", files={"file": ("sample.wav", wav.getvalue(), "audio/wav")})
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["voiceRisk"] == .2 and uploaded.json()["videoRisk"] is None
        assert uploaded.json()["errors"]["video"] == "No video stream"
        silence = io.BytesIO()
        sf.write(silence, np.zeros(16000), 16000, format="WAV")
        silent_result = client.post("/analyze/media", files={"file": ("silent.wav", silence.getvalue())}).json()
        assert silent_result["voiceRisk"] is None and "silent" in silent_result["errors"]["audio"]
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "test.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=4:d=1",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
                            "-c:v", "ffv1", "-c:a", "pcm_s16le", str(clip)], check=True, timeout=15)

            def upload_clip(path=clip):
                response = client.post("/analyze/media", files={"file": (path.name, path.read_bytes())})
                assert response.status_code == 200, response.text
                return response.json()

            both = upload_clip()
            assert both["videoRisk"] == .8 and both["voiceRisk"] == .2 and both["errors"] == {}
            assert both["framesSampled"] == both["facesFound"] == 4
            assert "combinedRisk" not in both, "Combining must remain an explicit action"

            class Unavailable:
                def analyze(self, *args):
                    raise FileNotFoundError("Model unavailable")

            server.models["video"] = Unavailable()
            failed_video = upload_clip()
            assert failed_video["videoRisk"] is None and failed_video["voiceRisk"] == .2
            assert "video" in failed_video["errors"]
            server.models["video"] = Video()
            server.models["audio"] = Unavailable()
            failed_audio = upload_clip()
            assert failed_audio["voiceRisk"] is None and failed_audio["videoRisk"] == .8
            assert "audio" in failed_audio["errors"]
            server.models["audio"] = Audio()

            no_audio = Path(directory) / "video-only.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip), "-c:v", "copy", "-an", str(no_audio)],
                           check=True, timeout=15)
            video_only = upload_clip(no_audio)
            assert video_only["voiceRisk"] is None and video_only["videoRisk"] == .8
            assert video_only["errors"]["audio"] == "No audio stream"
        check_additional_evidence(client)
        assert client.post("/analyze/media", files={"file": ("bad.mp4", b"invalid")}).status_code == 422
        assert client.post("/analyze/media", files={"file": ("empty.wav", b"")}).status_code == 422
        too_long = io.BytesIO()
        sf.write(too_long, np.zeros(8000 * 301, dtype=np.float32), 8000, format="WAV")
        assert client.post("/analyze/media", files={"file": ("long.wav", too_long.getvalue())}).status_code == 422
        playlist = b"ffconcat version 1.0\nfile https://example.com/video.mp4\n"
        assert client.post("/analyze/media", files={"file": ("playlist.txt", playlist)}).status_code == 422
        original_limit = server.MAX_FILE_BYTES
        server.MAX_FILE_BYTES = 10
        try:
            assert client.post("/analyze/media", files={"file": ("large.wav", wav.getvalue())}).status_code == 413
            too_large = str(server.MAX_FILE_BYTES + 1024 * 1024 + 1)
            assert client.post("/analyze/media", content=b"", headers={"content-length": too_large}).status_code == 413

            async def check_chunked_limit():
                consumed = 0

                async def chunks():
                    nonlocal consumed
                    yield b'--check\r\nContent-Disposition: form-data; name="file"; filename="large.wav"\r\n\r\n'
                    for _ in range(8192):
                        consumed += 257
                        yield b"x" * 257
                    yield b"\r\n--check--\r\n"

                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://test") as streamed:
                    response = await streamed.post("/analyze/media", content=chunks(),
                                                   headers={"content-type": "multipart/form-data; boundary=check"})
                assert response.status_code == 413, response.text
                assert consumed <= server.MAX_FILE_BYTES + 1024 * 1024 + 257, "Oversized body was fully consumed"

            asyncio.run(check_chunked_limit())
        finally:
            server.MAX_FILE_BYTES = original_limit
        assert client.post("/analyze/audio", json={"audioBase64": payload["jpegBase64"]}).status_code == 422
        assert client.get("/health").json()["audioLoaded"] is True
        fused = client.post("/combine", json={"voiceRisk": .2, "videoRisk": .8}).json()
        assert abs(fused["combinedRisk"] - .84) < 1e-6 and fused["tier"] == "high"
        assert client.post("/combine", json={"voiceRisk": -1, "videoRisk": .8}).status_code == 422
    finally:
        server.models.clear()
        server.MODELS_DIR = original_dir
    print("Service checks passed: media validation, channel preservation, separate evidence windows, request limits, explicit fusion.")


if __name__ == "__main__":
    main()
