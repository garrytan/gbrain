/**
 * Postgres arms of the wanted-pages scenarios (test/wanted-links.test.ts runs
 * the same bodies on PGLite).
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { replaceWantedLinks } from '../../src/core/wanted-links.ts';
import { bareNameReferenceSettles, disabledClearsRows, forwardReferenceHeals, impossibleTargetsNeverAbortTheSweep,
  impossibleTargetsStayOutOfWrites, onlyUnresolvedAuthoredReferences, privateOriginsStayPrivate,
  restoredTargetHeals } from '../helpers/wanted-links-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres wanted pages', () => {
  test('a forward reference heals once its target exists', () => forwardReferenceHeals(url), 180_000);
  test('only unresolved authored references are wanted', () => onlyUnresolvedAuthoredReferences(url), 180_000);
  test('a bare-name reference settles', () => bareNameReferenceSettles(url), 180_000);
  test('private origins stay private', () => privateOriginsStayPrivate(url), 180_000);
  test('restoring a deleted target heals', () => restoredTargetHeals(url), 180_000);
  test('disabling clears rows', () => disabledClearsRows(url), 180_000);
  test('#6228/#6225: the stale sweep skips targets no page can have', () => impossibleTargetsNeverAbortTheSweep(url), 180_000);
  test('#6228/#6225: a write records only targets a page can have', () => impossibleTargetsStayOutOfWrites(url), 180_000);
});

describe.skipIf(!url)('Postgres wanted pages: source registration race (#6225)', () => {
  test('a foreign source checked for a wanted row cannot be deleted before the transaction ends', async () => {
    const { isolatedPersistencePostgres } = await import('../helpers/persistence-postgres.ts');
    const postgres = (await import('#postgres')).default;
    const brain = await isolatedPersistencePostgres(url!);
    const other = postgres(brain.databaseUrl, { max: 1, prepare: false });
    try {
      const engine = brain.engine;
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('archive', 'archive')");
      await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: 'Origin.', timeline: '' });
      const [origin] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'notes/origin'");
      let deleteError = null as { code?: string } | null;
      await engine.transaction(async tx => {
        await replaceWantedLinks(tx, { pageId: Number(origin.id), sourceId: 'default' }, { producers: ['body'], rows: [
          { producer: 'body', ref_kind: 'name', target_source_id: 'archive', target_ref: 'erin-example', link_type: 'mentions', context: '' }] });
        try {
          await other.begin(async sql => {
            await sql.unsafe("SET LOCAL lock_timeout = '300ms'");
            await sql.unsafe("DELETE FROM sources WHERE id = 'archive'");
          });
        } catch (error) { deleteError = error as { code?: string }; }
      });
      expect(deleteError?.code).toBe('55P03');
      expect(await engine.executeRaw("SELECT target_source_id FROM wanted_links")).toEqual([{ target_source_id: 'archive' }]);
    } finally { await other.end(); await brain.close(); }
  }, 180_000);
});
