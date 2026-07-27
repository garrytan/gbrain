// v0.40.6.0 — best-effort.ts contract tests.
//
// Pins the empty-filter contract: pack-load failure returns null, NOT
// hardcoded defaults. Four call sites in Phase 8 (whoknows, find-experts,
// facts/eligibility, enrichment-service) depend on this contract.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadActivePackBestEffort } from '../src/core/schema-pack/best-effort.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let tmpDir: string;

beforeEach(() => {
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-best-effort-test-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

function fakeCtx(remote = false): OperationContext {
  return {
    engine: null as never,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false,
    remote,
    sourceId: undefined,
  } as unknown as OperationContext;
}

describe('loadActivePackBestEffort', () => {
  it('returns ResolvedPack when load succeeds (default bundled gbrain-base)', async () => {
    // No locator override → defaults to bundled gbrain-base resolution.
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await loadActivePackBestEffort(fakeCtx());
      expect(result).not.toBeNull();
      expect(result?.manifest.name).toBe('gbrain-base');
    });
  });

  it('returns null when the resolved pack is not on disk', async () => {
    __setPackLocatorForTests(() => null);
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'never-installed' }, async () => {
      const result = await loadActivePackBestEffort(fakeCtx());
      expect(result).toBeNull();
    });
  });

  it('returns null when the pack file is corrupt', async () => {
    const packDir = join(tmpDir, 'schema-packs', 'corrupt-pack');
    mkdirSync(packDir, { recursive: true });
    const packPath = join(packDir, 'pack.yaml');
    writeFileSync(packPath, 'this: is: not: valid: yaml: at all: \n}}{', 'utf-8');
    __setPackLocatorForTests((name) => (name === 'corrupt-pack' ? packPath : null));
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: 'corrupt-pack' }, async () => {
      const result = await loadActivePackBestEffort(fakeCtx());
      expect(result).toBeNull();
    });
  });

  it('NEVER throws on any failure path (the load-bearing best-effort contract)', async () => {
    // Force load to throw via a locator that returns garbage.
    __setPackLocatorForTests(() => { throw new Error('synthetic disk failure'); });
    await withEnv({ GBRAIN_HOME: tmpDir }, async () => {
      // resolves, doesn't throw.
      await expect(loadActivePackBestEffort(fakeCtx())).resolves.toBeNull();
    });
  });
});
