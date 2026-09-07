/**
 * provider-keys-preload — strip ambient chat-provider API keys so the unit
 * lane is hermetic-keyless by definition (parity with keyless CI).
 *
 * Why: key-aware model routing (src/core/model-config.ts
 * PROVIDER_TIER_DEFAULTS / resolveTierDefault) resolves tier defaults from
 * whichever provider keys are present. That is the PRODUCT contract — an
 * OPENAI_API_KEY-only install routes chat/extraction to OpenAI — but it means
 * a dev shell exporting a chat key flips every default-model assertion and,
 * worse, turns previously-gated code paths into REAL network calls with the
 * shell's key (observed: 183 unit failures and 15-minute retry hangs on an
 * OPENAI_API_KEY-exporting shell, the TODOS "env-sensitive LLM-availability
 * tests" class at full scale). CI is keyless; local unit runs must match.
 *
 * Tests that WANT keys inject them explicitly (configureGateway({env}),
 * detectCapabilities({env}), withEnv, or process.env in serial files) — this
 * preload only removes ambient shell state, never test-set state (it runs
 * once, before any test file loads).
 *
 * Escape hatch: GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 preserves the ambient keys.
 * The e2e wrapper (scripts/run-e2e.sh) sets it at its own subprocess boundary
 * so keyed e2e runs (live embed parity tests skip-gated on real keys) keep
 * today's behavior — same pattern as GBRAIN_TEST_ALLOW_DATABASE_URL.
 */

import { PROVIDER_ENV_KEYS } from './provider-env.ts';

if (process.env.GBRAIN_TEST_KEEP_PROVIDER_KEYS !== '1') {
  for (const key of PROVIDER_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      delete process.env[key];
    }
  }
}

// Latest-model discovery (src/core/ai/openai-latest.ts) fetches the
// account's /v1/models at gateway connect. Tests configure fake keys and
// call reconfigureGatewayWithEngine constantly — without this switch every
// such test would attempt a real network call. Off in ALL test lanes
// (respecting an explicit operator override); unit tests for discovery
// inject fetchImpl + force instead.
if (process.env.GBRAIN_MODEL_DISCOVERY === undefined) {
  process.env.GBRAIN_MODEL_DISCOVERY = 'off';
}
