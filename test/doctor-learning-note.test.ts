/**
 * Nightly learning PR 4: doctor learning_note reports the newest learning_derive run (items by kind) and the kept and
 * undone share of shown change items over 30 days; an empty ledger is ok and says so.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { learningNoteEntry } from '../src/commands/doctor/checks/learning-note.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const run = async () => (await learningNoteEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0]!;
const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_B = '00000000-0000-4000-8000-00000000000b';
let target = 0;
async function item(runId: string, kind: string, state: string, opts: { shown?: boolean; age?: string } = {}) {
  const table = kind === 'promise_found' ? 'open_loops' : kind === 'page_filled' ? 'page_versions' : 'facts';
  await engine.executeRaw(
    `INSERT INTO learning_items (run_id, source_id, created_at, kind, target_table, target_id, state, shown_at)
     VALUES ($1::uuid, 'default', now() - $2::interval, $3, $4, $5, $6, CASE WHEN $7 THEN now() ELSE NULL END)`,
    [runId, opts.age ?? '0 seconds', kind, table, ++target, state, !!opts.shown]);
}

describe('doctor learning_note', () => {
  test('an empty ledger is ok and says nothing was recorded', async () => {
    const c = await run();
    expect(c.status).toBe('ok');
    expect(c.message).toContain('has not recorded anything');
  });

  test('reports the newest run by kind and the kept and undone share of shown change items over 30 days', async () => {
    await item(RUN_A, 'fact_added', 'kept', { shown: true, age: '2 days' });
    await item(RUN_A, 'fact_added', 'undone', { shown: true, age: '2 days' });
    await item(RUN_A, 'fact_added', 'pending', { shown: true, age: '2 days' });
    await item(RUN_A, 'fact_added', 'kept', { shown: true, age: '40 days' });
    await item(RUN_B, 'fact_added', 'pending');
    await item(RUN_B, 'promise_found', 'kept');
    await item(RUN_B, 'conflict_found', 'pending');
    const c = await run();
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ last_run_id: RUN_B, last_run_items: 3, by_kind: { conflict_found: 1, fact_added: 1, promise_found: 1 }, shown: 4, kept: 2, undone: 1 });
    expect(c.message).toContain('recorded 3 items (conflict_found 1, fact_added 1, promise_found 1)');
    expect(c.message).toContain('4 change items shown, 2 kept (50%), 1 undone (25%)');
  });
});
