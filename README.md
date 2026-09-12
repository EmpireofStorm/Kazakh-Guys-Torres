# SENTINEL

An Electron app for investigating video and voice authenticity with a
conversational agent, real detectors, and live meeting evidence.

## Start the app

```bash
cd desktop
npm ci
npm run dev
```

The app opens in **Chat**. Open **Connection**, enter your tool-capable model's
API base URL and model ID, add a key if required, then enable and save the
connection. The endpoint must support OpenAI-compatible Chat Completions,
streaming, and function tools. There is no default cloud endpoint.

For real media analysis, also start the Python service from the repo root:

```bash
detector/.venv/bin/python -m uvicorn server:app --app-dir detector --host 127.0.0.1 --port 8000
```

Both pretrained models and dependencies are installed on this development
machine. For a fresh checkout, follow [detector setup](detector/README.md).

## Agent chat

Attach up to three video or audio files to a message and ask SENTINEL to
investigate them. For example:

- "Analyze this clip. What do the video and voice signals suggest?"
- "Why do those scores disagree?"
- "Read the live evidence, collect more samples, and reassess."

A LangChain agent chooses tools, reads their results, and continues the
conversation. It can:

- Read detector readiness and current live statistics.
- Run UCF and AASIST3 on files you attached to this conversation.
- Gather a second set of distinct video frames and a later audio segment when
  the first result is uncertain, incomplete, or inconsistent.
- Request a bounded sampling window while monitoring is already active,
  wait for it, and read the resulting evidence.

The transcript streams text and shows executed tools and detector result cards.
Video and voice remain separate. **Combine scores** is an explicit action
using the uncalibrated noisy-OR rule. The agent cannot start capture or open
arbitrary files. Media filenames and tool results are treated as data.

Before publishing a media assessment, the agent checks whether more evidence
is needed. An uncertain result triggers another evidence pass before the final
answer. If that pass cannot resolve the uncertainty, the answer must say what
is still missing. Additional sampling does not make the scores calibrated or
guarantee a verdict.

Each turn has a two-minute deadline, eight evidence tool calls, and up to four
finalization checks. It can analyze three distinct attachments, retry an initial
analysis once, gather one distinct additional pass per file, and request one
extra live sampling window. A saved second-pass report is reused on follow-ups;
the same fixed samples are not presented as new evidence. Failed tools return
an error the agent can use to recover.
Stop cancels the turn and blocks late results. Changing the connection or
capture session also cancels an active turn.

The chat layout takes inspiration from [Unsloth Studio's chat interface](https://unsloth.ai/docs/new/studio/chat):
conversation history, attachments, model switching, and visible tool execution.
SENTINEL uses its own media tools and the existing compatible model connection.

Chat text, attachment filenames, and score summaries go to your selected model
endpoint. Raw media goes only to the detector service. Only files sent in a
message are exposed to the agent; removing a pending attachment excludes it.
The latest 20 conversations, with up to 40 messages each, persist in Electron's
user-data directory. API keys are stored separately using OS encryption.

## Live monitoring

In **Live monitor**, choose **Real detector · UCF**, check service readiness,
then select a meeting window or screen. Capture starts after your selection.
UCF analyzes the largest detected face and the app aggregates recent scores.
Live meeting audio is not captured; attach a saved recording to analyze voice.

A background investigation agent can request more samples and publish a
conservative assessment. Local evidence rules operate without a configured
model. While chat is active, background assessments use local rules to avoid
competing model requests. Sparse or expired evidence remains uncertain.

**Run scripted demo** always uses simulated scores without requiring Python
models or screen capture. It restores the previous real/demo selection on Stop.
The overlay labels demo mode.

## Connection settings

Use a base URL including the API prefix, such as `http://localhost:11434/v1`.
Do not append `/chat/completions`. Enter the exact model ID your server exposes.
Keyless local endpoints work. **Test connection** checks a small function-tool
roundtrip without sending media or saving the form.

For [OpenRouter](https://openrouter.ai/docs/quickstart), use the **OpenRouter**
preset (`https://openrouter.ai/api/v1`), your OpenRouter key, and an exact model
ID that [supports tools](https://openrouter.ai/models?supported_parameters=tools).
The connection test verifies the selected model's tool roundtrip. Chat also
requires streaming support.

Settings apply immediately. Keys stay in Electron's main process, are encrypted
using the OS credential service, and are never returned to the renderer.
Changing the base URL clears the old key unless you enter a replacement.

Initial configuration can also come from the gitignored repo-root `.env`:

```dotenv
SENTINEL_LLM_BASE_URL=
SENTINEL_LLM_MODEL=
SENTINEL_LLM_API_KEY=
SENTINEL_DETECTOR=http
DETECTOR_URL=http://127.0.0.1:8000/analyze
```

Saved UI settings take precedence. Legacy `OPENAI_BASE_URL`, `OPENAI_MODEL`,
and `OPENAI_API_KEY` names are accepted together. A key alone does not activate
a provider. Restart after changing `.env`.

## Validation and limits

The imported [Colab prototype](Hackaton.ipynb) uses the same public detector
checkpoints and provides no evidence of better fine-tuned weights. SENTINEL
keeps the current implementation. See the [model comparison](detector/COLAB_COMPARISON.md)
for checkpoint identities, saved results, and API differences.

```bash
cd desktop
npm test
npm run typecheck
npm run build
```

Checks use local endpoints and cover the streaming tool loop, follow-up context,
cancellation, scoped attachments, persistent history, settings, file analysis,
and capture lifecycle. See [detector checks and results](detector/README.md)
for actual model validation.

UCF gave low scores to several synthetic talking-face samples in this repo.
That is a checkpoint generalization limitation. Scores are uncalibrated; a low
score does not prove authenticity. The benchmark figures in
`models_overview.md` were not reproduced in this integration. SENTINEL cannot
infer blinking, lip sync, or other visible artifacts from classifier scores.

Code is MIT licensed. Upstream detector source and checkpoints retain their
own licenses, documented with the downloaded assets.
