---
id: agent-voice
name: Voice Personas (Mars + Venus)
version: 0.1.0
description: WebRTC-first voice agent reference (Mars + Venus personas, optional Twilio adapter). Skillpack-as-reference paradigm — the install-time agent COPIES code into your host agent repo where it becomes user-owned and mutable, NOT a runtime gbrain dependency.
category: voice
install_kind: copy-into-host-repo
requires: []
secrets:
  - name: OPENAI_API_KEY
    description: OpenAI API key with Realtime API access enabled
    where: https://platform.openai.com/api-keys — click "+ Create new secret key", copy immediately
  - name: TWILIO_ACCOUNT_SID
    description: (optional) Twilio Account SID — only if wiring inbound Twilio calls
    where: https://www.twilio.com/console
  - name: TWILIO_AUTH_TOKEN
    description: (optional) Twilio auth token — only if wiring inbound Twilio calls
    where: https://www.twilio.com/console
health_checks:
  - type: env_exists
    var: OPENAI_API_KEY
    label: OPENAI_API_KEY present
setup_time: 10 min
cost_estimate: "$0.06-0.24/min OpenAI Realtime, optional $1-2/mo Twilio number"
---

# Voice Personas: Mars + Venus

A reference voice agent (WebRTC-first; OpenAI Realtime) shipped as **copy-into-your-repo** content rather than runtime gbrain skills. The install-time agent reads this recipe, copies the bundle into your host agent repo (e.g. `~/git/your-agent-repo/`), wires the resolver, and starts the voice server. From there, the code lives in YOUR repo, on YOUR cadence, with YOUR edits.

## What ships in the bundle

- **Two personas** — Mars (introspective thought partner; voice `Orus`) and Venus (sharp executive assistant; voice `Aoede`).
- **WebRTC browser client** at `/call?test=1` for the production-grade voice loop. Production load installs zero test instrumentation; `?test=1` enables Web Audio API tee → MediaRecorder capture for the E2E.
- **Tool router** with a read-only allow-list by default (search, query, get_page, list_pages, find_experts, get_recent_salience, get_recent_transcripts, read_article). Write ops are denylisted; operators opt in to a bounded set via local override.
- **Persona-aware prompt builder** with identity-first composition + Unicode sanitization for Realtime API safety.
- **Optional Twilio adapter** (`/voice` TwiML, WSS bridge) for phone inbound. Skip if you only want browser voice.
- **Three skills** for resolver routing: `voice-persona-mars`, `voice-persona-venus`, `voice-post-call`.
- **Unit + E2E tests** that ride with the copy. PII-shape regex guards every prompt, classifier triages upstream vs plumbing failures.

## The skillpack-as-reference paradigm

Earlier gbrain skillpacks installed to `~/.gbrain/skills/<name>/` as managed-block-canonical first-class skills. The user's local edits drifted from the canonical and updates were either "overwrite local" or "skip update" — neither is what an operator wants on code they've extended.

This recipe ships a different shape: gbrain holds the up-to-date REFERENCE, and `gbrain integrations install agent-voice --target <host-repo>` COPIES it into the operator's repo. The code now lives in the host repo, on the operator's release cadence, with the operator's edits. Subsequent `--refresh` invocations diff host-side files against gbrain's reference and propose changes; the operator picks per-file (keep mine / take theirs / merge).

The shipped reference does NOT contain personal names, hardcoded private paths, or upstream-agent codenames. A CI guard (`scripts/check-no-pii-in-agent-voice.sh`) blocks any drift back; a deterministic import script (`scripts/import-from-upstream.sh`) refreshes the gbrain reference from an upstream voice-agent source.

## Install

```bash
# 1. Detect target repo
export TARGET_REPO=$OPENCLAW_WORKSPACE     # or your agent repo path

# 2. Install
gbrain integrations install agent-voice --target $TARGET_REPO

# 3. Set env vars in $TARGET_REPO/.env (NOT in gbrain)
echo "OPENAI_API_KEY=sk-..." >> $TARGET_REPO/.env
echo "DEFAULT_PERSONA=venus" >> $TARGET_REPO/.env

# 4. Implement context builder (optional but recommended)
# Replace $TARGET_REPO/services/voice-agent/code/lib/context-builder.example.mjs
# with your operator-specific implementation. See the contract at:
#   $TARGET_REPO/services/voice-agent/code/lib/personas/context-builder.contract.md

# 5. Run host-side tests
cd $TARGET_REPO/services/voice-agent && bun install && bun run test
# OR if your repo uses npm: npm install && npm test

# 6. Start the voice server
cd $TARGET_REPO/services/voice-agent && bun run start
# Voice agent listens on http://localhost:8765
```

Open `http://localhost:8765/call` and click Connect. The browser asks for mic permission; once granted, it does an SDP exchange via `POST /session`, the OpenAI Realtime API returns the SDP answer, and audio flows bidirectionally over WebRTC.

For test-mode roundtrip checks, append `?test=1` to the URL — that enables the `window._gbrainTest` instrumentation namespace + MediaRecorder capture of the response audio.

## Update (refresh from gbrain)

```bash
# Pull latest gbrain → re-run the install with --refresh
git -C $(which gbrain | xargs -I{} dirname {})/.. pull   # or your gbrain update path
gbrain integrations install agent-voice --target $TARGET_REPO --refresh
```

`--refresh` reads the `.gbrain-source.json` manifest written by the original install, re-computes per-file SHA-256 against gbrain's current reference, and classifies each file:

- **unchanged-identical** — host file matches gbrain reference; skip.
- **unchanged-stale** — host file matches the recorded SHA but reference moved; offer to update.
- **locally-modified** — host file diverges from the recorded SHA; show diff, offer three options (keep mine / take theirs / merge).
- **source-deleted** — gbrain reference removed a file; offer cleanup.
- **source-renamed** — detected via path-mapping; offer to follow.

A transaction journal at `<target>/services/voice-agent/.gbrain-source.refresh.log` allows partial-apply recovery if the refresh is interrupted.

## Architecture

```
                Browser (call.html)
                       │
                       │  WebRTC (mic + remote audio + data channel)
                       ▼
              ┌─────────────────────┐
              │   server.mjs (8765) │
              │   ─────────────     │
   ┌──────────┤  GET  /call         │      POST /session
   │ static   │  GET  /health        ├──────────────────▶  api.openai.com/v1/realtime/calls
   │ files    │  POST /session       │       (SDP exchange via FormData)
   └──────────┤  POST /tool          │
              │  POST /voice  (Twi.) │
              │  WSS  /ws     (Twi.) │
              └──────────┬───────────┘
                         │  /tool dispatches through tools.mjs allow-list
                         ▼
              ┌─────────────────────┐
              │  tools.mjs router    │
              │  ─────────────       │   denylist: put_page, submit_job, file_upload, ...
              │  READ_ONLY_OPS only  │   allow-list: 8 read ops; operator extends optional ops via override
              └──────────┬───────────┘
                         │
                         ▼  stdio JSON-RPC
              ┌─────────────────────┐
              │  gbrain serve (MCP)  │
              └─────────────────────┘
```

## Production checklist

Reference code ships intentionally minimal. Before public deployment:

- **Twilio signature validation** on `/voice` — currently absent; add `X-Twilio-Signature` header validation.
- **Rate limiting** on `/session` and `/tool` — currently absent.
- **CORS allowlist** — currently `*`; restrict to your deployed origins.
- **Auth on /tool** — voice-side tool calls currently trust the in-process connection; if you expose `/tool` publicly, gate it behind a session token.
- **HTTPS** — required for browser mic access in production. Use ngrok / Caddy / Cloudflare Tunnel.
- **Twilio fallback URL** — `/fallback` is a TwiML stub; wire to your operator's cell for crash recovery.
- **PII scrub at context-builder** — the shipped `context-builder.example.mjs` includes phone/email regex scrubs, but operators should extend per their brain's PII pattern set.

## Tests

```bash
cd $TARGET_REPO/services/voice-agent
bun run test                   # host-side unit tests (5 suites, ~100 cases)
AGENT_VOICE_E2E=1 bun run test:e2e             # WebRTC roundtrip (~$0.10/run)
AGENT_VOICE_FULL_E2E=1 bun run test:full-flow  # openclaw-driven install + roundtrip (~$1-2/run)
```

The full-flow E2E is **friction-discovery**, not a ship-gate. Pre-ship gates on host-side unit tests and the PII guard; flakes in the live OpenAI Realtime path soft-fail with `STATUS: skipped_upstream_degraded` and log to the friction channel.

## What's deferred

- DIY STT+LLM+TTS pipeline (`pipeline.mjs`, `pipeline-v3.mjs` for Gemini Live) — recipe Option A (WebRTC direct to OpenAI Realtime) ships now; Option B (Deepgram + Claude + Cartesia) is a follow-up wave.
- Multilingual Mars — the persona drops the multilingual claim until a multilingual eval lands; restoring it is gated on the eval.
- Live cross-call memory between sessions — the persona is session-scoped today.
- Pre-computed engagement-bid system (the "Bid System" pattern from production deployments) — would belong in `prompt.mjs`.
- Smart VAD presets (quiet/normal/noisy/very_noisy) — uses Realtime API's default VAD today.
- WebRTC `/session` does not yet ship MediaRecorder fallback for environments where the WebAudio-tee fails.

Each of the deferred items is filed as a TODO in the gbrain repo's `TODOS.md`.
