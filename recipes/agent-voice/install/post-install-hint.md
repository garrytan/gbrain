# Post-install hint

When `gbrain integrations install agent-voice --target <repo>` completes, print this to stdout (or to the install agent's conversation surface) so the operator knows what to do next.

---

✓ Voice agent reference installed to `<target-repo>/services/voice-agent/`.

**Three follow-up steps before this works end-to-end:**

### 1. Set required env vars in `<target-repo>/.env`

```bash
OPENAI_API_KEY=sk-...              # required (OpenAI Realtime API)
DEFAULT_PERSONA=venus              # optional (one of: venus, mars)
BRAIN_ROOT=/path/to/your/brain     # optional (enables live context)
TIMEZONE=US/Pacific                # optional
HOST=0.0.0.0                       # optional — binds 127.0.0.1 (loopback) by default; set only to expose beyond localhost
AGENT_VOICE_CORS_ORIGIN=https://your.app  # optional — CORS is default-deny; list exact origins (comma-separated) only if a browser on another origin needs access
```

The two security env vars ship safe by default: the server listens on loopback
only and refuses cross-origin browser requests. The local `/call` flow below
needs neither. See the recipe's production checklist before exposing publicly.

Optional for inbound Twilio:
```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

### 2. Implement your context builder (recommended)

The shipped `<target>/services/voice-agent/code/lib/context-builder.example.mjs` is a working example assuming a documented brain layout (`$BRAIN_ROOT/memory/YYYY-MM-DD.md`, `$BRAIN_ROOT/SOUL.md`, etc.). If your brain has a different layout, edit this file to match — the contract at `<target>/services/voice-agent/code/lib/personas/context-builder.contract.md` documents the API.

A degraded operator with no context-builder still gets a working voice agent — Mars asks open questions, Venus answers logistics with a "I can't see your calendar from here — what do you need?" fallback.

### 3. Wire your resolver

This install appended three rows to your `<target>/RESOLVER.md` (or `AGENTS.md`):

```
voice-persona-mars  | "talk to mars", "mars,", "demo mode mars", ...
voice-persona-venus | "venus,", "calendar", "tasks", ...
voice-post-call     | "after the call", "call ended", "transcript", ...
```

Review them. If your resolver uses different conventions, edit per your style.

### 4. Run the host-side tests once

```bash
cd <target-repo>/services/voice-agent
bun install      # or `npm install` if your repo uses npm
bun run test     # all unit suites should pass green
```

If any prompt-shape test fails, the privacy guard has caught a name you'd want to scrub — see `code/lib/personas/private-name-blocklist.json` for the contract.

### 5. Start the server

```bash
cd <target-repo>/services/voice-agent
bun run start    # or `npm start`
# → listening on http://127.0.0.1:8765 (bind: 127.0.0.1 — set HOST=0.0.0.0 to expose beyond loopback)
```

Open `http://localhost:8765/call` in a browser, click Connect, grant mic permission. You should be talking to Venus (or Mars if you set `DEFAULT_PERSONA=mars`).

### 6. (Optional) Run the WebRTC roundtrip E2E — from the gbrain checkout

The install copies **unit tests only**. The E2E and eval suites stay gbrain-side
(under `recipes/agent-voice/tests/`), so run them from your gbrain checkout,
not from `<target-repo>`:

```bash
cd <gbrain-checkout>/recipes/agent-voice && bun install
export AGENT_VOICE_E2E=1 OPENAI_API_KEY=sk-...
bun run test:e2e
# → ~$0.10/run; spawns server, drives puppeteer with a fake-audio WAV
```

Or the full openclaw-wrapped flow (requires `OPENCLAW_BIN`, `ANTHROPIC_API_KEY`):

```bash
export AGENT_VOICE_FULL_E2E=1
gbrain claw-test --scenario voice-agent-install --live --agent openclaw
# → ~$1-2/run; friction-discovery test, NOT a ship gate
```

### 7. (Optional) Run the LLM-judge persona evals — from the gbrain checkout

```bash
cd <gbrain-checkout>/recipes/agent-voice
node tests/evals/mars-eval.mjs   # ~$1-3 for the full 3-model judge sweep
node tests/evals/venus-eval.mjs
```

Live receipts you generate go to `tests/evals/baseline-runs/` (gitignored — they may contain residual brain content from your live personas). See `tests/evals/README.md` for the pass criteria and failure triage.

### 8. Update later

When gbrain ships a new agent-voice reference, refresh your local copy:

```bash
gbrain integrations install agent-voice --target <target-repo> --refresh
```

Refresh classifies each file (six states — identical / stale / locally-modified / host-deleted / source-deleted / new-in-manifest) and applies a deterministic decision per state: local edits are preserved by default; pass `--auto take-theirs` to take upstream everywhere, or `--dry-run` to preview. The full contract lives gbrain-side at `recipes/agent-voice/install/refresh-algorithm.md` (not copied to the host repo).
