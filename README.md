# Kazakh-Guys-Torres

AI Tinkerers Hackathon project — **SENTINEL**

Standalone desktop agent for real-time media authenticity during video calls.
It watches a **user-selected** meeting window (not a Zoom/Teams plugin) and
escalates conservatively: LOW RISK → VERIFYING → HIGH MANIPULATION RISK.

It never claims a person “is fake.”

## What’s in this repo

- `models_overview.md` — video (UCF) and voice (AASIST3) research notes
- `desktop/` — Electron + TypeScript SENTINEL app
- `detector/` — FastAPI HTTP contract stub (`POST /analyze`); UCF/AASIST3 not wrapped yet
- `SENTINEL_IMPLEMENTATION_PLAN.md` — architecture and phases

## OpenAI API key (`.env`)

SENTINEL uses the **OpenAI Agents SDK** in the Electron main process. The
deepfake detector is a tool. The agent decides whether evidence is enough,
whether to sample more, and what to show the user.

1. In the **repository root** (same folder as this README), create or open `.env`.
2. You can copy the template:

```bash
copy .env.example .env
```

3. Put your key on one line. No quotes, no spaces around the key:

```
OPENAI_API_KEY=sk-your-key-here
DETECTOR_URL=http://127.0.0.1:8000/analyze
SENTINEL_DETECTOR=mock
```

4. Save the file. `.env` is gitignored — **never commit or paste the key**.
5. Restart the desktop app after any key change (`Ctrl+C`, then `npm run dev` again).
6. In the control panel, **Agent** should read **OpenAI Agents SDK**.
   If it still says **Rules fallback**, the key was not loaded.

The renderer never sees the key. Only the main process reads `.env`.

Without a key the app still runs, but decisions use the deterministic
fallback instead of `@openai/agents`. For the hackathon demo, use a key.

## Run SENTINEL

```bash
cd desktop
npm install
npm run dev
```

1. Confirm **Agent: OpenAI Agents SDK** in the panel.
2. Click **Select Meeting Window**, or **Run scripted demo**.
3. Choose a window or screen (explicit consent) if you used the picker.
4. Watch the preview and the always-on-top overlay.
5. The mock detector walks LOW → VERIFYING → HIGH in about 20 seconds.

**Run scripted demo** walks the same path without capture, if Windows
blocks screen recording.

## Optional HTTP detector

Keep `SENTINEL_DETECTOR=mock` until the Python service is ready. Then:

```
SENTINEL_DETECTOR=http
DETECTOR_URL=http://127.0.0.1:8000/analyze
```

Run `uvicorn` from `detector/` (see `detector/README.md`).

## License

MIT — see `LICENSE`.
