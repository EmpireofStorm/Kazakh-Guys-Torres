# Kazakh-Guys-Torres

AI Tinkerers Hackathon project — **SENTINEL**

Standalone desktop agent for real-time media authenticity during video calls.
It watches a **user-selected** meeting window (not a Zoom/Teams plugin) and
escalates conservatively: LOW RISK → VERIFYING → HIGH MANIPULATION RISK.

It never claims a person “is fake.”

## What’s in this repo

- `models_overview.md` — video (UCF) and voice (AASIST3) research notes
- `desktop/` — Electron + TypeScript SENTINEL app (mock detector milestone)
- `detector/` — FastAPI HTTP contract stub (`POST /analyze`); UCF/AASIST3 not wrapped yet
- `SENTINEL_IMPLEMENTATION_PLAN.md` — architecture and phases

## Run SENTINEL

```bash
cd desktop
npm install
npm run dev
```

1. Click **Select Meeting Window**
2. Choose a window or screen (explicit consent)
3. Watch the preview and the always-on-top overlay
4. The mock detector walks LOW → VERIFYING → HIGH in about 20 seconds

Optional: **Run scripted demo** walks LOW → VERIFYING → HIGH without capture,
so the overlay can be shown even if window capture is blocked.

Do not put API keys in renderer code. Copy `.env.example` to `.env` if you
want the optional OpenAI agent path. The demo works without a key.

To point the desktop app at the HTTP contract stub later:

```bash
# .env
SENTINEL_DETECTOR=http
DETECTOR_URL=http://127.0.0.1:8000/analyze
```

Then run `uvicorn` from `detector/` (see `detector/README.md`). Default is still the mock detector.

## License

MIT — see `LICENSE`.
