/**
 * W2 page-at-time probes (docs/designs/BELIEF_LEDGER.md section 10):
 * `get_page {known_as_of}` and `get_versions {known_as_of}` read the page as
 * this brain had recorded it at an instant, from validity intervals over the
 * ledger's publication events. Each cell of section 10's table, plus the
 * coverage, clock and purge refusals, runs on PGLite and on Postgres when
 * DATABASE_URL is set, and each has a forced probe that must make it fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { fillCommitMarks } from '../src/core/belief/coverage-report.ts';
import { backfillBeliefHistory } from '../src/core/belief/backfill.ts';
import { replayPurgesInRestore } from '../src/core/belief/purge-mirror.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { __setBeliefEmitterFaultForTests } from '../src/core/belief/append.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { preimageGaps } from '../src/core/belief/preimages.ts';
import { beliefLedgerEntry } from '../src/commands/doctor/checks/belief-ledger.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { waitForValue } from './helpers/wait-for.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => __setBeliefEmitterFaultForTests(null));

const dbNow = async (b: BeliefBrain) => new Date(new Date((await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`))[0]!.t).getTime()).toISOString();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const at = async (b: BeliefBrain) => { await pause(); const t = await dbNow(b); await pause(); return t; };
const iso = (v: string) => new Date(v).toISOString();
const plus = (v: string, ms: number) => new Date(Date.parse(v) + ms).toISOString();
const read = (b: BeliefBrain, params: Record<string, unknown>) => operationsByName.get_page!.handler(b.ctx, params) as Promise<Record<string, any>>;
const versions = (b: BeliefBrain, params: Record<string, unknown>) => operationsByName.get_versions!.handler(b.ctx, params) as Promise<Record<string, any>>;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; reason?: string; retryable?: boolean; message: string }) => e);
const draft = (prose: string) => beliefPage({ prose, facts: ['Acme sells widgets'] });
const doctor = async (b: BeliefBrain): Promise<Check> => (await beliefLedgerEntry.run({ engine: b.engine, tier: 'standard', doFix: false, dryRun: false, orphanRatioSourceId: b.sourceId } as DoctorContext) as Check[])[0]!;
const pageEvents = async (b: BeliefBrain, slug: string) => (await b.events()).filter(e => e.subject_kind === 'page' && e.slug === slug && e.origin !== 'backfill');

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger page-at-time (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, opts: { managed?: boolean; enable?: boolean } = {}) =>
      beliefBrain(run, { managed: opts.managed ?? true, enable: opts.enable, databaseUrl: engineCase.databaseUrl });
    const slug = 'companies/acme-example';

    test('before, at and after creation and each of two edits: each instant reads the body of its interval, never the preimage newest at T', () => brain(async b => {
      const before = await at(b);
      await b.put(slug, draft('First draft.'));
      const t1 = await at(b);
      await b.put(slug, draft('Second draft.'));
      const t2 = await at(b);
      await b.put(slug, draft('Third draft.'));
      const t3 = await at(b);
      const [create, edit1, edit2] = await pageEvents(b, slug);
      expect([create, edit1, edit2].map(e => e!.event_type)).toEqual(['page.published', 'page.published', 'page.published']);
      expect((await refusal(read(b, { slug, known_as_of: before })))?.code).toBe('page_not_found');
      const body = async (t: string) => { const r = await read(b, { slug, known_as_of: t }); return [r.compiled_truth.trim().split('\n')[0], r.body, r.event_id]; };
      expect(await body(t1)).toEqual(['First draft.', 'version', create!.id]);
      expect(await body(t2)).toEqual(['Second draft.', 'version', edit1!.id]);
      expect(await body(t3)).toEqual(['Third draft.', 'live', edit2!.id]);
      // At the instant an edit was recorded, before its commit was observed and with no later event of the page by then, the read is unproven, not answered.
      const atEdit = await refusal(read(b, { slug, known_as_of: iso(edit1!.recorded_at) }));
      expect(atEdit).toMatchObject({ code: 'known_as_of_unproven', retryable: true });
      const t1Read = await read(b, { slug, known_as_of: t1 });
      expect(t1Read).toMatchObject({ slug, deleted: false, until: null, certified: true, uncertified_reason: null, source_id: b.sourceId, known_as_of: t1 });
      const history = await versions(b, { slug, known_as_of: t3, include_body: true, diff: true });
      expect(history.versions.map((v: any) => [v.event_id, v.body, v.until])).toEqual([[edit2!.id, 'live', null], [edit1!.id, 'version', iso(edit2!.recorded_at)], [create!.id, 'version', iso(edit1!.recorded_at)]]);
      expect(history.versions[0].diff).toContain('-Second draft.');
      expect(history.versions[0].diff).toContain('+Third draft.');
      expect(history.versions[2].diff).toContain('+First draft.');
      expect((await versions(b, { slug, known_as_of: t1 })).versions.map((v: any) => [v.event_id, v.until])).toEqual([[create!.id, null]]);
      // The design's premise: the newest preimage at or before T is the wrong side of an edit.
      const [naive] = await b.engine.executeRaw<{ compiled_truth: string }>(`SELECT v.compiled_truth FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE p.source_id = $1 AND p.slug = $2 AND v.snapshot_at <= $3::timestamptz ORDER BY v.id DESC LIMIT 1`, [b.sourceId, slug, t2]);
      expect(naive!.compiled_truth).toContain('First draft.');
      // Forced probe: with the preimages gone, the closed intervals disclose the missing body instead of borrowing the live one.
      await b.engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)', [b.sourceId, slug]);
      expect(await read(b, { slug, known_as_of: t2 })).toMatchObject({ body: 'unavailable', body_reason: 'version_missing' });
      expect((await read(b, { slug, known_as_of: t2 })).compiled_truth).toBeUndefined();
    }), 120_000);

    test('a write straddling T is unproven until its commit mark; a later event of the page proves it; a mark stamped at recorded time would answer it', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      await pause();
      await b.put(slug, draft('Second draft.'));
      const edit = (await pageEvents(b, slug)).at(-1)!;
      await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [edit.publication_id]);
      const stalled = plus(iso(edit.recorded_at), 1);
      await pause();
      const unproven = await refusal(read(b, { slug, known_as_of: stalled }));
      expect(unproven).toMatchObject({ code: 'known_as_of_unproven', retryable: true });
      expect((await read(b, { slug, known_as_of: plus(iso(edit.recorded_at), -1) })).compiled_truth).toContain('First draft.');
      expect(await fillCommitMarks(b.engine, b.sourceId)).toBe(1);
      const marked = await at(b);
      expect((await read(b, { slug, known_as_of: marked })).compiled_truth).toContain('Second draft.');
      expect((await refusal(read(b, { slug, known_as_of: stalled })))?.code).toBe('known_as_of_unproven');
      await b.put(slug, draft('Third draft.'));
      const later = await at(b);
      await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [edit.publication_id]);
      expect((await versions(b, { slug, known_as_of: later })).versions.map((v: any) => v.event_id)).toContain(edit.id);
      // Forced probe: a mark stamped at the event's own recorded time (an observer's early transaction start) answers the straddling instant.
      await b.engine.executeRaw(`INSERT INTO belief_commit_marks (publication_id, observed_at) SELECT publication_id, max(recorded_at) FROM belief_events
        WHERE publication_id = $1::uuid GROUP BY publication_id`, [edit.publication_id]);
      expect((await read(b, { slug, known_as_of: stalled })).compiled_truth).toContain('Second draft.');
    }), 120_000);

    test('a rolled-back write leaves no event and no interval', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      const mark = await b.lastId();
      await b.engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'probe_rollback', origin: 'unmanaged' }, () =>
          tx.executeRaw(`UPDATE pages SET compiled_truth = 'Rolled back.', knowledge_revision = gen_random_uuid() WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]));
        throw new Error('rollback');
      }).catch(() => undefined);
      expect(await b.events(mark)).toEqual([]);
      const t = await at(b);
      expect((await read(b, { slug, known_as_of: t })).compiled_truth).toContain('First draft.');
      expect((await versions(b, { slug, known_as_of: t })).versions).toHaveLength(1);
    }), 120_000);

    test('delete then recreate: a soft delete and put restore the same lifetime; a purge and put mint a new one, and the purged lifetime keeps no body', () => brain(async b => {
      const revision = async () => (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]))[0]!.r;
      await b.put(slug, draft('First draft.'));
      const t1 = await at(b);
      await b.op('delete_page', { slug, expected_revision: await revision() });
      const deleted = await at(b);
      await b.put(slug, draft('Back again.'));
      const t2 = await at(b);
      expect((await refusal(read(b, { slug, known_as_of: deleted })))?.code).toBe('page_not_found');
      expect(await read(b, { slug, known_as_of: deleted, include_deleted: true })).toMatchObject({ deleted: true, event: 'page.deleted', body: 'version' });
      expect((await read(b, { slug, known_as_of: deleted, include_deleted: true })).compiled_truth).toContain('First draft.');
      expect((await read(b, { slug, known_as_of: t1 })).compiled_truth).toContain('First draft.');
      expect((await read(b, { slug, known_as_of: t2 })).compiled_truth).toContain('Back again.');
      expect((await versions(b, { slug, known_as_of: t2 })).versions.map((v: any) => [v.event, v.deleted])).toEqual([['page.restored', false], ['page.deleted', true], ['page.published', false]]);
      expect(new Set((await pageEvents(b, slug)).map(e => e.page_lifetime)).size).toBe(1);
      await b.op('delete_page', { slug, purge: true, expected_revision: await revision() });
      const purged = await at(b);
      await b.put(slug, draft('Recreated.'));
      const t3 = await at(b);
      expect(new Set((await pageEvents(b, slug)).map(e => e.page_lifetime)).size).toBe(2);
      expect((await refusal(read(b, { slug, known_as_of: purged, include_deleted: true })))?.code).toBe('page_not_found');
      expect((await read(b, { slug, known_as_of: t3 })).compiled_truth).toContain('Recreated.');
      const history = await versions(b, { slug, known_as_of: t3, include_body: true });
      expect(history.versions.map((v: any) => [v.event, v.body, v.body_reason ?? null])).toEqual([['page.published', 'live', null], ['page.purged', 'unavailable', 'purged'],
        ['page.restored', 'unavailable', 'purged'], ['page.deleted', 'unavailable', 'purged'], ['page.published', 'unavailable', 'purged']]);
      expect(JSON.stringify(history)).not.toContain('First draft.');
      expect(JSON.stringify(history)).not.toContain('Back again.');
    }), 120_000);

    test('create, forget, materialize, edit: the pre-forget body, the withdrawn view and the materialized body each answer their own instant', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Profile.', facts: ['Acme raised a seed round', 'Acme has ten staff'] }));
      const created = await at(b);
      const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = 'Acme has ten staff' AND expired_at IS NULL`, [b.sourceId]);
      const mark = await b.lastId();
      await operationsByName.forget!.handler(b.ctx, { id: String(fact!.id), request_id: randomUUID() });
      const materialized = await waitForValue(async () => (await b.events(mark)).find(e => e.cause.op === 'withdrawal_materialize'), { timeoutMs: 30_000, label: 'withdrawal materialization' });
      const afterMaterialize = await at(b);
      await b.put(slug, beliefPage({ prose: 'Profile, edited.', facts: ['Acme raised a seed round'] }));
      const edited = await at(b);
      const forget = (await b.events(mark)).find(e => e.cause.op === 'forget' && e.subject_kind === 'page')!;
      expect((await read(b, { slug, known_as_of: created })).compiled_truth).toContain('Acme has ten staff');
      const history = await versions(b, { slug, known_as_of: edited, include_body: true });
      expect(history.versions.map((v: any) => [v.event, v.body])).toEqual([['page.published', 'live'], ['page.view_changed', 'version'], ['page.view_changed', 'version'], ['page.published', 'version']]);
      expect(history.versions.map((v: any) => v.event_id).slice(1, 3)).toEqual([materialized!.id, forget.id]);
      expect(history.versions[3].compiled_truth).toContain('Acme has ten staff');
      expect((await read(b, { slug, known_as_of: afterMaterialize })).event_id).toBe(materialized!.id);
      expect((await read(b, { slug, known_as_of: edited })).compiled_truth).toContain('Profile, edited.');
    }), 180_000);

    test('rename: before the rename the old slug answers and the new one does not; after it, the reverse; one lifetime', () => brain(async b => {
      await b.put('notes/old-example', beliefPage({ type: 'note', title: 'Old', prose: 'Before the move.' }));
      const before = await at(b);
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/old-example', newSlug: 'notes/new-example', to: 'notes/new-example.md' });
      await fillCommitMarks(b.engine, b.sourceId);
      const after = await at(b);
      expect(await read(b, { slug: 'notes/old-example', known_as_of: before })).toMatchObject({ body: 'version', slug: 'notes/old-example' });
      expect((await read(b, { slug: 'notes/old-example', known_as_of: before })).compiled_truth).toContain('Before the move.');
      expect((await refusal(read(b, { slug: 'notes/new-example', known_as_of: before })))?.code).toBe('page_not_found');
      expect((await read(b, { slug: 'notes/new-example', known_as_of: after })).compiled_truth).toContain('Before the move.');
      expect((await refusal(read(b, { slug: 'notes/old-example', known_as_of: after })))?.code).toBe('page_not_found');
      const lifetimes = new Set((await b.events()).filter(e => e.subject_kind === 'page').map(e => e.page_lifetime));
      expect(lifetimes.size).toBe(1);
      const created = (await b.events()).find(e => e.event_type === 'page.published' && e.slug === 'notes/old-example')!;
      const kept = await b.engine.executeRaw<{ knowledge_revision: string; compiled_truth: string }>(`SELECT v.knowledge_revision::text AS knowledge_revision, v.compiled_truth FROM page_versions v
        JOIN pages p ON p.id = v.page_id WHERE p.source_id = $1 AND p.slug = $2 ORDER BY v.id`, [b.sourceId, 'notes/new-example']);
      expect(kept.map(v => v.knowledge_revision)).toEqual([created.value!.revision_after as string]);
      expect(kept[0]!.compiled_truth).toContain('Before the move.');
      // Forced probe: without the rename's preimage (the move advances the revision), the body before the rename is disclosed missing, not borrowed from the live page.
      await b.engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)', [b.sourceId, 'notes/new-example']);
      expect(await read(b, { slug: 'notes/old-example', known_as_of: before })).toMatchObject({ body: 'unavailable', body_reason: 'version_missing' });
    }, { managed: false }), 120_000);

    test('refusals: coverage_from before enable (with and without a backfill), coverage_gap inside a restore gap, clock_mismatch for a date, a future instant', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      const unrecorded = await at(b);
      await b.enable();
      await b.put(slug, draft('Second draft.'));
      const covered = await at(b);
      const from = await refusal(read(b, { slug, known_as_of: unrecorded }));
      expect(from).toMatchObject({ code: 'coverage_from', reason: 'not_recorded' });
      await backfillBeliefHistory(b.engine, b.sourceId, { slugs: [slug] });
      expect(await refusal(read(b, { slug, known_as_of: unrecorded }))).toMatchObject({ code: 'coverage_from' });
      expect(['backfill_only', 'backfill_incomplete']).toContain(String((await refusal(read(b, { slug, known_as_of: unrecorded })))!.reason));
      expect((await read(b, { slug, known_as_of: covered })).compiled_truth).toContain('Second draft.');
      expect(await refusal(read(b, { slug, known_as_of: covered.slice(0, 10) }))).toMatchObject({ code: 'clock_mismatch', reason: 'date_for_instant' });
      expect((await refusal(read(b, { slug, known_as_of: 'yesterday' })))?.code).toBe('invalid_params');
      expect((await refusal(read(b, { slug, known_as_of: plus(covered, 86_400_000) })))?.code).toBe('invalid_params');
      const archivedAt = await at(b);
      const inGap = await at(b);
      await b.engine.transaction(tx => replayPurgesInRestore(tx, { lines: [], archivedAt, restoreId: randomUUID() }));
      await fillCommitMarks(b.engine, b.sourceId);
      expect(await refusal(read(b, { slug, known_as_of: inGap }))).toMatchObject({ code: 'coverage_gap', reason: 'restore' });
      expect((await read(b, { slug, known_as_of: await at(b) })).compiled_truth).toContain('Second draft.');
    }, { enable: false }), 120_000);

    test('an unmanaged source answers with a disclosure, never as certified fact', () => brain(async b => {
      await b.put(slug, draft('First draft.'));
      expect(await read(b, { slug, known_as_of: await at(b) })).toMatchObject({ certified: false, uncertified_reason: 'unmanaged' });
    }, { managed: false }), 120_000);

    test('a purged page reads as one interval with no body: its content changes collapse, and nothing purged comes back to a local or remote caller', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'First draft.', facts: ['Acme sells purple widgets'] }));
      await pause();
      await b.put(slug, beliefPage({ prose: 'Second draft.', facts: ['Acme sells purple widgets', 'Acme opened a Lisbon office'] }));
      const t = await at(b);
      const [create] = await pageEvents(b, slug);
      const revision = (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]))[0]!.r;
      await b.op('delete_page', { slug, purge: true, expected_revision: revision });
      const after = await at(b);
      const purge = (await pageEvents(b, slug)).at(-1)!;
      const remote = { ...b.ctx, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } as typeof b.ctx;
      const shapeOf = (h: Record<string, any>) => h.versions.map((v: any) => [v.event_id, v.event, v.deleted, v.body, v.body_reason, v.until]);
      const history = await versions(b, { slug, known_as_of: after, include_body: true, diff: true });
      expect(shapeOf(history)).toEqual([[purge.id, 'page.purged', true, 'unavailable', 'purged', null], [create!.id, 'page.published', false, 'unavailable', 'purged', iso(purge.recorded_at)]]);
      expect(history.versions.every((v: any) => v.diff === null && v.compiled_truth === undefined && v.title === undefined)).toBe(true);
      const atT = await read(b, { slug, known_as_of: t });
      expect(atT).toMatchObject({ event_id: create!.id, deleted: false, body: 'unavailable', body_reason: 'purged' });
      const leaked = (v: unknown) => ['First draft', 'Second draft', 'purple widgets', 'Lisbon'].filter(s => JSON.stringify(v).includes(s));
      expect(leaked([history, atT])).toEqual([]);
      expect((await refusal(operationsByName.get_page!.handler(remote, { slug, known_as_of: t })))?.code).toBe('page_not_found');
      expect((await refusal(operationsByName.get_versions!.handler(remote, { slug, known_as_of: after, include_body: true, diff: true })))?.code).toBe('page_not_found');
      // Forced probe: a purge that left the revisions in its redacted events would split the purged lifetime into one interval per edit again.
      await b.engine.executeRaw(`UPDATE belief_events SET value = jsonb_build_object('revision_before', NULL, 'revision_after', gen_random_uuid()::text)
        WHERE source_id = $1 AND page_lifetime = $2::uuid AND event_type = 'page.published' AND purged`, [b.sourceId, create!.page_lifetime]);
      expect((await versions(b, { slug, known_as_of: after })).versions).toHaveLength(3);
    }), 120_000);

    test('purge_fact: no historical body or diff returns the purged claim; the surviving claim still reads (control)', () => brain(async b => {
      await b.put(slug, beliefPage({ prose: 'Profile.', facts: ['Acme sells purple widgets', 'Acme opened a Lisbon office'] }));
      await pause();
      await b.put(slug, beliefPage({ prose: 'Profile, edited.', facts: ['Acme sells purple widgets', 'Acme opened a Lisbon office'] }));
      const edited = await at(b);
      const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND fact = 'Acme opened a Lisbon office' AND expired_at IS NULL ORDER BY id LIMIT 1`, [b.sourceId]);
      const purgeOp = operationsByName.purge_fact!;
      const dry = await purgeOp.handler(b.ctx, { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
      await purgeOp.handler(b.ctx, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      const now = await at(b);
      const remote = { ...b.ctx, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } as typeof b.ctx;
      const reads = async (ctx: typeof b.ctx) => [
        await operationsByName.get_page!.handler(ctx, { slug, known_as_of: edited }),
        await operationsByName.get_versions!.handler(ctx, { slug, known_as_of: now, include_body: true, diff: true })];
      for (const ctx of [b.ctx, remote]) {
        const out = JSON.stringify(await reads(ctx));
        expect(out).not.toContain('Lisbon');
        expect(out).toContain('purple widgets');
      }
      // Forced probe: a version the purge failed to redact returns the claim through the historical read.
      await b.engine.executeRaw(`UPDATE page_versions SET compiled_truth = compiled_truth || ' Acme opened a Lisbon office.'
        WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)`, [b.sourceId, slug]);
      expect(JSON.stringify(await reads(remote))).toContain('Lisbon');
    }), 180_000);

    test('remote callers: a private page never answers; a page made private hides every interval; one made public shows only what was recorded while world', () => brain(async b => {
      const remote = { ...b.ctx, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } as typeof b.ctx;
      const rread = (params: Record<string, unknown>) => operationsByName.get_page!.handler(remote, params) as Promise<Record<string, any>>;
      const rversions = (params: Record<string, unknown>) => operationsByName.get_versions!.handler(remote, params) as Promise<Record<string, any>>;
      const priv = (prose: string) => beliefPage({ prose, frontmatter: { visibility: 'private' } });
      await b.put('companies/secret-example', priv('Secret plans.'));
      await b.put('companies/public-example', draft('Public profile.'));
      await b.put('companies/closing-example', draft('Open at first.'));
      await b.put('companies/opening-example', priv('Private at first.'));
      const t1 = await at(b);
      await b.put('companies/closing-example', priv('Now private.'));
      await b.put('companies/opening-example', draft('Now public.'));
      const t2 = await at(b);
      expect((await rread({ slug: 'companies/public-example', known_as_of: t1 })).compiled_truth).toContain('Public profile.');
      expect((await refusal(rread({ slug: 'companies/secret-example', known_as_of: t2 })))?.code).toBe('page_not_found');
      expect((await refusal(rread({ slug: 'companies/closing-example', known_as_of: t1 })))?.code).toBe('page_not_found');
      expect((await refusal(rversions({ slug: 'companies/closing-example', known_as_of: t2, include_body: true })))?.code).toBe('page_not_found');
      expect((await refusal(rread({ slug: 'companies/opening-example', known_as_of: t1 })))?.code).toBe('page_not_found');
      expect((await rread({ slug: 'companies/opening-example', known_as_of: t2 })).compiled_truth).toContain('Now public.');
      const opened = await rversions({ slug: 'companies/opening-example', known_as_of: t2, include_body: true, diff: true });
      expect(opened.versions).toHaveLength(1);
      expect(JSON.stringify(opened)).not.toContain('Private at first.');
      expect((await read(b, { slug: 'companies/closing-example', known_as_of: t1 })).compiled_truth).toContain('Open at first.');
      // Forced probe: an event recorded while private, relabelled world, would surface the private body to the remote caller.
      await b.engine.executeRaw(`UPDATE belief_events SET visibility = 'world' WHERE source_id = $1 AND slug = 'companies/opening-example'`, [b.sourceId]);
      expect(JSON.stringify(await rversions({ slug: 'companies/opening-example', known_as_of: t2, include_body: true }))).toContain('Private at first.');
    }), 120_000);

    test('remote callers over several sources: a private page and a never-written slug refuse the same way (no existence oracle through source choice or coverage)', () => brain(async b => {
      const other = `${b.sourceId}-two`;
      await b.engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [other]);
      await enableBeliefLedger(b.engine, other);
      await b.put('companies/hidden-example', beliefPage({ prose: 'Hidden plans.', frontmatter: { visibility: 'private' } }));
      await b.put('companies/shown-example', draft('Shown profile.'));
      const t = await at(b);
      const remote = { ...b.ctx, remote: true, transport: 'http', takesHoldersAllowList: ['world'], sourceId: b.sourceId,
        auth: { token: '', clientId: 'probe', scopes: ['read'], sourceId: b.sourceId, allowedSources: [b.sourceId, other] } } as unknown as typeof b.ctx;
      const outcome = (op: string, slug: string) => operationsByName[op]!.handler(remote, { slug, known_as_of: t, ...(op === 'get_versions' ? { include_body: true, diff: true } : {}) })
        .then(r => ({ ok: true, body: JSON.stringify(r) }), (e: { code?: string; message: string }) => ({ ok: false, code: e.code, message: e.message.replace(slug, '<slug>') }));
      for (const op of ['get_page', 'get_versions']) {
        const hidden = await outcome(op, 'companies/hidden-example');
        expect(hidden).toEqual(await outcome(op, 'companies/never-written-example'));
        expect(hidden).toMatchObject({ ok: false, code: 'page_not_found' });
        expect(await outcome(op, 'companies/shown-example')).toMatchObject({ ok: true });
      }
    }, { managed: false }), 120_000);

    test('the preimage invariant: a publication that moves a page off a revision with no version of it is refused in tests and reported by doctor', () => brain(async b => {
      await b.put('notes/move-example', beliefPage({ type: 'note', title: 'Move', prose: 'Before the move.' }));
      const rawRename = (from: string, to: string) => b.engine.transaction(async tx => {
        await tx.lockPageKeys([from, to].map(s => ({ sourceId: b.sourceId, slug: s })));
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [from, to], op: 'probe_rename' }, () =>
          tx.executeRaw('UPDATE pages SET slug = $1 WHERE source_id = $2 AND slug = $3', [to, b.sourceId, from]));
      });
      const before = await b.lastId();
      // Forced probe: a rename that skips its preimage is refused in the batch, and nothing commits.
      const refused = await rawRename('notes/move-example', 'notes/moved-example').then(() => null, (e: Error) => e.message);
      expect(refused).toContain('belief preimage invariant: notes/move-example moved off revision');
      expect(await b.lastId()).toBe(before);
      expect((await b.engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, 'notes/move-example'])).length).toBe(1);
      // The production rename versions first and passes.
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/move-example', newSlug: 'notes/moved-example', to: 'notes/moved-example.md' });
      expect(await preimageGaps(b.engine, b.sourceId)).toEqual([]);
      expect((await doctor(b)).status).toBe('ok');
      // With the test-only check off, the same skipped preimage commits, and doctor names it.
      await withEnv({ GBRAIN_BELIEF_PREIMAGE_CHECK: '0' }, () => rawRename('notes/moved-example', 'notes/moved-again-example'));
      await fillCommitMarks(b.engine, b.sourceId);
      const moved = (await b.events(before)).filter(e => e.subject_kind === 'page' && e.slug === 'notes/moved-again-example' && e.value?.revision_before).at(-1)!;
      const gaps = await preimageGaps(b.engine, b.sourceId);
      expect(gaps.map(g => [g.slug, g.event_id, g.revision])).toEqual([['notes/moved-again-example', moved.id, String(moved.value!.revision_before)]]);
      const check = await doctor(b);
      expect(check.status).toBe('warn');
      expect(check.message).toContain(`${b.sourceId}: 1 page transition(s) left no version of the revision they moved off (e.g. notes/moved-again-example at event ${moved.id})`);
      expect(await read(b, { slug: 'notes/moved-example', known_as_of: await at(b) }).catch(() => null)).toBeNull();
    }, { managed: false }), 120_000);
  });
}
