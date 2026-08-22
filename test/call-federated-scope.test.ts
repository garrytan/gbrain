/**
 * #3874 — `gbrain call` must compute the SAME federated read scope as the
 * direct CLI path. Pre-fix, call.ts resolved via bare resolveSourceId and
 * never computed localFederatedSourceIds, so an unqualified
 * `gbrain call resolve_slugs ...` on a federated multi-source brain silently
 * saw only the scalar source while `gbrain query` spanned the federated set.
 */
import { describe, test, expect } from 'bun:test';
import { runCall } from '../src/commands/call.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

type SourceRow = { id: string; local_path: string | null; archived: boolean; config: Record<string, unknown> };

const SOURCES: SourceRow[] = [
  { id: 'default', local_path: null, archived: false, config: {} },
  { id: 'vault', local_path: '/nonexistent/vault-3874', archived: false, config: {} },
  { id: 'wiki', local_path: '/nonexistent/wiki-3874', archived: false, config: { federated: true } },
];

function makeEngine(capture: { resolveSlugsOpts: unknown[] }): BrainEngine {
  return {
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('WHERE id = $1 AND archived = false')) {
        return SOURCES.filter((s) => s.id === params?.[0] && !s.archived).map((s) => ({ id: s.id }));
      }
      // localFederatedSourceIds: SELECT id, config, archived FROM sources ...
      if (sql.includes('SELECT id, config, archived FROM sources')) {
        return SOURCES.filter((s) => !s.archived).map((s) => ({
          id: s.id, config: s.config, archived: s.archived,
        }));
      }
      // Tier-4 registered query (old or #3880 shape) — paths never match cwd.
      if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) {
        return SOURCES.filter((s) => s.local_path !== null).map((s) => ({
          id: s.id, local_path: s.local_path, archived: s.archived,
        }));
      }
      if (sql.includes('FROM pages')) return [];
      return [];
    },
    getConfig: async (key: string) => (key === 'sources.default' ? 'vault' : null),
    resolveSlugs: async (_partial: string, opts?: unknown) => {
      capture.resolveSlugsOpts.push(opts);
      return [];
    },
  } as unknown as BrainEngine;
}

describe('#3874 gbrain call federated scope parity', () => {
  test('ambient-tier resolution widens unqualified reads across federated sources', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const capture = { resolveSlugsOpts: [] as unknown[] };
      const engine = makeEngine(capture);
      const outs: string[] = [];
      await runCall(engine, ['resolve_slugs', JSON.stringify({ partial: 'foo' })], async (s) => {
        outs.push(s);
      });
      expect(capture.resolveSlugsOpts.length).toBe(1);
      const opts = capture.resolveSlugsOpts[0] as { sourceId?: string; sourceIds?: string[] };
      // Pre-fix: { sourceId: 'vault' } (scalar). Post-fix: the federated set.
      expect(opts.sourceIds).toEqual(['vault', 'wiki']);
    });
  });

  test('explicit --source keeps the scalar scope (no widening)', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const capture = { resolveSlugsOpts: [] as unknown[] };
      const engine = makeEngine(capture);
      await runCall(
        engine,
        ['--source', 'vault', 'resolve_slugs', JSON.stringify({ partial: 'foo' })],
        async () => {},
      );
      expect(capture.resolveSlugsOpts.length).toBe(1);
      const opts = capture.resolveSlugsOpts[0] as { sourceId?: string; sourceIds?: string[] };
      expect(opts.sourceIds).toBeUndefined();
      expect(opts.sourceId).toBe('vault');
    });
  });
});
