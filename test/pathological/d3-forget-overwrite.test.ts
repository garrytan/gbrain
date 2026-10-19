/**
 * D-3 (GBRA-131, #6982): withdrawal is authoritative even when its file mirror is held.
 * Protects: differing or concurrently edited copies keep their exact bodies; withdrawal still commits and is
 * reported with file_database_drift. Agreeing copies still strike the file and stored body.
 * Fails when: forget strikes the file and unconditionally mirrors all its prose over the database.
 * Existing forget tests cover withdrawal durability but not divergent copies of a live page.
 * Seams: engine transaction proxy lands real file/DB edits after fence preparation; no production hook.
 */
import { describe, expect, test } from 'bun:test';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { pathologicalArms, runScopedErrors } from './harness.ts';
import { EDIT, SLUG, editAfterWrite, editWhenPrepared, withFactsBrain } from './facts-overwrite-fixture.ts';

for (const { backend, databaseUrl } of pathologicalArms()) describe(`D-3 forget mirrors (${backend})`, () => {
  for (const action of ['withdrawal', 'supersession'] as const) for (const mode of ['database', 'file', 'late-database', 'late-file'] as const) test(`${action}: ${mode} edit holds the mirror but commits expiry`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      const id = (await b.append()).ids[0]!;
      if (mode === 'database') await b.dbEdit();
      if (mode === 'file') b.fileEdit();
      const before = { file: b.bytes(), body: await b.body() };
      const racing = mode.startsWith('late-') ? editWhenPrepared(b, () => mode === 'late-database' ? b.dbEdit() : b.fileEdit()) : b.engine;
      const result = await forgetFactInFence(racing, id, action === 'supersession' ? { supersededBy: { rowNum: null } } : {});
      expect({ file: b.bytes(), body: await b.body() }).toEqual({
        file: before.file + (mode === 'late-file' ? EDIT : ''), body: before.body + (mode === 'late-database' ? EDIT : ''),
      });
      expect(result).toMatchObject({ ok: true, path: 'legacy_db' });
      expect(result.warning).toContain(`${SLUG} (file_database_drift`);
      expect(await b.engine.executeRaw('SELECT id FROM facts WHERE expired_at IS NULL')).toEqual([]);
      expect(await b.engine.executeRaw('SELECT fact_hash FROM fact_withdrawals')).toHaveLength(action === 'withdrawal' ? 1 : 0);
    });
  }, 180_000);

  test('agreeing copies are struck in file and database', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const id = (await b.append()).ids[0]!;
      expect((await forgetFactInFence(b.engine, id)).path).toBe('fence');
      expect(parseFactsFence(b.bytes()).facts[0]!.active).toBe(false);
      expect(parseFactsFence(await b.body()).facts[0]!.active).toBe(false);
    });
  }, 180_000);

  test('an editor save after the body mirror rolls back that mirror and its version before rename', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const id = (await b.append()).ids[0]!;
      const before = { file: b.bytes(), body: await b.body(), versions: await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id') };
      let saved = '';
      const racing = editAfterWrite(b, 'refreshPageBody', () => { b.fileEdit(); saved = b.bytes(); });
      const result = await forgetFactInFence(racing, id, { supersededBy: { rowNum: null } });
      expect(saved).toBe(before.file + EDIT);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: saved, body: before.body });
      expect(result).toMatchObject({ ok: true, path: 'legacy_db' });
      expect(result.warning).toContain(`${SLUG} (file_database_drift`);
      expect(await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id')).toEqual(before.versions);
      expect(await b.engine.executeRaw('SELECT id FROM facts WHERE expired_at IS NULL')).toEqual([]);
    });
  }, 180_000);

  test('write-through off keeps the file untouched and strikes the newer database body', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const id = (await b.append()).ids[0]!;
      await b.dbEdit();
      const before = b.bytes();
      await b.engine.setConfig('sync.write_through', 'false');
      _resetWriteThroughCacheForTest();
      expect((await forgetFactInFence(b.engine, id)).path).toBe('legacy_db');
      expect(b.bytes()).toBe(before);
      expect(await b.body()).toContain(EDIT.trim());
      expect(parseFactsFence(await b.body()).facts[0]!.active).toBe(false);
    });
  }, 180_000);

  test('write-through off holds a database-only mirror when a late edit lands', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const id = (await b.append()).ids[0]!;
      await b.engine.setConfig('sync.write_through', 'false');
      _resetWriteThroughCacheForTest();
      const before = { file: b.bytes(), body: await b.body() };
      let transactions = 0;
      const racing = editWhenPrepared(b, () => b.dbEdit(), () => ++transactions === 2);
      const result = await forgetFactInFence(racing, id);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: before.file, body: before.body + EDIT });
      expect(result.warning).toContain(`${SLUG} (revision_conflict`);
      expect(await b.engine.executeRaw('SELECT id FROM facts WHERE expired_at IS NULL')).toEqual([]);
    });
  }, 180_000);

  test('a run-scoped database-only mirror failure still throws after withdrawal commits', async () => {
    for (const fault of runScopedErrors()) await withFactsBrain(databaseUrl, async b => {
      const id = (await b.append()).ids[0]!;
      await b.engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'default'");
      let transactions = 0;
      const racing = editWhenPrepared(b, () => { throw fault.error(); }, () => ++transactions === 2);
      await expect(forgetFactInFence(racing, id)).rejects.toThrow();
      expect(await b.engine.executeRaw('SELECT id FROM facts WHERE expired_at IS NULL')).toEqual([]);
    });
  }, 180_000);
});
