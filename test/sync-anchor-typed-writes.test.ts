/**
 * The sync anchor (sources.last_commit, last_sync_at, newest_content_at, local_path) is written through typed engine
 * members, not caller raw SQL. A Rust brain refuses caller raw SQL, so an anchor written through executeRaw never
 * advances there and every later sync diffs from the old commit. This test runs writeSyncAnchor against an engine whose
 * executeRaw rejects the anchor statements, and checks that the anchor still advances.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { writeSyncAnchor } from '../src/core/sync-anchor.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'anchor-typed-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

/** The engine as a Rust brain sees the anchor: executeRaw refuses the statements writeSyncAnchor used to run. */
function strict(real: BrainEngine): BrainEngine {
  const moved = (sql: string) => /UPDATE sources SET (last_commit|local_path)\b/.test(sql);
  return new Proxy(real, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[]) =>
      moved(sql) ? Promise.reject(new Error('caller raw SQL in the sync anchor')) : target.executeRaw(sql, params);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

describe('writeSyncAnchor', () => {
  test('advances the commit anchor and repoints the local path through typed engine members', async () => {
    await engine.insertSource({ id: 'wiki', name: 'wiki', local_path: dir, config: {} });
    const brain = strict(engine);
    await writeSyncAnchor(brain, 'wiki', 'last_commit', 'c1', Date.UTC(2026, 0, 2, 3, 4, 5), dir);
    const stamped = await engine.getSource('wiki');
    await writeSyncAnchor(brain, 'wiki', 'last_commit', 'c2', undefined, dir);
    const kept = await engine.getSource('wiki');
    await writeSyncAnchor(brain, 'wiki', 'repo_path', dir);
    const records = await engine.listSourceRecords();
    const wiki = records.find(r => r.id === 'wiki')!;
    expect({
      first: stamped?.last_commit ?? null,
      second: kept?.last_commit ?? null,
      synced: kept?.last_sync_at != null,
      newest: wiki.newest_content_at == null ? null : new Date(wiki.newest_content_at).toISOString(),
      path: wiki.local_path,
    }).toEqual({ first: 'c1', second: 'c2', synced: true, newest: '2026-01-02T03:04:05.000Z', path: dir });
  });
});
