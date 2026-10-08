// v0.41.19.0 — T6 of ops-fix-wave.
//
// Pins the sync_consolidation doctor check (Issue 5 — surface the
// `gbrain sync --all --parallel` recommendation to operators with
// multi-source brains).
//
// Coverage:
//   - 0 sources → ok with "not applicable" message
//   - 1 source → ok with "not applicable" message
//   - 2+ active sources → ok with paste-ready cron command in message
//   - archived sources excluded from the count (codex edge case)
//   - all sources archived → counts as < 2 → "not applicable"
//   - SQL throws → status='warn' (own try/catch, not relying on outer doctor catch)
//   - managed brain (#6244) → the recipe managed sync accepts (--no-pull, no
//     --skip-failed, a deadline under the interval, sources refresh for pulls);
//     a schema without persistence_brain keeps the classic line

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncConsolidation } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function addSource(id: string, opts: { local_path?: string | null; archived?: boolean } = {}): Promise<void> {
  const local_path = opts.local_path === null ? null : (opts.local_path ?? `/tmp/${id}`);
  const archived = opts.archived ?? false;
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, archived)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, archived = EXCLUDED.archived`,
    [id, id, local_path, archived],
  );
}

describe('checkSyncConsolidation (Issue 5)', () => {
  test('0 sources (only default w/ NULL local_path) → ok with "not applicable"', async () => {
    // Default source exists from initSchema but has NULL local_path.
    // checkSyncConsolidation filters on local_path IS NOT NULL.
    const result = await checkSyncConsolidation(engine);
    expect(result.name).toBe('sync_consolidation');
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/not applicable/i);
  });

  test('1 active source → ok with "not applicable"', async () => {
    await addSource('default', { local_path: '/tmp/default-brain' });
    const result = await checkSyncConsolidation(engine);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/single-source/i);
    expect(result.message).toMatch(/not applicable/i);
  });

  test('3 active sources → ok with paste-ready `sync --all` command', async () => {
    await addSource('default', { local_path: '/tmp/default-brain' });
    await addSource('zion-brain');
    await addSource('media-brain');
    const result = await checkSyncConsolidation(engine);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/3 active sources/);
    // Paste-ready command embedded in message
    expect(result.message).toMatch(/gbrain sync --all --parallel 4 --workers 4 --skip-failed/);
  });

  test('2 sources both archived → "not applicable" (archived excluded)', async () => {
    await addSource('archived-a', { archived: true });
    await addSource('archived-b', { archived: true });
    const result = await checkSyncConsolidation(engine);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/not applicable/i);
  });

  test('mixed — 1 active + 1 archived → "not applicable" (only 1 counts)', async () => {
    await addSource('active', { local_path: '/tmp/active' });
    await addSource('archived', { archived: true });
    const result = await checkSyncConsolidation(engine);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/not applicable/i);
  });

  test('SQL failure → status=warn with diagnostic message (own try/catch)', async () => {
    // Construct a broken engine via duck-typing.
    const brokenEngine = {
      executeRaw: async () => { throw new Error('connection refused'); },
    } as unknown as PGLiteEngine;
    const result = await checkSyncConsolidation(brokenEngine);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/Could not check sync consolidation/);
    expect(result.message).toMatch(/connection refused/);
  });

  test('managed brain with 2 sources → the recipe managed sync accepts (#6244)', async () => {
    await addSource('default', { local_path: '/tmp/default-brain' });
    await addSource('notes');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const result = await checkSyncConsolidation(engine);
      expect(result.status).toBe('ok');
      expect(result.message).toContain('2 active sources on a managed brain');
      expect(result.message).toContain('every 15 minutes: `gbrain sync --all --no-pull --hard-deadline 13m`');
      expect(result.message).toContain('`gbrain sources refresh <id>;`');
      expect(result.message).not.toContain('--skip-failed');
      expect(result.message).not.toContain('--parallel');
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  });

  test('unmanaged brain keeps the classic message byte for byte', async () => {
    await addSource('default', { local_path: '/tmp/default-brain' });
    await addSource('notes');
    const result = await checkSyncConsolidation(engine);
    expect(result.message).toBe(
      '2 active sources detected. Recommended cron: `gbrain sync --all --parallel 4 --workers 4 --skip-failed`. ' +
      'If your crontab has separate per-source entries, replace them with one --all line — future sources auto-pick-up without a crontab edit.');
  });

  test('a schema without persistence_brain reads as unmanaged → classic line', async () => {
    const prePersistence = {
      executeRaw: async (sql: string) => {
        if (/persistence_brain/.test(sql)) throw new Error('relation "persistence_brain" does not exist');
        return [{ id: 'default' }, { id: 'notes' }];
      },
    } as unknown as PGLiteEngine;
    const result = await checkSyncConsolidation(prePersistence);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/gbrain sync --all --parallel 4 --workers 4 --skip-failed/);
  });
});
