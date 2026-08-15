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
});
