/**
 * #2289 — `gbrain <op> --source __all__` must span all sources, not silently
 * fall back to 'default'.
 *
 * Pre-fix: makeContext passed '__all__' to resolveSourceId, whose
 * SOURCE_ID_RE rejects underscores; the swallowing catch then defaulted
 * sourceId to 'default', silently scoping an "all sources" query to one
 * source. Same catch also swallowed genuinely-bad explicit --source values.
 */

import { describe, test, expect } from 'bun:test';
import { makeContext } from '../src/cli.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Fresh-brain stub: sources table empty, no config. The non-explicit chain
// terminates at tier 6 ('default').
const stubEngine = {
  async executeRaw() {
    return [];
  },
  async getConfig() {
    return null;
  },
} as unknown as BrainEngine;

describe('makeContext --source handling (#2289)', () => {
  test("--source __all__ maps to op-level source_id='__all__', not a silent 'default'", async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const params: Record<string, unknown> = { source: '__all__' };
      const ctx = await makeContext(stubEngine, params);
      // The sentinel is handed to resolveRequestedScope via params.source_id;
      // local callers (remote:false) span the whole brain there.
      expect(params.source_id).toBe('__all__');
      expect(ctx.remote).toBe(false);
      // ctx.sourceId falls through the normal non-explicit chain.
      expect(ctx.sourceId).toBe('default');
    });
  });

  test('--source __all__ does not clobber an explicit source_id param', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const params: Record<string, unknown> = { source: '__all__', source_id: 'wiki' };
      await makeContext(stubEngine, params);
      expect(params.source_id).toBe('wiki');
    });
  });

  test('invalid explicit --source errors loudly instead of defaulting', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await expect(makeContext(stubEngine, { source: 'Not_A_Source' })).rejects.toThrow(
        /Invalid --source/,
      );
    });
  });

  test('explicit --source naming an unregistered source errors loudly', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await expect(makeContext(stubEngine, { source: 'nope' })).rejects.toThrow(/not found/);
    });
  });

  test("op-owned `source` param (e.g. put_raw_data's data source) is NOT the brain-source selector", async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const op = { params: { source: { type: 'string' } } } as never;
      // 'crustdata' is a data-source tag, not a registered brain source —
      // must neither throw nor be fed into resolveSourceId.
      const params: Record<string, unknown> = { source: 'crustdata' };
      const ctx = await makeContext(stubEngine, params, op);
      expect(ctx.sourceId).toBe('default');
      expect(params.source).toBe('crustdata');
      expect(params.source_id).toBeUndefined();
    });
  });

  test('no --source: resolution failure still falls back silently (fresh pre-init brain)', async () => {
    const throwingEngine = {
      async executeRaw() {
        throw new Error('relation "sources" does not exist');
      },
      async getConfig() {
        throw new Error('no config yet');
      },
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const ctx = await makeContext(throwingEngine, {});
      expect(ctx.sourceId).toBe('default');
    });
  });
});
