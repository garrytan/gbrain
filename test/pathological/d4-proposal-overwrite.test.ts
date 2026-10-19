/**
 * D-4 (GBRA-131, #6982): proposal accept/undo refuses one divergent page instead of overwriting either copy.
 * Protects: database/file-newer and concurrent edits preserve exact bodies, facts and proposal status;
 * agreeing copies still accept and undo. Existing proposal coverage changes fence rows, not independent prose.
 * Fails when: unmanaged proposal planning prefers file bytes and mirrors them over a different database body.
 * Seams: engine transaction proxy injects an edit after the planning snapshot; no production-only seam.
 * Post-publication rollback: a real transaction throws after the callback published the file, with or without
 * a subsequent editor save. An editor's later bytes must survive while database/proposal/version changes roll back.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { insertProposal } from '../../src/core/ai/decide/proposals-store.ts';
import { applyProposalAction } from '../../src/core/facts/proposal-supersede.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { pathologicalArms } from './harness.ts';
import { EDIT, SLUG, editWhenPrepared, withFactsBrain, type FactsBrain } from './facts-overwrite-fixture.ts';

function failAfterPublication(b: FactsBrain, beforeFile: string, failure: Error, after: () => void): BrainEngine {
  let fired = false;
  return new Proxy(b.engine, { get(target, prop) {
    if (prop === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>, opts?: Parameters<BrainEngine['transaction']>[1]) =>
      target.transaction(async tx => {
        const result = await run(tx);
        if (!fired && b.bytes() !== beforeFile) { fired = true; after(); throw failure; }
        return result;
      }, opts);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const { backend, databaseUrl } of pathologicalArms()) describe(`D-4 proposal mirrors (${backend})`, () => {
  for (const action of ['accept', 'undo'] as const) for (const mode of ['database', 'file', 'late-database', 'late-file', 'agree'] as const) test(`${action}: ${mode}`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      const old = (await b.append()).ids[0]!;
      const fresh = (await b.append(b.engine, 'Alice Example leads design')).ids[0]!;
      const id = (await insertProposal(b.engine, { source_id: 'default', sweep_id: 'synthetic-sweep', pair_index: 0,
        old_fact_id: old, new_fact_id: fresh, direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8,
        proposal_floor: 0.5, model_resolved: 'synthetic-model' }))!;
      if (action === 'undo') expect((await applyProposalAction(b.engine, id, 'accept')).status).toBe('accepted');
      if (mode === 'database') await b.dbEdit();
      if (mode === 'file') b.fileEdit();
      const before = { file: b.bytes(), body: await b.body(), facts: await b.engine.executeRaw('SELECT expired_at::text, superseded_by FROM facts ORDER BY id') };
      const racing = mode.startsWith('late-') ? editWhenPrepared(b, () => mode === 'late-database' ? b.dbEdit() : b.fileEdit(), () => true) : b.engine;
      const result = await applyProposalAction(racing, id, action);
      if (mode === 'agree') {
        expect(result.status).toBe(action === 'accept' ? 'accepted' : 'undone');
        expect(b.bytes()).not.toBe(before.file);
        expect(await b.body()).not.toBe(before.body);
        return;
      }
      expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: before.file + (mode === 'late-file' ? EDIT : ''), body: before.body + (mode === 'late-database' ? EDIT : '') });
      expect(result.status).toBe('refused');
      expect(result.reason).toContain(`${SLUG} (file_database_drift`);
      expect(await b.engine.executeRaw('SELECT expired_at::text, superseded_by FROM facts ORDER BY id')).toEqual(before.facts);
      expect(await b.engine.executeRaw('SELECT status FROM decide_proposals WHERE id = $1', [id])).toEqual([{ status: action === 'accept' ? 'pending' : 'accepted' }]);
    });
  }, 180_000);

  test('write-through off accepts and undoes on the newer database body without writing the file', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const old = (await b.append()).ids[0]!;
      const fresh = (await b.append(b.engine, 'Alice Example leads design')).ids[0]!;
      const id = (await insertProposal(b.engine, { source_id: 'default', sweep_id: 'db-only-sweep', pair_index: 0,
        old_fact_id: old, new_fact_id: fresh, direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8,
        proposal_floor: 0.5, model_resolved: 'synthetic-model' }))!;
      await b.dbEdit();
      const before = b.bytes();
      await b.engine.setConfig('sync.write_through', 'false');
      _resetWriteThroughCacheForTest();
      expect((await applyProposalAction(b.engine, id, 'accept')).status).toBe('accepted');
      expect(b.bytes()).toBe(before);
      expect(await b.body()).toContain(EDIT.trim());
      expect((await applyProposalAction(b.engine, id, 'undo')).status).toBe('undone');
      expect(b.bytes()).toBe(before);
      expect(await b.body()).toContain(EDIT.trim());
    });
  }, 180_000);

  for (const action of ['accept', 'undo'] as const) test(`database-only ${action} holds a late database edit`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      const old = (await b.append()).ids[0]!;
      const fresh = (await b.append(b.engine, 'Alice Example leads design')).ids[0]!;
      const id = (await insertProposal(b.engine, { source_id: 'default', sweep_id: 'db-race-sweep', pair_index: 0,
        old_fact_id: old, new_fact_id: fresh, direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8,
        proposal_floor: 0.5, model_resolved: 'synthetic-model' }))!;
      await b.engine.setConfig('sync.write_through', 'false');
      _resetWriteThroughCacheForTest();
      if (action === 'undo') expect((await applyProposalAction(b.engine, id, 'accept')).status).toBe('accepted');
      const before = { file: b.bytes(), body: await b.body(), facts: await b.engine.executeRaw('SELECT expired_at::text, superseded_by FROM facts ORDER BY id') };
      const result = await applyProposalAction(editWhenPrepared(b, () => b.dbEdit(), () => true), id, action);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: before.file, body: before.body + EDIT });
      expect(result.status).toBe('refused');
      expect(result.reason).toContain(`${SLUG} (revision_conflict`);
      expect(await b.engine.executeRaw('SELECT expired_at::text, superseded_by FROM facts ORDER BY id')).toEqual(before.facts);
    });
  }, 180_000);

  for (const action of ['accept', 'undo'] as const) for (const editor of [false, true]) test(`${action}: a post-publication failure ${editor ? 'preserves the later editor save' : 'restores its unchanged published file'}`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      const old = (await b.append()).ids[0]!;
      const fresh = (await b.append(b.engine, 'Alice Example leads design')).ids[0]!;
      const id = (await insertProposal(b.engine, { source_id: 'default', sweep_id: 'post-publication-sweep', pair_index: 0,
        old_fact_id: old, new_fact_id: fresh, direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8,
        proposal_floor: 0.5, model_resolved: 'synthetic-model' }))!;
      if (action === 'undo') expect((await applyProposalAction(b.engine, id, 'accept')).status).toBe('accepted');
      const before = { file: b.bytes(), body: await b.body(), versions: await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id'),
        facts: await b.engine.executeRaw('SELECT expired_at::text, valid_until::text, superseded_by FROM facts ORDER BY id') };
      let published = '';
      let saved = '';
      const failure = Object.assign(new Error('forced transaction failure after publication'), { code: '08006' });
      const racing = failAfterPublication(b, before.file, failure, () => {
        published = b.bytes();
        if (editor) { b.fileEdit(); saved = b.bytes(); }
      });
      await expect(applyProposalAction(racing, id, action)).rejects.toBe(failure);
      expect(published).not.toBe(before.file);
      if (editor) expect(saved).toBe(published + EDIT);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: editor ? saved : before.file, body: before.body });
      expect(await b.engine.executeRaw('SELECT expired_at::text, valid_until::text, superseded_by FROM facts ORDER BY id')).toEqual(before.facts);
      expect(await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id')).toEqual(before.versions);
      expect(await b.engine.executeRaw('SELECT status FROM decide_proposals WHERE id = $1', [id])).toEqual([{ status: action === 'accept' ? 'pending' : 'accepted' }]);
    });
  }, 180_000);
});
