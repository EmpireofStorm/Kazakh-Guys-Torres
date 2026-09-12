# Detector service

Desktop talks to this process only through `DetectorAdapter`.

- Mock (default): in-process, no Python required
- HTTP: `SENTINEL_DETECTOR=http` and `DETECTOR_URL=http://127.0.0.1:8000/analyze`

## Contract stub (now)

```bash
cd detector
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8000
```

`POST /analyze` body:

```json
{ "jpegBase64": "...", "capturedAt": 1710000000000 }
```

Response:

```json
{
  "deepfakeProbability": 0.12,
  "faceDetected": true,
  "confidence": 0.4,
  "model": "contract-stub"
}
```

This stub is **not** UCF or AASIST3. Swap the body of `analyze()` later without
changing the JSON shape. See `models_overview.md` for the real models:

- Video: UCF / DeepfakeBench (volatile per-frame scores → average, never max)
- Audio: AASIST3, 16 kHz / ~4 s clips, inverted checkpoint labels in research code
- Fusion: noisy-OR, user-requested, not automatic
