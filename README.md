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

## Run SENTINEL

```bash
cd desktop
npm ci
npm run dev
```

1. Configure **Agent connection** as described below.
2. Click **Select Meeting Window**, or **Run scripted demo**.
3. Choose a window or screen if you used the picker.
4. Watch the preview, overlay, and **Agent activity** log.
5. The mock detector supplies low, fluctuating, then elevated scores. The agent's tools determine its next action; the alert timing can vary.

**Run scripted demo** walks the same path without capture, if Windows
blocks screen recording.

## LangChain agent connection

SENTINEL runs a LangChain tool-calling agent in Electron's main process.
It uses your chosen OpenAI-compatible Chat Completions endpoint. There is
no default cloud endpoint and no OpenAI Platform account setup.

In **Agent connection**:

1. Enter the **Base URL**, including the server's API prefix. For example, `http://localhost:11434/v1`. Do not append `/chat/completions`.
2. Enter the exact **Model ID** served by that endpoint. The model must support function tools.
3. Enter an optional **API key**. Keyless local endpoints are supported.
4. Click **Test connection** to verify a small function-tool roundtrip using the form values. This does not save settings or send meeting data.
5. Enable **LangChain agent** and click **Save settings**. Changes apply immediately; an investigation using the previous settings is cancelled.

Settings persist on this device in Electron's user-data directory. API keys
are encrypted using the OS credential service and are never sent back to the
renderer after saving. Changing the base URL clears the previous key unless
you enter a replacement. The key field is cleared after saving.

For initial configuration you can also set `SENTINEL_LLM_BASE_URL`,
`SENTINEL_LLM_MODEL`, and optionally `SENTINEL_LLM_API_KEY` in the gitignored
repo-root `.env`. Saved UI settings take precedence. The legacy names
`OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY` are accepted together;
an API key alone does not enable a provider. Restart after changing `.env`.

The runtime uses LangChain's [custom base URL support](https://docs.langchain.com/oss/javascript/integrations/chat/openai#custom-urls)
and [agent tool loop](https://docs.langchain.com/oss/javascript/langchain/agents).

## What the agent does

The agent reads recent score statistics, chooses whether to request a bounded
sampling window, and publishes an assessment. Requested sampling runs while
the UI remains responsive. Later investigations receive the newly collected
scores. The activity log records executed tools and outcomes, not hidden reasoning.

- Stable low scores use local rules without an LLM request.
- An investigation has a 12-second deadline, a six-tool-call budget, and at most one additional sampling request.
- Requested sampling lasts 2–20 seconds at 1–4 frames per second. The next investigation waits for that window.
- Code enforces evidence requirements for low/high assessments. Sparse or expired evidence remains uncertain.
- Stop cancels model/detector requests and prevents late results from changing the session. Endpoint failures are visible and fall back to local evidence rules.
- Only score summaries go to the LLM endpoint. Raw meeting frames remain on the detector path.

**Detector integration is still separate:** the default detector is simulated,
the HTTP service is a contract stub, and live voice analysis is not connected.
The agent never invents voice evidence or visual artifacts from a risk score.
The current thresholds are demo rules, not calibrated guarantees.

## Checks

```bash
cd desktop
npm test
npm run typecheck
npm run build
```

The checks use local test servers. They exercise tool calls, custom URL/model/key
routing, unavailable endpoints, cancellation, settings persistence, and capture
lifecycle without contacting an external model provider.

## Optional HTTP detector

Keep `SENTINEL_DETECTOR=mock` until the Python service is ready. Then:

```
SENTINEL_DETECTOR=http
DETECTOR_URL=http://127.0.0.1:8000/analyze
```

Run `uvicorn` from `detector/` (see `detector/README.md`).

## License

MIT — see `LICENSE`.
