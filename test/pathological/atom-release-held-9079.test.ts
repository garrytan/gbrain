/**
 * #9079: a managed held-atom release must not reuse the ordinary drain's retained completion ID.
 * Real admission, activation, member publication and preview/apply; synthetic atom output, no provider.
 * Both a historical conflicted completion and a committed legacy completion remain immutable.
 * PGLite always; the E2E importer registers the same assertions on PostgreSQL.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { atomOwnerKey } from '../../src/core/generations/adapters/atoms.ts';
import { managedAtomSession, publishManagedAtoms, publishManagedAtomGeneration, readAtomOrigin } from '../../src/core/persistence/atom-maintenance.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer, waitForWrites } from '../../src/core/persistence/service.ts';
import { MaintenanceWriteWait } from '../../src/core/persistence/maintenance-wait.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const NOTE = 'notes/release-example';
const key = { kind: 'atom', sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: NOTE }) };
const truth = 'The team ships small changes, measures launches, reviews outcomes and writes decisions down. '.repeat(12);
const output = (name: string) => ({ slug: `atoms/2026-09-07/${name}`, content:
  `---\ntype: atom\ntitle: ${name}\nsource_slug: ${NOTE}\nmanaged_extraction: true\ndream_generated: true\n---\n\n${name}.\n`, links: [] });
const all = ['ship-small', 'measure-launches', 'review-outcomes', 'write-decisions'].map(output);
const selection = { kind: 'atom', mode: 'release-held' as const, held: true };
const quiet = { info() {}, warn() {}, error() {} };

async function repair(engine: Parameters<typeof resolveRepairScope>[0], hash?: string) {
  return (await repairRunner(engine, { apply: hash !== undefined, noEmbed: true, logger: quiet })).run('generations',
    await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', generations: selection, ...(hash ? { expect: hash } : {}) });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`managed atom held release (${backend})`, () => {
    test('an accepted but unpublished release reuses one deterministic batch on retry', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await operations.find(op => op.name === 'put_page')!.handler(ctx,
          { slug: NOTE, content: `---\ntype: note\ntitle: Release example\n---\n\n${truth}` });
        const session = (await managedAtomSession(engine, 'default'))!;
        const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
        const origin = await readAtomOrigin(engine, session, { kind: 'page', slug: NOTE, content: page.compiled_truth, contentHash: page.content_hash! });
        await publishManagedAtomGeneration(engine, session, origin, all, { key, content: page.compiled_truth });
        const held = await publishManagedAtomGeneration(engine, session, origin, all.slice(0, 1), { key, content: page.compiled_truth });
        if (held.state !== 'held') throw new Error('Expected a retained shrink');
        await disposePersistenceConsumer(engine);
        let unblock!: () => void;
        const blocked = new Promise<void>(resolve => { unblock = resolve; });
        installFaultHook(async point => { if (point === 'consumer:claiming') await blocked; });
        const release = { key, content: page.compiled_truth, runId: `release:${held.holdId}`,
          release: { holdId: held.holdId, reason: 'shrunk' as const } };
        const pendingSession = { ...session, wait: new MaintenanceWriteWait(0) };
        try {
          const first = await publishManagedAtomGeneration(engine, pendingSession, origin, all.slice(0, 1), release);
          expect(first.state).toBe('admitted');
          expect(first.receipts.every(row => row.state !== 'committed')).toBe(true);
          const before = await engine.executeRaw('SELECT request_id, digest FROM persistence_requests ORDER BY sequence');
          const replay = await publishManagedAtomGeneration(engine, pendingSession, origin, all.slice(0, 1), release);
          expect(replay.receipts.map(row => row.request_id)).toEqual(first.receipts.map(row => row.request_id));
          expect(await engine.executeRaw('SELECT request_id, digest FROM persistence_requests ORDER BY sequence')).toEqual(before);
        } finally { installFaultHook(undefined); unblock(); }
        const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE state IN ('queued','running','recovering') ORDER BY sequence");
        const done = await waitForWrites(engine, pending, { engine: engine.kind }, 60_000);
        expect(done.every(row => row.state === 'committed')).toBe(true);
        expect(await engine.executeRaw("SELECT 1 FROM derived_generation_items WHERE pending")).toEqual([]);
        expect(await engine.executeRaw("SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug"))
          .toEqual([{ slug: all[0]!.slug }]);
      }, { databaseUrl });
    }, 240_000);

    for (const priorState of ['conflict', 'committed'] as const) {
      test(`releases past a retained ${priorState} drain completion without changing its receipt`, async () => {
        await managedBrain(async ({ engine, ctx, root }) => {
          const put = operations.find(op => op.name === 'put_page')!;
          await put.handler(ctx, { slug: NOTE, content: `---\ntype: note\ntitle: Release example\n---\n\n${truth}` });
          const session = (await managedAtomSession(engine, 'default'))!;
          const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
          const origin = await readAtomOrigin(engine, session, { kind: 'page', slug: NOTE, content: page.compiled_truth, contentHash: page.content_hash! });
          const first = await publishManagedAtomGeneration(engine, session, origin, all, { key, content: page.compiled_truth });
          expect(first.state).toBe('admitted');
          expect(first.receipts.every(receipt => receipt.state === 'committed')).toBe(true);
          // A fresh proposal for the same input has a different activation but the same ordinary drain key.
          const held = await publishManagedAtomGeneration(engine, session, origin, all.slice(0, 1), { key, content: page.compiled_truth });
          expect(held).toMatchObject({ state: 'held', reason: 'shrunk' });
          await disposePersistenceConsumer(engine);
          const [old] = await engine.executeRaw<{ id: string; request_id: string }>(
            "SELECT id, request_id FROM persistence_requests WHERE intent->>'kind'='managed_atom_complete' ORDER BY sequence LIMIT 1");
          if (priorState === 'conflict') {
            // Build the historical failed completion through the writer, not by mutating a journal row.
            // A distinct origin content gets a fresh drain key while retaining the same generation floor.
            await put.handler(ctx, { slug: NOTE, content: `---\ntype: note\ntitle: Release example\n---\n\n${truth} Another decision.`,
              expected_revision: (await engine.readPageSnapshot(NOTE, { sourceId: 'default' }))!.revision });
            const changed = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
            const changedOrigin = await readAtomOrigin(engine, session, { kind: 'page', slug: NOTE, content: changed.compiled_truth, contentHash: changed.content_hash! });
            let failures = 0;
            installFaultHook(async (point, detail) => {
              if (point !== 'consumer:preparing' || !detail.writeId) return;
              const [row] = await engine.executeRaw<{ kind: string }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE id=$1", [detail.writeId]);
              if (row?.kind === 'managed_atom_complete') { failures++; throw new OperationError('revision_conflict', 'Synthetic historical completion conflict.'); }
            });
            try { await expect(publishManagedAtoms(engine, session, changedOrigin, [])).rejects.toMatchObject({ code: 'revision_conflict' }); }
            finally { installFaultHook(undefined); }
            expect(failures).toBeGreaterThan(0);
            expect(await publishManagedAtomGeneration(engine, session, changedOrigin, all.slice(0, 1), { key, content: changed.compiled_truth }))
              .toMatchObject({ state: 'held', reason: 'shrunk' });
          }
          const historical = await engine.executeRaw("SELECT id, request_id, state, digest, intent, outcome, error_code FROM persistence_requests WHERE intent->>'kind'='managed_atom_complete' ORDER BY sequence");
          expect(historical.at(-1)).toMatchObject({ state: priorState });
          const preview = await repair(engine);
          expect(preview.listing).toEqual([expect.objectContaining({ class: 'release-held' })]);
          const applied = await repair(engine, preview.preview_hash);
          expect(applied.outcomes).toEqual({ released: 1 });
          await disposePersistenceConsumer(engine);
          expect(await engine.executeRaw("SELECT id, request_id, state, digest, intent, outcome, error_code FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence",
            [historical.map(row => row.id)]))
            .toEqual(historical);
          const completions = await engine.executeRaw<{ request_id: string; state: string; run_key: string; activation: string }>(
            "SELECT request_id, state, intent->>'runKey' AS run_key, intent->>'activationId' AS activation FROM persistence_requests WHERE intent->>'kind'='managed_atom_complete' ORDER BY sequence");
          expect(completions).toHaveLength(historical.length + 1);
          expect(completions.at(-1)!.state).toBe('committed');
          expect(completions.at(-1)!.request_id).not.toBe(old!.request_id);
          expect(await engine.executeRaw("SELECT 1 FROM derived_generation_items WHERE pending")).toEqual([]);
          expect(await engine.executeRaw("SELECT 1 FROM derived_generations WHERE state='held'")).toEqual([]);
          const live = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug");
          expect(live.map(row => row.slug)).toEqual([all[0]!.slug]);
          await settleManagedGitEffects(engine);
          expect(readFileSync(join(root, all[0]!.slug + '.md'), 'utf8')).toContain('ship-small.');
          for (const atom of all.slice(1)) expect(existsSync(join(root, atom.slug + '.md'))).toBe(false);
          const replay = await repair(engine);
          expect(replay.listing).toEqual([]);
          expect(await engine.executeRaw("SELECT request_id FROM persistence_requests WHERE intent->>'kind'='managed_atom_complete'"))
            .toHaveLength(completions.length);
        }, { databaseUrl });
      }, 240_000);
    }
  });
}
