import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { rebuildNote, selectPurgeCandidates } from '../src/core/persistence/purge-deleted.ts';
import { REBUILD_LINK_COLUMNS, REBUILD_STORES } from '../src/core/persistence/concept-rebuild.ts';
import { CARRIED_LINK_COLUMNS, CARRY_LINKS_SQL } from '../src/core/engine-sql/concept-rebuild.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { runPages } from '../src/commands/pages.ts';
import { runMaintain } from '../src/commands/maintain.ts';
import { runCycle } from '../src/core/cycle.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { MODEL, CONCEPT, NEW, atom, members, reply, put, deletePage, unmanagedWhile, age, raw, printedJson, purge, synthesize, state, heldConcept } from './helpers/concept-rebuild-9653.ts';

afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); });

test('the link carry writes exactly the link columns the census marks carried', () => {
  // engine-sql/concept-rebuild.ts spells the carry's columns out (its SQL guard rejects computed text); this pins them
  // to REBUILD_LINK_COLUMNS, which the census below pins to the links table.
  const carried = Object.entries(REBUILD_LINK_COLUMNS).filter(([, v]) => v === 'carried').map(([k]) => k);
  expect([...CARRIED_LINK_COLUMNS] as string[]).toEqual(carried);
  expect(CARRY_LINKS_SQL).toContain(`INSERT INTO links (${CARRIED_LINK_COLUMNS.join(', ')})`);
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`a concept hidden by an input purge is rebuilt as a fresh page: the purge and its census (${backend})`, () => {
    test('the single-page purge deletes exactly what the cutoff purge deletes', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const slugs = ['notes/purge-a', 'notes/purge-b'];
        for (const slug of slugs) {
          await put(ctx, slug, `Body of ${slug} with [[notes/purge-other]].`, 'note');
          const at = await engine.readPageSnapshot(slug, { sourceId: 'default' });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: at!.revision,
            content: `---\ntitle: ${slug}\ntype: note\nvisibility: world\n---\nSecond body of ${slug} with [[notes/purge-other]].` } });
        }
        await put(ctx, 'notes/purge-other', 'Links to [[notes/purge-a]] and [[notes/purge-b]].', 'note');
        await unmanagedWhile(engine, true, async () => {
          for (const slug of slugs) {
            const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
            await engine.executeRaw("INSERT INTO tags (page_id, tag) VALUES ($1, 't')", [page!.id]);
            await engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-01', 'e')", [page!.id]);
            await engine.executeRaw("INSERT INTO facts (source_id, fact, source, source_markdown_slug) VALUES ('default', $2, 'test', $1)", [slug, `A fact on ${slug}.`]);
            await engine.executeRaw("INSERT INTO page_aliases (source_id, slug, alias_norm) VALUES ('default', $1, $2)", [slug, `alias ${slug}`]);
            await engine.executeRaw("INSERT INTO open_loops (source_id, page_slug, kind, summary) VALUES ('default', $1, 'promise', 'x')", [slug]).catch(() => undefined);
          }
        });
        await raw(engine, "UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = 'default' AND slug = ANY($1::text[])", [slugs]);
        const counts = async (slug: string) => (await engine.executeRaw<Record<string, number>>(`SELECT
          (SELECT count(*)::int FROM pages WHERE slug=$1) AS pages,
          (SELECT count(*)::int FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1) AS chunks,
          (SELECT count(*)::int FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1) AS versions,
          (SELECT count(*)::int FROM links l JOIN pages p ON p.id IN (l.from_page_id, l.to_page_id) WHERE p.slug=$1) AS links,
          (SELECT count(*)::int FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL) AS live_facts,
          (SELECT count(*)::int FROM page_aliases WHERE slug=$1) AS aliases,
          (SELECT count(*)::int FROM open_loops WHERE page_slug=$1) AS loops`, [slug]))[0]!;
        const before = [await counts(slugs[0]!), await counts(slugs[1]!)];
        expect(before[0]).toEqual(before[1]!);
        expect(before[0]!.versions).toBeGreaterThan(0);
        await unmanagedWhile(engine, true, async () => {
          const [a] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug=$1", [slugs[0]]);
          expect((await engine.purgeDeletedPages(0, { onlyIds: [Number(a!.id)] })).slugs).toEqual([slugs[0]!]);
          expect(await counts(slugs[1]!)).toEqual(before[1]!);
          expect((await engine.purgeDeletedPages(72)).slugs).toEqual([slugs[1]!]);
        });
        expect(await counts(slugs[0]!)).toEqual(await counts(slugs[1]!));
        expect((await counts(slugs[0]!)).pages).toBe(0);
      }, { databaseUrl });
    }, 300_000);

    test('every column of links and of the rewritten page, and every table keyed to a page, is carried, regenerated or held on by the rebuild', async () => {
      const PAGE_COLUMNS: Record<string, 'held' | 'regenerated'> = Object.fromEntries([
        ...['title', 'compiled_truth', 'timeline', 'frontmatter', 'source_path', 'source_uri', 'withheld_source_path', 'page_readers', 'folder_rule_ids',
          'body_storage', 'truth_lead', 'timeline_lead'].map(c => [c, 'held'] as const),
        ...['id', 'source_id', 'slug', 'type', 'page_kind', 'content_hash', 'emotional_weight', 'created_at', 'updated_at', 'deleted_at', 'effective_date',
          'effective_date_source', 'import_filename', 'salience_touched_at', 'last_retrieved_at', 'links_extracted_at', 'database_only_reason',
          'contextual_retrieval_mode', 'corpus_generation', 'generation', 'search_vector', 'knowledge_revision', 'text_projection_revision',
          'emotional_weight_recomputed_at', 'chunker_version', 'ingested_via', 'ingested_at', 'source_kind', 'embedding_signature',
          'links_attendance_blocked_revision', 'links_attendance_blocked_at', 'revision_write_request_id', 'revision_principal_kind',
          'revision_principal_id', 'trust_tier', 'write_origin', 'body_bytes', 'truth_bytes', 'body_lines', 'body_generation', 'segment_count',
          'segmenter_version', 'body_flags', 'links_extract_failure', 'version_history_gap_at'].map(c => [c, 'regenerated'] as const),
      ]);
      const PAGE_TABLES: Record<string, 'held' | 'regenerated'> = Object.fromEntries([
        ...['files', 'link_edge_proposals', 'link_transitions', 'links', 'page_label_guards', 'raw_data', 'tags', 'takes', 'timeline_entries',
          'entity_identities', 'guest_marks', 'guest_promotions'].map(t => [t, 'held'] as const),
        ...['chronicle_page_state', 'content_chunks', 'extract_atoms_page_state', 'link_relationships', 'page_body_manifest', 'page_body_stagings',
          'page_derivation_spend', 'page_embedding_budget', 'page_extraction_state', 'page_facts_reconcile', 'page_mention_state',
          'page_segment_derivations', 'page_versions', 'page_view_digests', 'secret_store_occurrence', 'synthesis_evidence', 'wanted_links'].map(t => [t, 'regenerated'] as const),
      ]);
      await managedBrain(async ({ engine }) => {
        const columns = async (table: string) => (await engine.executeRaw<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()", [table])).map(r => r.c).sort();
        expect(await columns('links')).toEqual(Object.keys(REBUILD_LINK_COLUMNS).sort());
        expect(await columns('pages')).toEqual(Object.keys(PAGE_COLUMNS).sort());
        const tables = (await engine.executeRaw<{ t: string }>("SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = 'pages'::regclass AND contype = 'f'")).map(r => r.t).sort();
        expect(tables).toEqual(Object.keys(PAGE_TABLES).sort());
      }, { databaseUrl });
    }, 120_000);

    test('every store a page purge removes rows from is classified stated or derived', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        const snapshot = await engine.readPageSnapshot(CONCEPT, { sourceId: 'default', includeDeleted: true });
        const receipt = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: CONCEPT, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() } }) as { purge: { removed: Record<string, number> } };
        for (const store of Object.keys(receipt.purge.removed)) expect([store, REBUILD_STORES[store]]).toEqual([store, expect.stringMatching(/^(stated|derived)$/)]);
      }, { databaseUrl });
    }, 300_000);

    test('a concept a person deleted stays deleted, also after an input purge marks it', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await engine.setConfig('models.dream.synthesize', MODEL);
        for (const i of [0, 1, 2, 3, 4]) await put(ctx, atom(i), `Atom ${i} about storage.`);
        await synthesize(engine, root, [0, 1, 2, 3, 4]);
        await deletePage(engine, ctx, CONCEPT);
        await deletePage(engine, ctx, atom(0));
        await age(engine, atom(0));
        expect(await purge(engine, true)).toEqual([atom(0)]);
        const details = await synthesize(engine, root, [1, 2, 3, 4], { text: NEW });
        expect(details.skipped_deleted).toEqual([CONCEPT]);
        expect(await state(engine)).toMatchObject({ live: false });
      }, { databaseUrl });
    }, 300_000);

    test('a held concept a person then deletes stays deleted', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        await deletePage(engine, ctx, CONCEPT);
        const details = await synthesize(engine, root, [1, 2, 3, 4, 5], { text: NEW });
        expect(details.skipped_deleted).toEqual([CONCEPT]);
        expect(await state(engine)).toMatchObject({ live: false });
      }, { databaseUrl });
    }, 300_000);

    test('the purge previews name each held concept and, for one kept hidden, why', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const id = await heldConcept(engine, ctx, root);
        const held = [{ source_id: 'default', slug: CONCEPT }];
        expect((await selectPurgeCandidates(engine, 72, { automatic: true, model: false })).rebuild).toEqual({ held, kept: [{ ...held[0]!, reason: 'no_model' }] });
        __setChatTransportForTests(async () => reply(NEW));
        for (const automatic of [true, false]) expect((await selectPurgeCandidates(engine, 72, { automatic, model: true })).rebuild).toEqual({ held, kept: [] });
        const note = rebuildNote({ held, kept: [] });
        expect(note).toContain(`1 of them are rebuilt by the next concept synthesis that still finds at least two members for them (one with fewer stays hidden until an explicit purge): default/${CONCEPT}`);
        const explicit = await printedJson(() => runPages(engine, ['purge-deleted', '--dry-run', '--json']));
        expect(explicit).toMatchObject({ rebuild: { held } });
        expect(explicit.rebuild_note).toEndWith('This purge removes any of them listed above instead.');
        const automatic = await printedJson(() => runMaintain(engine, ['--purge', '--json']));
        expect(automatic).toMatchObject({ mode: 'preview', rebuild: { held }, rebuild_note: note });
        await raw(engine, "INSERT INTO tags (page_id, tag) VALUES ($1, 'hand-tag')", [id]);
        const kept = (await selectPurgeCandidates(engine, 72, { automatic: true, model: true })).rebuild;
        expect(kept.kept).toEqual([{ ...held[0]!, reason: 'stated', kinds: ['tags'] }]);
        expect(rebuildNote(kept)).toContain(`default/${CONCEPT}: stays hidden, it carries what a person or an agent stated (tags)`);
        const phase = (await runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: 'default' })).phases.find(p => p.phase === 'purge')!;
        expect(phase.details).toMatchObject({ purged_pages_kept_for_rebuild: held, kept_hidden: kept.kept });
        expect(phase.summary).toContain('1 concept(s) hidden by an input purge kept for the next concept synthesis (1 of them stay hidden');
        expect(await state(engine)).toMatchObject({ live: false, marks: 1 });
      }, { databaseUrl });
    }, 300_000);

    for (const aged of [100, 10]) test(`deleting a held concept aged ${aged}h: the receipt states the true expiry and the tombstone keeps its date`, async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await heldConcept(engine, ctx, root);
        await age(engine, CONCEPT, aged);
        const [before] = await engine.executeRaw<{ at: string; until: string }>(`SELECT deleted_at::text AS at,
          to_char((deleted_at + interval '72 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS until FROM pages WHERE slug=$1`, [CONCEPT]);
        const receipt = await deletePage(engine, ctx, CONCEPT);
        const [after] = await engine.executeRaw<{ at: string }>('SELECT deleted_at::text AS at FROM pages WHERE slug=$1', [CONCEPT]);
        expect(after!.at).toBe(before!.at);
        expect(String(receipt.recoverable_until)).toStartWith(aged > 72 ? `the next purge (its 72h window ended ${before!.until})` : `${before!.until} via restore_page`);
        expect(await purge(engine, true)).toEqual(aged > 72 ? [CONCEPT] : []);
      }, { databaseUrl });
    }, 300_000);
  });
}
