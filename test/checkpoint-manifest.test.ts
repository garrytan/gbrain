/**
 * Cathedral 5 (WI1) — session_context_state.checkpoint_manifest helpers.
 * Hermetic in-memory PGLite; drives the REAL getCheckpointManifest /
 * appendCheckpointManifest (newest-first, dedup-by-slug, cap, fail-open on
 * pre-v132 schema).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  getCheckpointManifest,
  appendCheckpointManifest,
  getSessionContextState,
  upsertSessionContextState,
  CHECKPOINT_MANIFEST_CAP,
} from '../src/core/context/session-state.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM session_context_state');
});

describe('checkpoint_manifest append/read', () => {
  test('append creates the row when absent and reads back newest-first', async () => {
    await appendCheckpointManifest(
      engine, 'default', null, 'sess-a',
      [{ slug: 'people/alice-example', title: 'Alice Example' }],
      { seg: 'abc123def456', n: 1 },
    );
    const links = (await getCheckpointManifest(engine, 'default', null, 'sess-a'))!;
    expect(links).toHaveLength(1);
    expect(links[0].slug).toBe('people/alice-example');
    expect(links[0].title).toBe('Alice Example');
    expect(links[0].seg).toBe('abc123def456');
    expect(links[0].n).toBe(1);
    expect(Date.parse(links[0].at)).toBeGreaterThan(0);
  });

  test('second append prepends (newest-first) and preserves older entries', async () => {
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'a', title: 'A' }], { seg: 's1', n: 1 });
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'b', title: 'B' }], { seg: 's2', n: 2 });
    const links = (await getCheckpointManifest(engine, 'default', null, 's'))!;
    expect(links.map((l) => l.slug)).toEqual(['b', 'a']);
    expect(links[0].seg).toBe('s2');
    expect(links[1].seg).toBe('s1');
  });

  test('dedup-by-slug: re-banked slug is refreshed and moved to the front', async () => {
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'a', title: 'A' }], { seg: 's1', n: 1 });
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'b', title: 'B' }], { seg: 's2', n: 2 });
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'a', title: 'A v2' }], { seg: 's3', n: 3 });
    const links = (await getCheckpointManifest(engine, 'default', null, 's'))!;
    expect(links.map((l) => l.slug)).toEqual(['a', 'b']);
    expect(links[0].title).toBe('A v2');
    expect(links[0].seg).toBe('s3');
    expect(links[0].n).toBe(3);
  });

  test(`cap at CHECKPOINT_MANIFEST_CAP=${CHECKPOINT_MANIFEST_CAP}: oldest entries fall off`, async () => {
    for (let i = 1; i <= CHECKPOINT_MANIFEST_CAP + 5; i++) {
      await appendCheckpointManifest(
        engine, 'default', null, 's',
        [{ slug: `page-${i}`, title: `P${i}` }],
        { seg: `seg-${i}`, n: i },
      );
    }
    const links = (await getCheckpointManifest(engine, 'default', null, 's'))!;
    expect(links).toHaveLength(CHECKPOINT_MANIFEST_CAP);
    expect(links[0].slug).toBe(`page-${CHECKPOINT_MANIFEST_CAP + 5}`);
    expect(links.at(-1)!.slug).toBe('page-6'); // 1..5 evicted
  });

  test('empty links array is a no-op (no row created)', async () => {
    await appendCheckpointManifest(engine, 'default', null, 's-empty', [], { seg: 'x', n: 1 });
    expect(await getSessionContextState(engine, 'default', null, 's-empty')).toBeNull();
    expect(await getCheckpointManifest(engine, 'default', null, 's-empty')).toEqual([]);
  });

  test('client lanes are isolated: local vs remote client id never cross-read', async () => {
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'local-page', title: 'L' }], { seg: 'l', n: 1 });
    await appendCheckpointManifest(engine, 'default', 'remote-client', 's', [{ slug: 'remote-page', title: 'R' }], { seg: 'r', n: 1 });
    expect((await getCheckpointManifest(engine, 'default', null, 's'))!.map((l) => l.slug)).toEqual(['local-page']);
    expect((await getCheckpointManifest(engine, 'default', 'remote-client', 's'))!.map((l) => l.slug)).toEqual(['remote-page']);
  });

  test('append does not clobber banked entities or the cursor (column independence)', async () => {
    await upsertSessionContextState(engine, 'default', null, 's', {
      standingEntities: ['acme-example'],
      cursorSlug: 'cursor-slug',
    });
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'a', title: 'A' }], { seg: 's1', n: 1 });
    const state = await getSessionContextState(engine, 'default', null, 's');
    expect(state?.standing_entities).toEqual(['acme-example']);
    expect(state?.surfaced_slugs).toEqual(['cursor-slug']);
  });

  test('pre-v132 schema (column missing): read reports null (error, not confirmed-empty), append returns false and never throws', async () => {
    await engine.executeRaw('ALTER TABLE session_context_state DROP COLUMN checkpoint_manifest');
    try {
      // null (failed read) — NOT [] — so the assemble poll keeps its retry
      // budget instead of settling on a transient error.
      expect(await getCheckpointManifest(engine, 'default', null, 's-old')).toBeNull();
      // Must not throw; reports the failed publish so the harvest keeps its
      // receipt instead of deleting the only durable copy of the links.
      const published = await appendCheckpointManifest(engine, 'default', null, 's-old', [{ slug: 'a', title: 'A' }], { seg: 'x', n: 1 });
      expect(published).toBe(false);
      expect(await getCheckpointManifest(engine, 'default', null, 's-old')).toBeNull();
    } finally {
      await engine.executeRaw(
        `ALTER TABLE session_context_state ADD COLUMN checkpoint_manifest JSONB NOT NULL DEFAULT '[]'::jsonb`,
      );
    }
  });

  test('malformed stored jsonb (wrong shape) filters to [] instead of throwing', async () => {
    await appendCheckpointManifest(engine, 'default', null, 's', [{ slug: 'a', title: 'A' }], { seg: 's1', n: 1 });
    await engine.executeRaw(
      `UPDATE session_context_state SET checkpoint_manifest = $1::text::jsonb WHERE session_id = 's'`,
      [JSON.stringify([{ nope: true }, 42, 'str'])],
    );
    expect(await getCheckpointManifest(engine, 'default', null, 's')).toEqual([]);
  });
});
