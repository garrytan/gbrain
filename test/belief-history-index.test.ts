/**
 * The history text index (docs/architecture/historical-retrieval.md section 4):
 * one row per content interval, opened in the appending transaction by every
 * event page-at-time counts as a content change, with chunks stored once by
 * hash; purge, expiry and hard delete leave the purged words in no column; the
 * build is preview-first, two passes, and the source's index cut stays unset
 * until its first pass completes. Each cell runs on PGLite, and on Postgres
 * when DATABASE_URL is set; each invariant has a forced probe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { fillCommitMarks } from '../src/core/belief/coverage-report.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { createPageVersion } from '../src/core/page-state/versions.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { __setHistoryIndexFaultForTests, buildHistoryIndex, historyIndexGaps, historyIndexState, isHistoryContentEvent } from '../src/core/belief/history-index.ts';
import { beliefLedgerEntry } from '../src/commands/doctor/checks/belief-ledger.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';
import { deletePage, forgetFact, lifetimeOf, quiescentInstant, simulatePreMigration } from './helpers/history-world.ts';

afterEach(() => __setHistoryIndexFaultForTests(null));

interface Row { id: number; revision: string; known_from: string; known_until: string | null; opening_event: number; closing_event: number | null; title: string | null;
  aliases: string[]; visibility: string; segmented: boolean; stale: boolean; chunks: number; takes: number }
const iso = (v: string | null) => v == null ? null : new Date(v).toISOString();
async function rows(b: BeliefBrain, slug: string): Promise<Row[]> {
  const lifetime = await lifetimeOf(b, slug);
  const out = await b.engine.executeRaw<Row>(`SELECT r.id, r.revision::text AS revision, r.known_from, r.known_until, r.opening_event, r.closing_event, r.title, r.aliases,
      r.visibility, r.segmented, r.stale, (SELECT count(*) FROM belief_text_revision_chunks m WHERE m.revision_row = r.id AND m.kind = 'body') AS chunks,
      (SELECT count(*) FROM belief_text_revision_chunks m WHERE m.revision_row = r.id AND m.kind = 'take') AS takes
    FROM belief_text_revisions r WHERE r.page_lifetime = $1::uuid ORDER BY r.known_from, r.id`, [lifetime]);
  return out.map(r => ({ ...r, id: Number(r.id), opening_event: Number(r.opening_event), closing_event: r.closing_event == null ? null : Number(r.closing_event),
    known_from: iso(r.known_from)!, known_until: iso(r.known_until), chunks: Number(r.chunks), takes: Number(r.takes),
    aliases: typeof r.aliases === 'string' ? (r.aliases as string).replace(/^\{|\}$/g, '').split(',').filter(Boolean) : r.aliases }));
}
const matches = async (b: BeliefBrain, rowId: number, word: string) => Number((await b.engine.executeRaw<{ n: number }>(`SELECT count(*) AS n FROM belief_text_revision_chunks m
  JOIN belief_text_chunks c ON c.text_hash = m.text_hash WHERE m.revision_row = $1 AND c.search_vector @@ plainto_tsquery('english', $2)`, [rowId, word]))[0]!.n);
const doctor = async (b: BeliefBrain): Promise<Check> => (await beliefLedgerEntry.run({ engine: b.engine, tier: 'standard', doFix: false, dryRun: false, orphanRatioSourceId: b.sourceId } as DoctorContext) as Check[])[0]!;
const chunkCount = async (b: BeliefBrain) => Number((await b.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM belief_text_chunks'))[0]!.n);

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`W3 history text index (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, opts: { managed?: boolean; enable?: boolean; setup?: (b: BeliefBrain) => Promise<void> } = {}) =>
      beliefBrain(run, { managed: opts.managed ?? true, enable: opts.enable, setup: opts.setup, databaseUrl: engineCase.databaseUrl });
    const slug = 'companies/acme-example';

    test('each content event opens one row at its recorded_at and closes the one before; an unchanged chunk is stored once', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Quorvane widgets.', takes: [{ claim: 'Brelloxi will grow', who: 'garry' }] }));
      await b.put(slug, beliefPage({ prose: 'Quorvane gadgets.', takes: [{ claim: 'Brelloxi will grow', who: 'garry', weight: '0.9' }] }));
      const chunksBefore = await chunkCount(b);
      await b.put(slug, beliefPage({ title: 'Acme Renamed Example', prose: 'Quorvane gadgets.', takes: [{ claim: 'Brelloxi will grow', who: 'garry', weight: '0.9' }] }));
      expect(await chunkCount(b)).toBe(chunksBefore);
      const events = (await b.events()).filter(e => e.subject_kind === 'page' && e.slug === slug);
      expect(events.map(e => e.event_type)).toEqual(['page.published', 'page.published', 'page.published']);
      const got = await rows(b, slug);
      expect(got.map(r => [r.opening_event, r.closing_event, r.known_from, r.known_until, r.revision]) as unknown[]).toEqual(events.map((e, i) =>
        [e.id, events[i + 1]?.id ?? null, iso(e.recorded_at), events[i + 1] ? iso(events[i + 1]!.recorded_at) : null, e.value!.revision_after]));
      expect(got.map(r => r.title)).toEqual(['Acme Example', 'Acme Example', 'Acme Renamed Example']);
      expect(got.every(r => r.chunks >= 1 && r.takes === 1 && !r.stale && !r.segmented && r.visibility === 'world')).toBe(true);
      expect(await matches(b, got[0]!.id, 'widgets')).toBe(1);
      expect(await matches(b, got[1]!.id, 'widgets')).toBe(0);
      const [take] = await b.engine.executeRaw<{ holder: string; take_key: string }>(`SELECT holder, take_key FROM belief_text_revision_chunks WHERE revision_row = $1 AND kind = 'take'`, [got[2]!.id]);
      expect(take!.holder).toBe('garry');
      expect(take!.take_key).toBe((await b.events()).find(e => e.subject_kind === 'take')!.subject_key);
      expect(await historyIndexGaps(b.engine, b.sourceId)).toEqual([]);
    }), 120_000);

    test('a baseline opens a row, so a page never edited since it is findable', () => brain(async b => {
      const got = await rows(b, slug);
      const baseline = (await b.events()).find(e => e.subject_kind === 'page' && e.slug === slug)!;
      expect(baseline.origin).toBe('baseline');
      expect(got.map(r => [r.opening_event, r.known_until])).toEqual([[baseline.id, null]]);
      expect(await matches(b, got[0]!.id, 'quorvane')).toBe(1);
    }, { setup: b => b.put(slug, beliefPage({ prose: 'Quorvane widgets.' })).then(() => undefined) }), 120_000);

    test('a forget opens rows at the same revision, and the materialized row no longer carries the withdrawn claim', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Profile.', facts: ['Acme raised a seed round', 'Acme hired Zentrovar staff'] }));
      await forgetFact(b, slug, 'Acme hired Zentrovar');
      const got = await rows(b, slug);
      const events = (await b.events()).filter(e => e.subject_kind === 'page' && e.slug === slug && isHistoryContentEvent(e));
      expect(events.map(e => e.event_type)).toEqual(['page.published', 'page.view_changed', 'page.view_changed']);
      expect(got.map(r => r.opening_event)).toEqual(events.map(e => e.id));
      expect(got[2]!.revision).toBe(got[1]!.revision);
      expect(await matches(b, got[0]!.id, 'zentrovar')).toBe(1);
      expect(await matches(b, got.at(-1)!.id, 'zentrovar')).toBe(0);
    }), 180_000);

    test('delete, restore and rename each open a row; a visibility-only event opens none', () => brain(async b => {
      await b.put('notes/old-example', beliefPage({ type: 'note', title: 'Old', prose: 'Quorvane notes.' }));
      await deletePage(b, 'notes/old-example');
      await b.put('notes/old-example', beliefPage({ type: 'note', title: 'Old', prose: 'Quorvane notes again.' }));
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/old-example', newSlug: 'notes/new-example', to: 'notes/new-example.md' });
      await fillCommitMarks(b.engine, b.sourceId);
      const events = (await b.events()).filter(e => e.subject_kind === 'page' && isHistoryContentEvent(e));
      expect(events.map(e => e.event_type)).toEqual(['page.published', 'page.deleted', 'page.restored', 'page.published']);
      expect((await rows(b, 'notes/new-example')).map(r => r.opening_event)).toEqual(events.map(e => e.id));
      expect(isHistoryContentEvent({ event_type: 'page.visibility_changed', value: { visible: false } })).toBe(false);
      expect(isHistoryContentEvent({ event_type: 'page.renamed', value: { old_slug: 'a', new_slug: 'b' } })).toBe(false);
      expect(isHistoryContentEvent({ event_type: 'page.deleted', value: { revision_before: 'r', hard: true } })).toBe(false);
      expect(isHistoryContentEvent({ event_type: 'page.purged', value: null })).toBe(false);
      expect(isHistoryContentEvent({ event_type: 'page.view_changed', value: { revision_before: 'r', revision_after: 'r', materialized: true } })).toBe(true);
    }, { managed: false }), 120_000);

    test('the row invariant: a content event with no open row is refused in tests and listed by doctor', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Quorvane widgets.' }));
      const mark = await b.lastId();
      const rawWrite = (prose: string) => b.engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
        await createPageVersion(tx, slug, b.sourceId, (await tx.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true }))!);
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'probe_history_row' }, () =>
          tx.executeRaw('UPDATE pages SET compiled_truth = $1, knowledge_revision = gen_random_uuid() WHERE source_id = $2 AND slug = $3', [prose, b.sourceId, slug]));
      });
      // Forced probe: maintenance skipped, the batch is refused and nothing commits.
      __setHistoryIndexFaultForTests('skip_maintenance');
      const refused = await rawWrite('Quorvane gadgets.').then(() => null, (e: Error) => e.message);
      expect(refused).toContain('belief history index invariant');
      expect(await b.lastId()).toBe(mark);
      await withEnv({ GBRAIN_BELIEF_HISTORY_CHECK: '0' }, () => rawWrite('Quorvane gadgets.'));
      __setHistoryIndexFaultForTests(null);
      await fillCommitMarks(b.engine, b.sourceId);
      const gap = (await b.events(mark)).find(e => e.subject_kind === 'page')!;
      expect((await historyIndexGaps(b.engine, b.sourceId)).map(g => g.event_id)).toEqual([gap.id]);
      const check = await doctor(b);
      expect(check.status).toBe('warn');
      expect(check.message).toContain(`${b.sourceId}: 1 content event(s) have no history index row (e.g. ${slug} at event ${gap.id})`);
    }, { managed: false }), 120_000);

    test('a segmented page gets a row with no chunks', () => brain(async b => {
      await b.engine.setConfig('pages.segmented_storage', 'on');
      await b.put(slug, beliefPage({ prose: `Quorvane ${'lorem ipsum dolor sit amet '.repeat(50_000)}` }));
      const [row] = await rows(b, slug);
      expect(row).toMatchObject({ segmented: true, chunks: 0 });
    }), 300_000);

    test('page purge, purge_fact and hard delete leave the purged words in no column, and no orphaned chunk', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Quorvane widgets.', facts: ['Acme opened a Velmorad office'], frontmatter: { aliases: '[Zelkinor Holdings]' } }));
      await b.put(slug, beliefPage({ prose: 'Quorvane gadgets.', facts: ['Acme opened a Velmorad office'], frontmatter: { aliases: '[Zelkinor Holdings]' } }));
      await b.put('companies/other-example', beliefPage({ title: 'Other Example', prose: 'Quorvane gadgets.' }));
      const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = 'Acme opened a Velmorad office' AND expired_at IS NULL ORDER BY id LIMIT 1`, [b.sourceId]);
      const dry = await operationsByName.purge_fact!.handler(b.ctx, { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
      await operationsByName.purge_fact!.handler(b.ctx, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      const carries = async (word: string) => Number((await b.engine.executeRaw<{ n: number }>(`SELECT (SELECT count(*) FROM belief_text_chunks WHERE search_vector @@ plainto_tsquery('english', $1))
        + (SELECT count(*) FROM belief_text_revisions WHERE title ILIKE '%' || $1 || '%' OR array_to_string(aliases, ' ') ILIKE '%' || $1 || '%') AS n`, [word]))[0]!.n);
      expect(await carries('velmorad')).toBe(0);
      expect(await carries('quorvane')).toBeGreaterThan(0);
      const revision = (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, slug]))[0]!.r;
      await b.op('delete_page', { slug, purge: true, expected_revision: revision });
      expect(await carries('widgets')).toBe(0);
      expect(await carries('zelkinor')).toBe(0);
      expect(await carries('Acme Example')).toBe(0);
      expect((await rows(b, slug)).every(r => r.stale && r.title === null && r.aliases.length === 0 && r.chunks === 0 && r.takes === 0)).toBe(true);
      expect(await carries('gadgets')).toBeGreaterThan(0);
      const [orphans] = await b.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM belief_text_chunks c WHERE NOT EXISTS (SELECT 1 FROM belief_text_revision_chunks m WHERE m.text_hash = c.text_hash)');
      expect(Number(orphans!.n)).toBe(0);
      expect(await doctor(b)).toMatchObject({ status: 'ok' });
    }), 180_000);

    test('the build: preview counts and writes nothing; apply indexes open intervals first, the cut stays unset until pass 1 completes, and a rerun appends nothing', () => brain(async b => {
      for (const n of [1, 2, 3]) {
        await b.put(`companies/c${n}-example`, beliefPage({ prose: `Quorvane first ${n}.` }));
        await b.put(`companies/c${n}-example`, beliefPage({ prose: `Quorvane second ${n}.` }));
      }
      const t = await quiescentInstant(b);
      const snapshot = async () => b.engine.executeRaw<Record<string, unknown>>(`SELECT r.page_lifetime::text, r.revision::text, r.known_from, r.known_until, r.opening_event, r.closing_event,
          r.title, r.visibility, (SELECT string_agg(encode(m.text_hash, 'hex') || m.kind || COALESCE(m.take_key, ''), ',' ORDER BY m.ord) FROM belief_text_revision_chunks m WHERE m.revision_row = r.id) AS chunks
        FROM belief_text_revisions r WHERE r.source_id = $1 ORDER BY r.page_lifetime, r.known_from`, [b.sourceId]);
      const maintained = await snapshot();
      expect((await historyIndexState(b.engine, b.sourceId)).index_cut).not.toBeNull();
      await simulatePreMigration(b, ['companies/c1-example', 'companies/c2-example', 'companies/c3-example']);
      expect(await historyIndexState(b.engine, b.sourceId)).toMatchObject({ index_cut: null, build_pass: 0 });
      const preview = await buildHistoryIndex(b.engine, b.sourceId, {});
      expect(preview).toMatchObject({ applied: false, intervals: 6, open_intervals: 3, closed_intervals: 3 });
      expect(preview.bytes).toBeGreaterThan(0);
      expect((await snapshot()).length).toBe(0);
      // Interrupted inside pass 1: the cut stays unset, so every instant refuses.
      const partial = await buildHistoryIndex(b.engine, b.sourceId, { apply: true, stopAfterLifetimes: 2 });
      expect(partial).toMatchObject({ applied: true, complete: false, build_pass: 1 });
      expect((await historyIndexState(b.engine, b.sourceId)).index_cut).toBeNull();
      const done = await buildHistoryIndex(b.engine, b.sourceId, { apply: true });
      expect(done).toMatchObject({ applied: true, complete: true, build_pass: 2 });
      expect(await snapshot()).toEqual(maintained);
      const state = await historyIndexState(b.engine, b.sourceId);
      expect(Date.parse(state.index_cut!)).toBeLessThanOrEqual(Date.parse(t));
      expect(await buildHistoryIndex(b.engine, b.sourceId, { apply: true })).toMatchObject({ indexed: 0, complete: true });
      expect(await snapshot()).toEqual(maintained);
    }), 180_000);

    test('a source enabled after the migration has its index cut at its coverage start', () => brain(async b => {
      const other = `${b.sourceId}-later`;
      await b.engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [other]);
      await enableBeliefLedger(b.engine, other);
      const state = await historyIndexState(b.engine, other);
      expect(state.index_cut).not.toBeNull();
      expect(state.build_pass).toBe(2);
    }, { managed: false }), 120_000);
  });
}

