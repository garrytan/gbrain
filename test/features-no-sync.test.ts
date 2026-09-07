/**
 * #4767 — `gbrain features`' "Configure Sync" recommendation must key on the
 * sources table (modern sync anchors on `sources.local_path`), not only on the
 * legacy global `sync.repo_path` key, which non-default sources never set. A
 * multi-source brain with N healthy syncing sources was told it is "not
 * syncing from git" and pointed at `gbrain sync --repo <path>`.
 */
import { describe, expect, test } from 'bun:test';
import { scanFeatures } from '../src/commands/features.ts';
import type { BrainEngine, SourceRow } from '../src/core/engine.ts';

// A healthy, populated brain so the sync branch is the only variable.
function mk(legacyRepo: string | null, sources: SourceRow[], calls: string[] = []): BrainEngine {
  return {
    getStats: async () => ({ page_count: 100, link_count: 50, timeline_entry_count: 20 }),
    getHealth: async () => ({ missing_embeddings: 0, dead_links: 0, embed_coverage: 1, brain_score: 80 }),
    getConfig: async (key: string) => (key === 'sync.repo_path' ? legacyRepo : null),
    // Mirrors the real engines: `localPathOnly` drops rows whose local_path is NULL.
    listAllSources: async (opts?: { localPathOnly?: boolean }) => {
      calls.push('listAllSources');
      return opts?.localPathOnly === true ? sources.filter((s) => s.local_path !== null) : sources;
    },
  } as unknown as BrainEngine;
}

const noSync = async (engine: BrainEngine) =>
  (await scanFeatures(engine)).recommendations.find((r) => r.id === 'no-sync');

describe('#4767: Configure Sync keys on sources.local_path, not only the legacy key', () => {
  test('a brain whose synced sources are non-default rows is NOT told it is not syncing', async () => {
    const wiki: SourceRow = { id: 'wiki', name: 'wiki', local_path: '/tmp/wiki', last_sync_at: null, config: {} };
    expect(await noSync(mk(null, [wiki]))).toBeUndefined();
  });

  test('no legacy key and no source with a local_path still recommends Configure Sync', async () => {
    const rec = await noSync(mk(null, []));
    expect(rec).toBeDefined();
    expect(rec!.title).toBe('Configure Sync');
  });

  test('a lone source with NULL local_path (pure-DB, never synced) still recommends Configure Sync', async () => {
    const dbOnly: SourceRow = { id: 'notes', name: 'notes', local_path: null, last_sync_at: null, config: {} };
    const rec = await noSync(mk(null, [dbOnly]));
    expect(rec).toBeDefined();
    expect(rec!.title).toBe('Configure Sync');
  });

  test('the legacy sync.repo_path short-circuits without consulting the sources table', async () => {
    const calls: string[] = [];
    expect(await noSync(mk('/some/repo', [], calls))).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
