import {
  configureGateway,
  getEmbeddingDimensions,
  __setGatewayResetBaselineForTests,
} from '../../src/core/ai/gateway.ts';
import { beforeEach } from 'bun:test';

// W0 fix-wave: shared with scripts/build-pglite-snapshot.ts so the snapshot
// fixture is baked under the exact shape this preload pins.
import { LEGACY_EMBEDDING_CONFIG as LEGACY_CONFIG } from './legacy-embedding-config.ts';

function legacyGatewayConfig() {
  return {
    embedding_model: LEGACY_CONFIG.embedding_model,
    embedding_dimensions: LEGACY_CONFIG.embedding_dimensions,
    env: { ...process.env },
  };
}

function applyLegacy() {
  configureGateway(legacyGatewayConfig());
}

if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
  console.error('[legacy-embedding-preload] applying OpenAI/1536');
}

// Initial application — covers tests that don't reset the gateway.
applyLegacy();

// #3554: make resetGateway() mean "back to this baseline" instead of
// "unconfigured". Without this, a file whose teardown calls resetGateway()
// leaves _config = null; the NEXT file's beforeAll engine-connect then
// reconfigures from the shipped default (voyage-4 @ 1024) BEFORE the
// beforeEach below can fire, and the 1024-sized schema rejects the file's
// 1536-d fixtures. Which file pairs collide depends on shard bin-packing,
// so adding any test file reshuffles the mines. A factory (not a frozen
// config) so each re-application captures fresh process.env.
__setGatewayResetBaselineForTests(legacyGatewayConfig);

// Per-test re-application — handles tests that call `resetGateway()`
// in their setup/teardown. Bun's preload allows registering global
// hooks; this fires before every test in every file in the shard.
//
// Tests that need a different gateway config (the new v0.37 tests,
// provider-shape tests) call `configureGateway()` in their own
// beforeAll AFTER this beforeEach runs. Order is:
//   1. legacy preload beforeEach → applyLegacy (1536)
//   2. file-local beforeAll → may overwrite to Voyage/1024
// Since beforeAll runs once per file BEFORE the first beforeEach,
// file-local beforeAll wins for that file's tests. ✓
beforeEach(() => {
  try {
    // Only re-apply if the gateway was reset (or never configured).
    // Tests that explicitly configured a different model in their
    // own beforeAll get to keep it — we only restore the legacy
    // default when the slot is empty.
    getEmbeddingDimensions();
  } catch {
    applyLegacy();
  }
});
