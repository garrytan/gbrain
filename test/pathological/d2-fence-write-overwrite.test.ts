/**
 * D-2 (GBRA-131, #6982): appending facts never mirrors a different checkout body over the database.
 * Protects: database-newer, file-newer and concurrent edits retain exact bytes; the writer returns a DB-only
 * fallback, and writeSingleFact records the unfenced fact. Agreeing copies still append with history.
 * Fails when: the pre-fix whole-file mirror overwrites the DB after publishing the file.
 * Existing coverage checks missing files, not divergent live copies or publication races.
 * Inferred subjects keep their authorized attribution and provenance while drift holds their page out of
 * destructive reconciliation; existing inference coverage does not assert preservation of either body.
 * Seams: engine proxy injects a real edit before the prepared fence transaction; no production-only hook.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __setChatTransportForTests, resetGateway } from '../../src/core/ai/gateway.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { runFactsPipeline } from '../../src/core/facts/backstop.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { pathologicalArms } from './harness.ts';
import { CLAIM, EDIT, SLUG, editAfterWrite, editWhenPrepared, withFactsBrain } from './facts-overwrite-fixture.ts';

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

for (const { backend, databaseUrl } of pathologicalArms()) describe(`D-2 fence writes (${backend})`, () => {
  for (const mode of ['database', 'file', 'late-database', 'late-file'] as const) test(`${mode} edit preserves both copies and falls back`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      if (mode === 'database') await b.dbEdit();
      if (mode === 'file') b.fileEdit();
      const before = { file: b.bytes(), body: await b.body() };
      const racing = mode.startsWith('late-') ? editWhenPrepared(b, () => mode === 'late-database' ? b.dbEdit() : b.fileEdit()) : b.engine;
      const result = await b.append(racing);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({
        file: before.file + (mode === 'late-file' ? EDIT : ''), body: before.body + (mode === 'late-database' ? EDIT : ''),
      });
      expect(result).toMatchObject({ inserted: 0, legacyFallback: true, databaseOnlyReason: 'file_database_drift' });
      expect(result.warning).toContain(`${SLUG} (file_database_drift`);
      expect(result.warning).toContain('gbrain sync --source default');
      expect((await writeSingleFact(b.engine, 'default', { fact: CLAIM, entity: SLUG, provenance: 'test', visibility: 'world' })).status).toBe('inserted');
      expect(await b.engine.executeRaw('SELECT fact, row_num FROM facts')).toEqual([{ fact: CLAIM, row_num: null }]);
    });
  }, 180_000);

  test('agreeing copies append and preserve the prior body', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const before = await b.body();
      expect((await b.append()).inserted).toBe(1);
      expect(parseFactsFence(b.bytes()).facts.map(f => f.claim)).toEqual([CLAIM]);
      expect(parseFactsFence(await b.body()).facts.map(f => f.claim)).toEqual([CLAIM]);
      expect(await b.engine.executeRaw('SELECT compiled_truth FROM page_versions WHERE compiled_truth = $1', [before])).toHaveLength(1);
    });
  }, 180_000);

  test('an editor save after fact insertion rolls back the mirror, rows and versions before rename', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const before = { file: b.bytes(), body: await b.body(), versions: await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id') };
      let saved = '';
      const result = await b.append(editAfterWrite(b, 'insertFacts', () => { b.fileEdit(); saved = b.bytes(); }));
      expect(saved).toBe(before.file + EDIT);
      expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: saved, body: before.body });
      expect(result).toMatchObject({ inserted: 0, legacyFallback: true, databaseOnlyReason: 'file_database_drift' });
      expect(result.warning).toContain(`${SLUG} (file_database_drift`);
      expect(await b.engine.executeRaw('SELECT id FROM facts')).toEqual([]);
      expect(await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id')).toEqual(before.versions);
    });
  }, 180_000);

  for (const mode of ['database', 'file'] as const) test(`${mode} drift keeps an authorized inferred subject and both bodies`, async () => {
    await withFactsBrain(databaseUrl, async b => {
      if (mode === 'database') await b.dbEdit();
      else b.fileEdit();
      const before = { file: b.bytes(), body: await b.body() };
      __setChatTransportForTests(async () => ({
        text: JSON.stringify({ facts: [{ fact: CLAIM, entity: null, kind: 'fact', confidence: 1, notability: 'high' }] }),
        blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      }));
      const result = await runFactsPipeline('turn', { engine: b.engine, sourceId: 'default', sessionId: null,
        source: 'mcp:extract_facts', sourceSlug: SLUG, mode: 'inline', visibility: 'world', remote: false });
      expect(result.inserted).toBe(1);
      expect(await b.engine.executeRaw('SELECT entity_slug, row_num, context FROM facts WHERE id = $1', [result.fact_ids[0]]))
        .toEqual([{ entity_slug: SLUG, row_num: null, context: `${SLUG} — entity inferred from page` }]);
      const reconcile = await runExtractFacts(b.engine, { sourceId: 'default' });
      expect(reconcile.legacyRowsPending).toBe(1);
      expect(reconcile.guardTriggered).toBe(true);
      expect(reconcile.legacyPages).toEqual([SLUG]);
      expect(reconcile.warnings.some(w => w.includes(`${SLUG} (file_database_drift`))).toBe(true);
      expect({ file: b.bytes(), body: await b.body() }).toEqual(before);
      expect(await b.engine.executeRaw('SELECT entity_slug, row_num FROM facts WHERE expired_at IS NULL'))
        .toEqual([{ entity_slug: SLUG, row_num: null }]);
    });
  }, 180_000);
});
