/** #8390: hand-edited take citations cannot abort publication or disagree with removal.
 * Real managed publication/rebuild/removal on each storage backend; no model calls.
 * Existing supersede tests cover only generated, lowercase, single citations.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { extractTakesFromDb } from '../src/core/cycle/extract-takes.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { assertExportProjectionRoundtrip } from '../src/core/shared-skills/migration-projection.ts';
import { renderTakesFence, type ParsedTake } from '../src/core/takes-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const take = (rowNum: number, source?: string, active = false): ParsedTake =>
  ({ rowNum, claim: `Synthetic claim ${rowNum}`, kind: 'take', holder: 'world', weight: 0.5, active, source });
const content = (takes: ParsedTake[]) => `---\ntype: note\ntitle: Citation fixture\n---\n\n## Takes\n\n${renderTakesFence(takes)}\n`;


for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: invalid supersession numbers do not abort a managed fence publication or rebuild`, async () => {
    await managedBrain(async ({ engine, ctx }) => {
      const slug = 'notes/citation-bounds';
      const result = await submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), slug,
        content: content([take(1, 'superseded by #2147483648'), take(2, 'superseded by #0'), take(3, 'superseded by #3'),
          take(4, 'superseded by #9999999999999999999999'), take(5, 'memo; superseded by #6'), take(6, 'new evidence', true)]) } });
      expect(result).toMatchObject({ state: 'committed' });
      const rows = () => engine.executeRaw<{ row_num: number; superseded_by: number | null }>(
        'SELECT t.row_num,t.superseded_by FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY t.row_num', ['default', slug]);
      const expected = [null, null, null, null, 6, null];
      expect((await rows()).map(r => r.superseded_by)).toEqual(expected);
      await extractTakesFromDb(engine, { sourceId: 'default', slugs: [slug], rebuild: true });
      expect((await rows()).map(r => r.superseded_by)).toEqual(expected);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: projection, rebuild and removal use the last citation regardless of case`, async () => {
    await managedBrain(async ({ engine, ctx }) => {
      for (const [name, source, target] of [['upper', 'Superseded by #2', 2],
        ['last', 'memo; superseded by #2; SUPERSEDED BY #3', 3]] as const) {
        const slug = `notes/citation-${name}`;
        const submit = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx,
          { operation, params: { request_id: randomUUID(), slug, ...params } });
        const markdown = content([take(1, source), take(2, 'second', true), take(3, 'third', true)]);
        await submit('put_page', { content: markdown });
        const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
        await assertExportProjectionRoundtrip(engine, parseMarkdown(markdown, `${slug}.md`), snapshot.page.id, 'default');
        const pointer = async () => (await engine.executeRaw<{ superseded_by: number | null }>(
          'SELECT t.superseded_by FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 AND t.row_num=1', ['default', slug]))[0].superseded_by;
        expect(await pointer()).toBe(target);
        await extractTakesFromDb(engine, { sourceId: 'default', slugs: [slug], rebuild: true });
        expect(await pointer()).toBe(target);
        const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
        await expect(submit('takes_remove', { row_num: target })).rejects.toMatchObject({ code: 'invalid_params' });
        expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before);
        if (name === 'last') {
          expect(await submit('takes_remove', { row_num: 2 })).toMatchObject({ state: 'committed', removed: true });
          expect(await pointer()).toBe(3);
        }
      }
    }, { databaseUrl });
  }, 120_000);
}
