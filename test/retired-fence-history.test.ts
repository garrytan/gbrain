import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`changing an active date leaves an unchanged retired fence row's history intact (${backend})`,
    () => managedBrain(async ({ engine, ctx }) => {
      const slug = 'people/alice-example';
      const scope = { sourceId: 'default' };
      const oldClaim = 'Alice Example works in the north building.';
      const nextClaim = 'Alice Example works in the south building.';
      const unaffected = 'Alice Example uses the main entrance.';
      const call = async (name: string, input: Record<string, unknown>) =>
        operationsByName[name]!.handler(ctx, { request_id: randomUUID(), source_id: 'default', ...input }) as Promise<Record<string, unknown>>;
      const put = (content: string, expected_revision?: string) => call('put_page', { slug, content, expected_revision });
      const remember = (fact: string, valid_from: string, replaces?: string) =>
        call('remember', { entity: slug, fact, valid_from, replaces, provenance: 'test fixture',
          visibility: 'private', infer_entity: false, content_origin: 'user_said' });
      const stored = async (id: string) => {
        const [row] = await engine.executeRaw<{ state: Record<string, unknown> }>(
          "SELECT to_jsonb(f)-'embedding' AS state FROM facts f WHERE source_id='default' AND id=$1", [id]);
        return row!.state;
      };
      await put('---\ntype: person\ntitle: Alice Example\n---\nAlice Example has an office.\n');
      const old = await remember(oldClaim, '2025-01-01');
      const successor = await remember(nextClaim, '2025-02-01', String(old.id));
      const dated = await remember(unaffected, '2025-03-01');
      const before = await stored(String(old.id));
      expect(before.expired_at).not.toBeNull();
      expect(String(before.superseded_by)).toBe(String(successor.id));
      const current = (await engine.readPageSnapshot(slug, scope))!;
      const oldFence = parseFactsFence(current.page.compiled_truth).facts.find(row => row.claim === oldClaim)!;
      const contents = serializePageToMarkdown(current.page, current.tags);
      expect(contents).toContain('2025-03-01');
      const changed = contents.replace('2025-03-01', '2025-02-25');
      await put(changed, current.revision);
      expect(new Date(String((await stored(String(dated.id))).valid_from)).toISOString()).toBe('2025-02-25T00:00:00.000Z');
      const revised = (await engine.readPageSnapshot(slug, scope))!;
      const revisedFence = parseFactsFence(revised.page.compiled_truth).facts.find(row => row.claim === oldClaim);
      expect(revisedFence).toEqual(oldFence);
      expect(await stored(String(old.id))).toEqual(before);
      const reconciled = await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] });
      expect(reconciled.pagesFailed).toBe(0);
      expect(reconciled.warnings).toEqual([]);
      expect(await stored(String(old.id))).toEqual(before);
      const oldContext = revisedFence!.context!;
      const intendedContext = oldContext + ' (archival note)';
      const annotated = serializePageToMarkdown(revised.page, revised.tags).replace(oldContext, intendedContext);
      await put(annotated, revised.revision);
      const edited = await stored(String(old.id));
      expect(edited.context).toBe(intendedContext);
      expect(edited.expired_at).toEqual(before.expired_at);
      expect(String(edited.superseded_by)).toBe(String(successor.id));
      expect((await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] })).pagesFailed).toBe(0);
      expect(await stored(String(old.id))).toEqual(edited);
    }, { databaseUrl }), 180_000);
}
