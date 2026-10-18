/**
 * Belief ledger write-overhead probes (docs/designs/BELIEF_LEDGER.md section 9):
 * a fence projection leaves rows that already hold their values unwritten, and
 * the batch's post-read reuses the pre-read for every table the transaction did
 * not write (its pg_stat_xact counter is unchanged). Each probe runs on PGLite
 * and on Postgres when DATABASE_URL is set; the forced probe suppresses the
 * touched signal and shows the drift check catches the event it loses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FINGERPRINT_CACHE_MAX, __fingerprintCacheForTests, __suppressBeliefTouchedSignalForTests, readBeliefState, type RawState } from '../src/core/belief/state.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { keyedSubjects } from '../src/core/belief/subjects.ts';
import { beliefLedgerEntry } from '../src/commands/doctor/checks/belief-ledger.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => { __suppressBeliefTouchedSignalForTests(false); });

const SLUG = 'companies/acme-example';
const page = (o: Parameters<typeof beliefPage>[0] = {}) => beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme is in Austin'],
  takes: ['Acme will win its market', 'Acme will hire fast'], links: ['people/alice-example'], ...o });

/** Every fact and take row of the page with its row version (xmin moves on any rewrite, identical values included). */
async function rowVersions(b: BeliefBrain): Promise<string[]> {
  const rows = await b.engine.executeRaw<{ r: string }>(`SELECT 'fact:' || f.id || ':' || f.xmin::text AS r FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2
    UNION ALL SELECT 'take:' || k.id || ':' || k.xmin::text FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = $1 AND p.slug = $2
    ORDER BY 1`, [b.sourceId, SLUG]);
  return rows.map(r => r.r);
}

async function doctor(b: BeliefBrain): Promise<Check> {
  const [check] = await beliefLedgerEntry.run({ engine: b.engine, tier: 'standard', doFix: false, dryRun: false, orphanRatioSourceId: b.sourceId } as DoctorContext) as Check[];
  return check!;
}

/** Claims that stress the fingerprint's normalization: case, Unicode, punctuation, dots and every kind of whitespace. */
const EDGE_PIECES = ['Acme', 'ACME', 'acme', 'İstanbul', 'ß', 'Straße', 'é', 'e\u0301', 'naïve', '日本語', '😀', '\u00a0', '\u2003', '\t', '\n', '  ', ' ',
  '.', '...', '…', '. .', 'U.S.', 'v2.0', ',', '!', '"', "'", '‘’', '“”', '«»', '–', '—', '·', '•', '¡', '¿', '(x)', '[y]', '{z}', '|', '\\', '/', '$5', '%', '&', '@', '#1', '_', '~', '^'];
function edgeClaims(count: number): string[] {
  let seed = 0x5eed;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = ['Acme raised a seed round', ' acme raised a seed round. ', 'ACME  RAISED\tA SEED\nROUND...', 'Acme raised a seed round…', '\u00a0Acme\u2003raised a seed round'];
  while (out.length < count) out.push(Array.from({ length: 2 + Math.floor(next() * 8) }, () => EDGE_PIECES[Math.floor(next() * EDGE_PIECES.length)]).join(next() < 0.5 ? ' ' : ''));
  return [...new Set(out.filter(c => c.trim().length))];
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger write overhead (${engineCase.name})`, () => {
    test('the fingerprint cache returns exactly gbrain_fact_fingerprint for edge-case claims (forced probe: a poisoned entry is caught)', async () => {
      await beliefBrain(async b => {
        await b.put(SLUG, beliefPage({ prose: 'Edge cases.' }));
        const [{ id: pageId }] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, SLUG]);
        const claims = edgeClaims(160);
        await b.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence)
          SELECT $1, $2, c, 'fact', 'probe', 'world', 1 FROM unnest($3::text[]) AS c`, [b.sourceId, SLUG, claims]);
        await b.engine.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight)
          SELECT $1, n::int, c, 'take', 'brain', 0.5 FROM unnest($2::text[]) WITH ORDINALITY AS t(c, n)`, [pageId, claims.slice(0, 60)]);
        const truth = new Map((await b.engine.executeRaw<{ fact: string; fp: string; th: string }>(`SELECT c AS fact, gbrain_fact_fingerprint(c) AS fp,
            encode(sha256(convert_to(c, 'UTF8')), 'hex') AS th FROM unnest($1::text[]) AS c`, [claims])).map(r => [r.fact, r]));
        for (const claim of claims) expect(truth.get(claim)!.th).toBe(createHash('sha256').update(claim, 'utf8').digest('hex'));
        const mismatches = (state: RawState) => [...state.facts.map(f => [f.fact, f.fp] as const), ...state.takes.map(k => [k.claim, k.claim_fp] as const)]
          .filter(([text, fp]) => truth.get(text)!.fp !== fp).map(([text]) => text);
        const cache = __fingerprintCacheForTests();
        cache.fingerprints.clear(); cache.streams.clear();
        const cold = await readBeliefState(b.engine, b.sourceId, [SLUG]);
        expect(cold.facts).toHaveLength(claims.length);
        expect(cold.takes).toHaveLength(60);
        expect(mismatches(cold)).toEqual([]);
        for (const claim of claims) expect(cache.fingerprints.get(truth.get(claim)!.th)).toBe(truth.get(claim)!.fp);
        const warm = await readBeliefState(b.engine, b.sourceId, [SLUG]);
        expect(mismatches(warm)).toEqual([]);
        const victim = claims[1]!;
        cache.fingerprints.set(truth.get(victim)!.th, 'poisoned');
        expect(mismatches(await readBeliefState(b.engine, b.sourceId, [SLUG]))).toEqual([victim, ...(claims.slice(0, 60).includes(victim) ? [victim] : [])]);
        cache.fingerprints.clear(); cache.streams.clear();
      }, { managed: false, enable: false, databaseUrl: engineCase.databaseUrl });
    }, 120_000);

    test('the fingerprint cache stays within its bounds and holds no claim text', async () => {
      const cache = __fingerprintCacheForTests();
      await beliefBrain(async b => {
        await b.put(SLUG, beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff'], takes: ['Acme will win its market'] }));
        await readBeliefState(b.engine, b.sourceId, [SLUG]);
        const texts = ['Acme raised a seed round', 'Acme has ten staff', 'Acme will win its market'];
        for (const [key, value] of cache.fingerprints) expect([key, value].some(v => texts.some(t => v.includes(t)))).toBe(false);
        for (const [key, hashes] of cache.streams) expect([key, ...hashes].some(v => texts.some(t => v.includes(t.toLowerCase()) || v.includes(t)))).toBe(false);
      }, { managed: false, enable: false, databaseUrl: engineCase.databaseUrl });
      for (let i = 0; i < FINGERPRINT_CACHE_MAX + 50; i++) cache.fingerprints.set(`h${i}`, 'f');
      await beliefBrain(async b => {
        await b.put(SLUG, beliefPage({ facts: ['Acme raised a seed round'] }));
        await readBeliefState(b.engine, b.sourceId, [SLUG]);
        expect(cache.fingerprints.size).toBe(FINGERPRINT_CACHE_MAX);
        expect(cache.fingerprints.has('h0')).toBe(false);
      }, { managed: false, enable: false, databaseUrl: engineCase.databaseUrl });
      cache.fingerprints.clear(); cache.streams.clear();
    }, 120_000);

    const brain = (run: (b: BeliefBrain) => Promise<void>, managed = true) => beliefBrain(run, { managed, databaseUrl: engineCase.databaseUrl });
    const seeded = async (b: BeliefBrain) => {
      await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
      await b.put(SLUG, page());
    };

    test('a prose-only edit rewrites no fact or take row and records no belief event', async () => {
      await brain(async b => {
        await seeded(b);
        const versions = await rowVersions(b);
        expect(versions).toHaveLength(5);
        const before = await b.lastId();
        await b.put(SLUG, page({ prose: 'Rewritten prose only.' }));
        expect(shape(await b.events(before))).toEqual(['page:page.published']);
        expect(await rowVersions(b)).toEqual(versions);
      });
    }, 120_000);

    test('a one-value change among identical rows rewrites that row alone and is recorded', async () => {
      await brain(async b => {
        await seeded(b);
        const versions = await rowVersions(b);
        const before = await b.lastId();
        await b.put(SLUG, page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme is in Austin'] }));
        const events = await b.events(before);
        expect(shape(events)).toEqual(['page:page.published', 'fact:fact.revised']);
        expect(events[1]!.value).toMatchObject({ confidence: 0.5 });
        const changed = (await rowVersions(b)).filter(v => !versions.includes(v));
        expect(changed).toHaveLength(1);
        expect(changed[0]!.startsWith('fact:')).toBe(true);
        const mark = await b.lastId();
        await b.put(SLUG, page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme is in Austin'],
          takes: [{ claim: 'Acme will win its market', weight: '0.9' }, 'Acme will hire fast'] }));
        expect(shape(await b.events(mark))).toEqual(['page:page.published', 'take:take.revised']);
      });
    }, 120_000);

    test('forced probe: with the touched signal suppressed the change goes unrecorded and the drift check names the slug', async () => {
      await brain(async b => {
        await seeded(b);
        expect((await doctor(b)).status).toBe('ok');
        const before = await b.lastId();
        __suppressBeliefTouchedSignalForTests(true);
        await b.put(SLUG, page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme is in Austin'] }));
        __suppressBeliefTouchedSignalForTests(false);
        expect(shape(await b.events(before))).toEqual(['page:page.published']);
        const drifted = await doctor(b);
        expect(drifted.status).toBe('warn');
        expect(drifted.message).toContain(`${b.sourceId}: 1 drifted slug(s) (e.g. ${SLUG})`);
      });
    }, 120_000);

    test('a batch reads state under generic plans and leaves its projections and the rest of the transaction on the mode it found', async () => {
      await brain(async b => {
        await seeded(b);
        const modes = await b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: SLUG }]);
          await tx.executeRaw("SET LOCAL plan_cache_mode = 'force_custom_plan'");
          const mode = async () => (await tx.executeRaw<{ m: string }>("SELECT current_setting('plan_cache_mode') AS m"))[0]!.m;
          const inside = await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [SLUG], op: 'probe_plan_mode' }, mode);
          return [inside, await mode()];
        });
        expect(modes).toEqual(['force_custom_plan', 'force_custom_plan']);
        await expect(b.engine.transaction(async tx => {
          await tx.executeRaw("SET LOCAL plan_cache_mode = 'force_custom_plan'");
          try { await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [SLUG], op: 'probe_unheld' }, async () => null); } catch {}
          return (await tx.executeRaw<{ m: string }>("SELECT current_setting('plan_cache_mode') AS m"))[0]!.m;
        })).resolves.toBe('force_custom_plan');
      });
    }, 120_000);

    test('with track_counts off the post-read reads every table again', async () => {
      await brain(async b => {
        await seeded(b);
        await b.engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL track_counts = off');
          const pre = await readBeliefState(tx, b.sourceId, [SLUG]);
          await tx.executeRaw(`UPDATE facts SET confidence = 0.25 WHERE source_id = $1 AND source_markdown_slug = $2 AND fact = 'Acme is in Austin'`, [b.sourceId, SLUG]);
          const post = await readBeliefState(tx, b.sourceId, [SLUG], pre.pages.map(p => p.id), pre);
          expect(post.facts.find(f => f.fact === 'Acme is in Austin')!.confidence).toBe(0.25);
          await tx.executeRaw('SET LOCAL track_counts = on');
          const counted = await readBeliefState(tx, b.sourceId, [SLUG]);
          await tx.executeRaw(`UPDATE facts SET confidence = 0.75 WHERE source_id = $1 AND source_markdown_slug = $2 AND fact = 'Acme is in Austin'`, [b.sourceId, SLUG]);
          const recounted = await readBeliefState(tx, b.sourceId, [SLUG], counted.pages.map(p => p.id), counted);
          expect(recounted.facts.find(f => f.fact === 'Acme is in Austin')!.confidence).toBe(0.75);
          expect(recounted.takes).toBe(counted.takes);
          throw new Error('rollback');
        }).catch(e => { if ((e as Error).message !== 'rollback') throw e; });
      }, false);
    }, 120_000);
  });
}

test('reused take subjects take their visibility from the side they are keyed for', () => {
  const page = { id: 7, slug: SLUG, deleted: false, revision: '1', content_hash: null, tier: 'unknown', visible: true, large: false, incarnation: 'i' };
  const take = { id: 70, page_id: 7, row_num: 1, claim: 'Acme will win', claim_fp: 'fp', kind: 'take', holder: 'brain', weight: 0.5, since_date: null,
    until_date: null, source: null, active: true, resolved_at: null, resolved_outcome: null, resolved_value: null, resolved_unit: null, resolved_source: null,
    resolved_by: null, resolved_quality: null, tier: 'unknown' };
  const pre: RawState = { pages: [page], facts: [], takes: [take], links: [], transitions: [], writerTier: null };
  const post: RawState = { ...pre, pages: [{ ...page, visible: false }] };
  const ctx = (state: RawState) => ({ incarnation: 'i', lifetimes: new Map([[7, '00000000-0000-0000-0000-000000000007']]), pagesBySlug: new Map(state.pages.map(p => [p.slug, p])) });
  const visibility = (state: RawState) => (id: number) => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world';
  const before = keyedSubjects(ctx(pre), pre, visibility(pre));
  const after = keyedSubjects(ctx(post), post, visibility(post), { state: pre, subjects: before });
  expect(before.map(s => s.visibility)).toEqual(['world']);
  expect(after.map(s => [s.key, s.visibility])).toEqual([[before[0]!.key, 'private']]);
});
