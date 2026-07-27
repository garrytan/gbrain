# Claw-test brief — voice-agent-install

You are installing the `agent-voice` reference (Mars + Venus voice personas, WebRTC-first browser client) into a freshly-prepared scratch host repo. This is a **friction-discovery** test, not a production install — find anything confusing and log it.

The scratch repo at `$OPENCLAW_WORKSPACE` is pre-seeded as a minimal git repo with an `AGENTS.md` stub. Everything else needs to come from `gbrain integrations install agent-voice`.

## Steps

1. **Confirm gbrain is reachable:**
   ```bash
   gbrain --version && gbrain integrations show agent-voice
   ```
   If `gbrain` is not on PATH, look for it at `$GBRAIN_BIN` or the local source-tree CLI (`bun run /path/to/gbrain/src/cli.ts`).

2. **Install agent-voice into the scratch repo:**
   ```bash
   gbrain integrations install agent-voice --target $OPENCLAW_WORKSPACE
   ```

3. **Verify the install:**
   ```bash
   ls $OPENCLAW_WORKSPACE/services/voice-agent/
   cat $OPENCLAW_WORKSPACE/services/voice-agent/.gbrain-source.json | head -10
   grep -c "voice-persona" $OPENCLAW_WORKSPACE/AGENTS.md
   ```

4. **Run host-side tests:**
   ```bash
   cd $OPENCLAW_WORKSPACE/services/voice-agent && bun install && bun run test
   ```

5. **Start the voice server (in background) on the port from $AGENT_VOICE_TEST_PORT, default 8766:**
   ```bash
   cd $OPENCLAW_WORKSPACE/services/voice-agent
   PORT=${AGENT_VOICE_TEST_PORT:-8766} bun run start &
   ```

6. **Wait for /health to return 200, then exit successfully:**
   ```bash
   for i in {1..60}; do
     curl -sf http://localhost:${AGENT_VOICE_TEST_PORT:-8766}/health >/dev/null && echo READY && exit 0
     sleep 1
   done
   echo FAILED
   exit 1
   ```

## Friction protocol

If anything is confusing, missing, surprising, or wrong, run:

```
gbrain friction log --severity {confused|error|blocker|nit} --phase <which-step> --message "<what-happened>" [--hint "<what-could-be-better>"]
```

Severity guide:
- `blocker` — couldn't proceed at all
- `error` — command failed unexpectedly
- `confused` — docs said one thing, the tool did another, or a step felt unclear
- `nit` — minor polish opportunity

Common friction points to watch for:
- `gbrain integrations install` not in scope or unknown subcommand → likely a stale gbrain binary
- Missing `OPENAI_API_KEY` env var when starting the server → expected, log a `nit`
- Host repo uses npm instead of bun → the recipe should detect and pick the right command
- `AGENTS.md` already has resolver rows → install should append, not overwrite (verify)
- `.git` missing from target → install should refuse with a clear error
