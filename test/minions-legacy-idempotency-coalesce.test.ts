/**
 * Upgrade regression: jobs submitted before the submission_authority column
 * existed (v0.50 migration 149) carry NULL authority. A post-upgrade submit
 * that reuses one of their idempotency keys (dream:synth-v2:* is the common
 * case) must not die on "coalescing across submission authorities is
 * forbidden" when the legacy row is terminal:
 *   - completed legacy row → coalesce onto it (pre-0.50 semantics)
 *   - dead/cancelled legacy row → free the key and insert fresh (existing rule)
 *   - NON-terminal legacy row → still denied (unresolved legacy work is the
 *     `jobs authorize-legacy` lane, never a silent coalesce)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

async function insertLegacy(status: string, key: string): Promise<number> {
  // The protocol trigger refuses NULL-authority INSERTs (old producers must
  // not enqueue), so build the legacy shape the way the upgrade left it:
  // insert a protocol-1 row, then strip the authority in place.
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, data, status, idempotency_key, submission_authority)
     VALUES ('subagent', 'default', '{}'::jsonb, $1, $2, '{"kind":"application","version":1}'::jsonb) RETURNING id`,
    [status, key],
  );
  await engine.executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [rows[0].id]);
  return rows[0].id;
}

describe('legacy (NULL-authority) idempotency rows after the v0.50 upgrade', () => {
  test('completed legacy row coalesces instead of throwing', async () => {
    const legacyId = await insertLegacy('completed', 'dream:synth-v2:legacy-1');
    const job = await queue.add('subagent', { prompt: 'x' }, { idempotency_key: 'dream:synth-v2:legacy-1' }, { allowProtectedSubmit: true });
    expect(job.id).toBe(legacyId);
    expect(job.coalesced).toBe(true);
  });

  test('dead legacy row frees its key and a fresh job is inserted', async () => {
    const legacyId = await insertLegacy('dead', 'dream:synth-v2:legacy-2');
    const job = await queue.add('subagent', { prompt: 'x' }, { idempotency_key: 'dream:synth-v2:legacy-2' }, { allowProtectedSubmit: true });
    expect(job.id).not.toBe(legacyId);
    expect(job.status).toBe('waiting');
    expect(job.submission_authority).not.toBeNull();
  });

  test('non-terminal legacy row is still denied', async () => {
    await insertLegacy('waiting', 'dream:synth-v2:legacy-3');
    await expect(queue.add('subagent', { prompt: 'x' }, { idempotency_key: 'dream:synth-v2:legacy-3' }, { allowProtectedSubmit: true }))
      .rejects.toThrow(/coalescing across submission authorities/);
  });
});
