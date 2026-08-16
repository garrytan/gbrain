/**
 * v0.45.7 — gcSessionContextState per-(source, client) LRU cap, driven through
 * the REAL function via the injectable `maxRowsPerClient` param (previously
 * only pinned by an inline-SQL mirror in ambient-recall.test.ts). Hermetic
 * in-memory PGLite.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  getSessionContextState,
  upsertSessionContextState,
  gcSessionContextState,
  MAX_ROWS_PER_CLIENT,
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

/** Pin updated_at to a deterministic recent offset (inside the 7-day age
 * window, so the cap arm — not the age arm — decides survival). */
async function ageRow(sessionId: string, minutesAgo: number): Promise<void> {
  await engine.executeRaw(
    `UPDATE session_context_state SET updated_at = now() - ($1 || ' minutes')::interval WHERE session_id = $2`,
    [String(minutesAgo), sessionId],
  );
}

describe('gcSessionContextState — per-(source, client) LRU cap', () => {
  test('default cap stays MAX_ROWS_PER_CLIENT=1000 (exported for callers/tests)', () => {
    expect(MAX_ROWS_PER_CLIENT).toBe(1000);
  });

  test('cap=2 keeps the 2 NEWEST rows of the capped lane; other lanes untouched', async () => {
    // 4 sessions in ONE (source, client) lane, deterministically ordered.
    for (const [s, min] of [['c1', 4], ['c2', 3], ['c3', 2], ['c4', 1]] as const) {
      await upsertSessionContextState(engine, 'default', 'capclient', s, { cursorSlug: s });
      await ageRow(s, min);
    }
    // Same source, DIFFERENT client — its lane is partitioned separately.
    await upsertSessionContextState(engine, 'default', 'other-client', 'oc1', { cursorSlug: 'oc1' });
    // Same client id, DIFFERENT source — also a separate lane.
    await upsertSessionContextState(engine, 'other-source', 'capclient', 'os1', { cursorSlug: 'os1' });

    await gcSessionContextState(engine, 7, 2);

    // Oldest two evicted, newest two kept.
    expect(await getSessionContextState(engine, 'default', 'capclient', 'c1')).toBeNull();
    expect(await getSessionContextState(engine, 'default', 'capclient', 'c2')).toBeNull();
    expect(await getSessionContextState(engine, 'default', 'capclient', 'c3')).not.toBeNull();
    expect(await getSessionContextState(engine, 'default', 'capclient', 'c4')).not.toBeNull();
    // Single-row lanes are under the cap — untouched.
    expect(await getSessionContextState(engine, 'default', 'other-client', 'oc1')).not.toBeNull();
    expect(await getSessionContextState(engine, 'other-source', 'capclient', 'os1')).not.toBeNull();
  });

  test('lane exactly AT the cap is untouched (rn > cap, not >=)', async () => {
    for (const [s, min] of [['a1', 2], ['a2', 1]] as const) {
      await upsertSessionContextState(engine, 'default', 'atcap', s, { cursorSlug: s });
      await ageRow(s, min);
    }
    await gcSessionContextState(engine, 7, 2);
    expect(await getSessionContextState(engine, 'default', 'atcap', 'a1')).not.toBeNull();
    expect(await getSessionContextState(engine, 'default', 'atcap', 'a2')).not.toBeNull();
  });

  test('age-based GC still works alongside the injectable cap', async () => {
    await upsertSessionContextState(engine, 'default', 'ageclient', 'old', { cursorSlug: 'x' });
    await upsertSessionContextState(engine, 'default', 'ageclient', 'fresh', { cursorSlug: 'y' });
    await engine.executeRaw(
      `UPDATE session_context_state SET updated_at = now() - interval '30 days' WHERE session_id = 'old'`,
    );
    await gcSessionContextState(engine, 7, 2);
    expect(await getSessionContextState(engine, 'default', 'ageclient', 'old')).toBeNull(); // aged out
    expect(await getSessionContextState(engine, 'default', 'ageclient', 'fresh')).not.toBeNull();
  });
});
