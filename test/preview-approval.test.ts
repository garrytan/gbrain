/**
 * Preview-approval helper contract (fix wave 5, ENG-O1 / ENG-O14), on PGLite
 * and, with a safe DATABASE_URL, Postgres (test/e2e/preview-approval-postgres.test.ts).
 *
 * One contract across the four preview-bound commands: the saved set round-
 * trips whole under its hash, sets of different commands never satisfy each
 * other, a missing, foreign or expired set refuses with `preview_changed`
 * (never a partial set), a purge-eligible set is never trusted, and
 * `previewHash` is byte-identical to the `authorizeLegacyJobs --ids` digest.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { authorityDigest } from '../src/core/minions/submission-authority.ts';
import { APPROVAL_MAX_AGE_DAYS, PREVIEW_APPROVAL_OP, clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet,
  type PreviewApprovalCommand } from '../src/core/persistence/preview-approval.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const COMMANDS: Array<{ command: PreviewApprovalCommand; preview: string }> = [
  { command: 'authorize-legacy', preview: 'gbrain jobs authorize-legacy --select "status=waiting"' },
  { command: 'jobs-cancel', preview: 'gbrain jobs cancel --select "status=waiting|delayed"' },
  { command: 'stale-atoms', preview: 'gbrain repair stale-atoms --source default' },
  { command: 'extractor-facts', preview: 'gbrain repair extractor-facts --include-ambiguous' },
];

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a preview_changed refusal');
}

describe('previewHash', () => {
  // The shape authorizeLegacyJobs --ids hashes: raw rows with Dates, bigints, JSONB, nulls and unsorted keys.
  const legacySnapshot = {
    preview_version: 1, authority_version: 1, version: '0.60.26.0',
    jobs: [{ id: 7, name: 'sync', status: 'waiting', data: { sourceId: 'default', z: [1, null, { b: 2, a: 1 }] }, submission_authority: null,
      created_at: new Date('2026-09-01T00:00:00.000Z'), claim_generation: 3n, legacy_authority_is_null: true, absent: undefined }],
    dependencies: [], sources: [{ id: 'default', local_path: null, config: {}, archived: false, created_at: new Date('2026-01-01T00:00:00.000Z') }],
  };

  test('is byte-identical to the authorize-legacy --ids digest (authorityDigest) and pinned', () => {
    expect(previewHash(legacySnapshot)).toBe(authorityDigest(legacySnapshot));
    expect(previewHash(legacySnapshot)).toBe('8a78b9ac1ca4ea11a4a0dadeab4e2733f318d8c0730766f8f62e88ff47c74351');
    expect(previewHash(['stale-atoms', { b: 1, a: 2 }])).toBe(authorityDigest(['stale-atoms', { a: 2, b: 1 }]));
  });

  test('changes when any listed item or option changes', () => {
    const base = previewHash({ command: 'stale-atoms', items: [{ id: 1, revision: 'r1' }], options: { limit: 10 } });
    expect(previewHash({ command: 'stale-atoms', items: [{ id: 1, revision: 'r2' }], options: { limit: 10 } })).not.toBe(base);
    expect(previewHash({ command: 'stale-atoms', items: [{ id: 1, revision: 'r1' }], options: { limit: 11 } })).not.toBe(base);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
  });

  test('preview_changed carries the DX-O2 message, the filled preview command and the anchor', () => {
    const error = previewChangedError('abc123', 'gbrain repair stale-atoms');
    expect(error.toJSON()).toMatchObject({ error: 'preview_changed',
      message: 'The preview changed since abc123; re-run gbrain repair stale-atoms and use the new hash.',
      suggestion: 'Re-run the preview: gbrain repair stale-atoms', docs: 'docs/guides/repair.md#preview-changed' });
  });
});

for (const kind of testBackends()) {
  describe(`approved sets in op_checkpoints (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [PREVIEW_APPROVAL_OP]); });

    const age = (command: PreviewApprovalCommand, hash: string, days: number) => engine.executeRaw(
      `UPDATE op_checkpoints SET updated_at=now()-($3 || ' days')::interval WHERE op=$1 AND fingerprint=$2`, [PREVIEW_APPROVAL_OP, `${command}:${hash}`, String(days)]);

    test('every command round-trips its whole set under its hash, and never satisfies another command', async () => {
      for (const { command, preview } of COMMANDS) {
        const items = Array.from({ length: 500 }, (_, i) => ({ id: i, request_id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`, note: `it's "${command}"` }));
        const hash = previewHash({ command, items });
        await saveApprovedSet(engine, { command, hash }, items);
        const loaded = await loadApprovedSet<typeof items[number]>(engine, { command, hash, previewCommand: preview });
        expect(loaded).toMatchObject({ command, hash });
        expect(loaded.items).toEqual(items);
        expect(Number.isNaN(Date.parse(loaded.approved_at))).toBe(false);
        for (const other of COMMANDS.filter(c => c.command !== command)) {
          const error = await refusal(() => loadApprovedSet(engine, { command: other.command, hash, previewCommand: other.preview }));
          expect(error.code).toBe('preview_changed');
          expect(error.message).toContain(other.preview);
        }
      }
    });

    test('an unknown hash refuses with preview_changed naming the hash and the filled preview command', async () => {
      const error = await refusal(() => loadApprovedSet(engine, { command: 'extractor-facts', hash: 'f'.repeat(64), previewCommand: COMMANDS[3]!.preview }));
      expect(error.toJSON()).toMatchObject({ error: 'preview_changed', docs: 'docs/guides/repair.md#preview-changed',
        message: `The preview changed since ${'f'.repeat(64)}; re-run ${COMMANDS[3]!.preview} and use the new hash.` });
    });

    test('a set older than the purge window refuses whole; a younger one loads; a re-preview restarts its age', async () => {
      const items = [{ id: 1 }, { id: 2 }];
      const hash = previewHash(['stale-atoms', items]);
      const key = { command: 'stale-atoms' as const, hash, previewCommand: COMMANDS[2]!.preview };
      await saveApprovedSet(engine, key, items);
      await age('stale-atoms', hash, APPROVAL_MAX_AGE_DAYS - 1);
      expect((await loadApprovedSet(engine, key)).items).toEqual(items);
      await age('stale-atoms', hash, APPROVAL_MAX_AGE_DAYS + 1);
      expect((await refusal(() => loadApprovedSet(engine, key))).code).toBe('preview_changed');
      await saveApprovedSet(engine, key, items);
      expect((await loadApprovedSet(engine, key)).items).toEqual(items);
    });

    test('the purge window matches purgeStaleCheckpoints: an expired set is purged, a fresh one survives', async () => {
      const fresh = previewHash(['jobs-cancel', 'fresh']);
      const stale = previewHash(['jobs-cancel', 'stale']);
      await saveApprovedSet(engine, { command: 'jobs-cancel', hash: fresh }, [{ id: 1 }]);
      await saveApprovedSet(engine, { command: 'jobs-cancel', hash: stale }, [{ id: 2 }]);
      await age('jobs-cancel', stale, APPROVAL_MAX_AGE_DAYS + 1);
      await purgeStaleCheckpoints(engine);
      const rows = await engine.executeRaw<{ fingerprint: string }>('SELECT fingerprint FROM op_checkpoints WHERE op=$1', [PREVIEW_APPROVAL_OP]);
      expect(rows.map(row => row.fingerprint)).toEqual([`jobs-cancel:${fresh}`]);
      expect((await loadApprovedSet(engine, { command: 'jobs-cancel', hash: fresh, previewCommand: COMMANDS[1]!.preview })).items).toEqual([{ id: 1 }]);
    });

    test('a malformed saved row refuses instead of returning a partial set', async () => {
      const hash = previewHash(['authorize-legacy', 'malformed']);
      await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)`,
        [PREVIEW_APPROVAL_OP, `authorize-legacy:${hash}`, JSON.stringify([{ command: 'authorize-legacy', hash }])]);
      expect((await refusal(() => loadApprovedSet(engine, { command: 'authorize-legacy', hash, previewCommand: COMMANDS[0]!.preview }))).code).toBe('preview_changed');
    });

    test('clearApprovedSet removes only that set', async () => {
      const a = previewHash(['extractor-facts', 'a']);
      const b = previewHash(['extractor-facts', 'b']);
      await saveApprovedSet(engine, { command: 'extractor-facts', hash: a }, [1]);
      await saveApprovedSet(engine, { command: 'extractor-facts', hash: b }, [2]);
      await clearApprovedSet(engine, { command: 'extractor-facts', hash: a });
      expect((await refusal(() => loadApprovedSet(engine, { command: 'extractor-facts', hash: a, previewCommand: 'p' }))).code).toBe('preview_changed');
      expect((await loadApprovedSet(engine, { command: 'extractor-facts', hash: b, previewCommand: 'p' })).items).toEqual([2]);
    });
  });
}
