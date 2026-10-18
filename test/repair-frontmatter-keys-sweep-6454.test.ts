/**
 * #6454 [R16]: the consented, source-scoped, preview-bound
 * `gbrain repair frontmatter-keys` sweep and its doctor check
 * `stale_frontmatter_keys`. The sweep is hygiene (the compare-side fix makes
 * the stored keys inert); it runs as a coordinated maintenance write under
 * the pages' key locks because the managed writer guard refuses a bare
 * `UPDATE pages`, and its preview states that every swept row advances its
 * knowledge_revision once.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { REVISION_ADVANCE_WARNING } from '../src/core/repair/frontmatter-keys.ts';
import { staleFrontmatterKeysCheck } from '../src/commands/doctor/checks/frontmatter-keys.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-6454-db-'));
const logger = { info() {}, warn() {}, error() {} };
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

test('frontmatter-keys is explicit-only and preview-bound, clears stale_frontmatter_keys', () => {
  expect(repairSpec('frontmatter-keys')).toMatchObject({ explicit_only: true, preview_bound: true, checks: ['stale_frontmatter_keys'], embeds: 'none' });
});

test('the sweep previews, applies under the coordinator per source, advances one revision per swept page and leaves the other source alone', async () => {
  for (const engine of engines) await sweepCase(engine);
}, 240_000);

const STALE = { type: 'person', title: 'Stored Title', tags: ['stale'] };

async function sweepCase(engine: BrainEngine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-6454-'));
  const roots = { a: join(dir, 'a'), b: join(dir, 'b') }; mkdirSync(roots.a); mkdirSync(roots.b);
  const sources = { a: `sweep-a-${randomUUID().slice(0, 8)}`, b: `sweep-b-${randomUUID().slice(0, 8)}` };
  const slugs = ['people/one-example', 'people/two-example', 'people/three-example'];
  const frontmatterOf = async (sourceId: string, slug: string) => (await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
    'SELECT frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0].frontmatter;
  const revisionOf = async (sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      for (const key of ['a', 'b'] as const) await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sources[key], roots[key]]);
      await engine.setConfig('sync.write_through', 'true');
      for (const key of ['a', 'b'] as const) await claimWorktree(engine, sources[key], roots[key]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctxFor = (sourceId: string) => ({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext);
      for (const key of ['a', 'b'] as const) for (const slug of slugs) {
        await submitPageMutation(ctxFor(sources[key]), { operation: 'put_page', params: { slug, request_id: randomUUID(),
          content: `---\ntype: person\ntitle: ${slug}\n---\n# ${slug}\n\nBody.\n` } });
      }
      // The reporter's rows in both sources (guard lifted for the seed, as an older import wrote them); one page in A is clean.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || $2::text::jsonb WHERE source_id = ANY($1::text[]) AND slug <> 'people/three-example'`,
        [[sources.a, sources.b], JSON.stringify(STALE)]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const filesBefore = Object.fromEntries(slugs.map(slug => [slug, readFileSync(join(roots.a, `${slug}.md`), 'utf8')]));

      // Forced negative: the bare UPDATE the sweep must not be is refused by the managed writer guard, row unchanged.
      await expect(engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - 'type' WHERE source_id=$1 AND slug=$2`, [sources.a, slugs[0]]))
        .rejects.toThrow(/writer_coordinator_required/);
      expect(await frontmatterOf(sources.a, slugs[0])).toMatchObject(STALE);

      // Doctor counts per source and names the preview.
      const warn = await staleFrontmatterKeysCheck(engine, [sources.a, sources.b]);
      expect(warn.status).toBe('warn');
      expect(warn.details).toMatchObject({ count: 4, sources: [{ source_id: sources.a, n: 2 }, { source_id: sources.b, n: 2 }], repair: 'frontmatter-keys' });
      expect(warn.message).toContain(`gbrain repair frontmatter-keys --source ${sources.a}`);
      expect(warn.message).toContain('knowledge_revision');

      // Preview: writes nothing, reports the rows and the revision advance, prints the hash.
      const revisionsBefore = Object.fromEntries(slugs.map(slug => [slug, null as string | null]));
      for (const slug of slugs) revisionsBefore[slug] = await revisionOf(sources.a, slug);
      const scope = await resolveRepairScope(engine, sources.a);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('frontmatter-keys', scope, { explicit: true, sourceFlag: sources.a });
      expect(preview.affected).toBe(1);
      expect(preview.warnings?.[0]).toContain('2 page(s) will have tags (2), title (2), type (2) removed');
      expect(preview.warnings?.[0]).toContain(REVISION_ADVANCE_WARNING);
      expect(preview.listing).toEqual([{ item: expect.stringMatching(new RegExp(`^${sources.a}:pages#\\d+-\\d+$`)), class: 'strip', detail: expect.stringContaining('2 page(s)') }]);
      expect(preview.details).toMatchObject({ total: 2, by_key: { type: 2, title: 2, tags: 2 } });
      expect(preview.cost).toMatchObject({ lifetime_ids: 0, receipt_bytes: 0, embedding_pages: 0 });
      expect(preview.apply_command).toBe(`gbrain repair frontmatter-keys --source ${sources.a} --apply --expect ${preview.preview_hash}`);
      for (const slug of slugs) expect(await revisionOf(sources.a, slug)).toBe(revisionsBefore[slug]!);
      expect(await frontmatterOf(sources.a, slugs[0])).toMatchObject(STALE);

      // --apply without --expect is refused; a hash for another selection is preview_changed.
      await expect((await repairRunner(engine, { apply: true, logger })).run('frontmatter-keys', scope, { explicit: true, sourceFlag: sources.a }))
        .rejects.toMatchObject({ code: 'invalid_params' });
      const scopeB = await resolveRepairScope(engine, sources.b);
      await expect((await repairRunner(engine, { apply: true, logger })).run('frontmatter-keys', scopeB, { explicit: true, sourceFlag: sources.b, expect: preview.preview_hash }))
        .rejects.toMatchObject({ code: 'preview_changed' });

      // A client read the page before the sweep and holds its revision.
      const heldRevision = revisionsBefore[slugs[0]]!;
      const applied = await (await repairRunner(engine, { apply: true, logger })).run('frontmatter-keys', scope, { explicit: true, sourceFlag: sources.a, expect: preview.preview_hash });
      expect(applied).toMatchObject({ applied: 1, skipped: 0, complete: true, outcomes: { stripped: 1 } });
      for (const slug of slugs.slice(0, 2)) {
        const frontmatter = await frontmatterOf(sources.a, slug);
        for (const key of ['type', 'title', 'tags', 'slug']) expect(Object.hasOwn(frontmatter, key)).toBe(false);
        expect(frontmatter).toMatchObject({ source_kind: 'put_page' });
        expect(await revisionOf(sources.a, slug)).not.toBe(revisionsBefore[slug]!);
      }
      // The clean page in A kept its revision; the files are untouched (database rows only); source B is untouched.
      expect(await revisionOf(sources.a, slugs[2])).toBe(revisionsBefore[slugs[2]]!);
      for (const slug of slugs) expect(readFileSync(join(roots.a, `${slug}.md`), 'utf8')).toBe(filesBefore[slug]);
      for (const slug of slugs.slice(0, 2)) expect(await frontmatterOf(sources.b, slug)).toMatchObject(STALE);
      expect(await engine.countStaleFrontmatterKeyPages({ sourceIds: [sources.a, sources.b] })).toEqual([{ source_id: sources.b, n: 2 }]);
      expect((await staleFrontmatterKeysCheck(engine, [sources.a])).status).toBe('ok');

      // Exactly one revision_conflict for the held revision; the re-read revision commits.
      const put = (expected: string) => submitPageMutation(ctxFor(sources.a), { operation: 'put_page', params: { slug: slugs[0], request_id: randomUUID(), expected_revision: expected,
        content: `---\ntype: person\ntitle: ${slugs[0]}\n---\n# ${slugs[0]}\n\nBody, edited after the sweep.\n` } })
        .then(receipt => (receipt as { state: string }).state, (error: { code?: string }) => error.code);
      expect(await put(heldRevision)).toBe('revision_conflict');
      expect(await put(await revisionOf(sources.a, slugs[0]))).toBe('committed');

      // A second preview finds nothing in A; applying the stale hash again is preview_changed (the set was cleared).
      const again = await (await repairRunner(engine, { apply: false, logger })).run('frontmatter-keys', scope, { explicit: true, sourceFlag: sources.a });
      expect(again.affected).toBe(0);
      await expect((await repairRunner(engine, { apply: true, logger })).run('frontmatter-keys', scope, { explicit: true, sourceFlag: sources.a, expect: preview.preview_hash }))
        .rejects.toMatchObject({ code: 'preview_changed' });
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}
