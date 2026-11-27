/**
 * BrainEngine parity: the fence census reads and writes of engine-sql/fence-census.ts, which `gbrain doctor`'s
 * `fence_integrity` check and the fence census ran through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), seeded through the engine's own writers.
 *  - Regression: an engine that answers none of these makes `fence_integrity` report "could not run" instead of
 *    its verdict; one whose candidate parts drift reports other counts per backend.
 *  - Why existing coverage misses it: test/fence-census.test.ts runs the census on PGLite only and never compares arms.
 *  - Seam: none. Typed methods only (no executeRaw).
 *  - Out of the comparison, by design: the pass horizon and `updated_at` are the engine's own timestamp text
 *    (`2026-11-19 17:23:15.1+00` on Postgres, ISO on Rust); each is checked against the other timestamps of its own arm.
 *    Candidate fingerprints are ordered by the database's collation on Postgres and by bytes on Rust, so the test names
 *    them with lower-case letters, where the two orders agree.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { FileFinding, PageFinding } from '../../src/core/fence-repair/census-store.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const put = (engine: BrainEngine, slug: string, compiled_truth: string, extra: Record<string, unknown> = {}) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth, timeline: '', ...extra } as never);
/** An engine's timestamp text as epoch milliseconds: Postgres `2026-11-19 17:23:15.1+00`, or ISO. */
const epoch = (text: string): number => Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T').replace(/\+00$/, 'Z')}`);

const pageFinding = (page_id: number, tier: PageFinding['tier'] = 'deterministic'): PageFinding => ({
  tier, reasons: ['missing_close'], location: { fence: 'facts', section: 'compiled_truth', rows: [1], columns: [], line: null }, sha256: 'a'.repeat(64),
  page_id, updated_at: '2026-11-19T00:00:00.000Z', content_hash: null, source_path: null,
} as unknown as PageFinding);
const fileFinding = (path: string): FileFinding => ({
  tier: 'resolver', reasons: ['bad_row'], location: { fence: 'takes', section: 'timeline', rows: [], columns: [], line: 3 }, sha256: 'b'.repeat(64), path, mtime_ms: 1000,
} as unknown as FileFinding);

describe('fence census reads and writes', () => {
  parityTest(
    'the census lists its sources and scans a source\'s pages by id and by update time, with fence bodies only for live pages that carry a marker',
    { methods: ['putPage', 'softDeletePage', 'listFenceCensusSources', 'readFencePassHorizon', 'listFenceCensusPagesById', 'listFenceCensusPagesUpdated', 'listLiveFencePageIds'] },
    async (engine) => {
      const before = Date.now();
      await put(engine, 'notes/plain', 'plain body');
      await tick();
      await put(engine, 'notes/facts', '## Facts\n<!--- gbrain:facts:begin -->\n| # | claim |\n<!--- gbrain:facts:end -->\n');
      await tick();
      await put(engine, 'notes/takes', 'x', { timeline: '<!--- gbrain:takes:begin -->' });
      await put(engine, 'notes/gone', '<!--- gbrain:facts:begin -->');
      await engine.softDeletePage('notes/gone');

      const sources = await engine.listFenceCensusSources(null);
      const filtered = await engine.listFenceCensusSources(['default']);
      const none = await engine.listFenceCensusSources(['nope']);
      expect(sources.map((s) => s.id)).toEqual(['default']);
      expect(sources[0]!.incarnation).toMatch(/^[0-9a-f-]{36}$/);
      expect(filtered).toEqual(sources);
      expect(none).toEqual([]);

      const shape = (rows: Awaited<ReturnType<BrainEngine['listFenceCensusPagesById']>>) =>
        rows.map((r) => ({ slug: r.slug, type: r.type, live: r.live, source_path: r.source_path, frontmatter: r.frontmatter, compiled: r.compiled_truth, timeline: r.timeline }));
      const byId = await engine.listFenceCensusPagesById('default', 0, 10);
      const firstTwo = await engine.listFenceCensusPagesById('default', 0, 2);
      const afterTwo = await engine.listFenceCensusPagesById('default', Number(firstTwo[1]!.id), 10);
      const otherSource = await engine.listFenceCensusPagesById('other', 0, 10);
      const lower = byId[1]!.updated_at;
      const updated = await engine.listFenceCensusPagesUpdated('default', lower, null, 10);
      // Postgres binds the cursor's time through a JS Date, which keeps milliseconds only, so a cursor row whose time has
      // microseconds can come back once more (a pre-existing behavior of this read, harmless to the census, which judges a
      // page twice the same). The comparison leaves the cursor's own row out.
      const cursorId = Number(updated[0]!.id);
      const next = (await engine.listFenceCensusPagesUpdated('default', lower, { at: updated[0]!.updated_at, id: cursorId }, 10)).filter((r) => Number(r.id) !== cursorId);
      const limited = await engine.listFenceCensusPagesUpdated('default', lower, null, 1);
      for (const row of byId) expect(Math.abs(epoch(row.updated_at) - before)).toBeLessThan(60_000);
      const ids = byId.map((r) => Number(r.id));
      const live = await engine.listLiveFencePageIds([...ids, 999_999].reverse());
      const noIds = await engine.listLiveFencePageIds([]);
      const horizon = await engine.readFencePassHorizon(60_000);
      expect(Math.abs(Date.now() - 60_000 - epoch(horizon))).toBeLessThan(60_000);

      const out = {
        sources: sources.map((s) => ({ ...s, incarnation: '<incarnation>' })), none, byId: shape(byId), firstTwo: shape(firstTwo), afterTwo: shape(afterTwo), otherSource,
        updated: shape(updated), next: shape(next), limited: shape(limited), live: [...live].map(Number).sort((a, b) => a - b).map((id) => ids.indexOf(id)), noIds,
      };
      expect(out.byId.map((r) => r.slug)).toEqual(['notes/plain', 'notes/facts', 'notes/takes', 'notes/gone']);
      expect(out.byId.map((r) => r.live)).toEqual([true, true, true, false]);
      expect(out.byId.map((r) => r.compiled !== null)).toEqual([false, true, true, false]);
      expect(out.updated.map((r) => r.slug)).toEqual(['notes/facts', 'notes/takes', 'notes/gone']);
      expect(out.next.map((r) => r.slug)).toEqual(['notes/takes', 'notes/gone']);
      expect(out.live).toEqual([0, 1, 2]);
      return out;
    },
  );

  parityTest(
    'scan records round-trip, and a candidate keeps its other part until both parts are cleared',
    { methods: ['listFenceCensusSources', 'writeFenceScanRecord', 'readFenceScanRecord', 'upsertFenceCandidatePart', 'clearFenceCandidateParts', 'listFenceCandidateRecords'] },
    async (engine) => {
      const [source] = await engine.listFenceCensusSources(null);
      const ids = (key: string) => ({ sourceId: source!.id, incarnation: source!.incarnation, key });
      const fingerprint = (key: string) => `${source!.id}:${source!.incarnation}:${key}`;
      const op = 'fence-candidate';

      const absent = await engine.readFenceScanRecord('fence-scan', 'one');
      const record = { version: 1 as const, source_id: source!.id, incarnation: source!.incarnation, rules: '1.1', pages: { done: true }, files: null,
        census: { complete: true, fresh_at: null, checked_at: '2026-11-19T00:00:00.000Z' } };
      await engine.writeFenceScanRecord('fence-scan', 'one', record as never);
      await engine.writeFenceScanRecord('fence-scan', 'one', { ...record, rules: '1.2' } as never);
      const stored = await engine.readFenceScanRecord('fence-scan', 'one');

      await engine.upsertFenceCandidatePart(op, fingerprint('a.md'), ids('a.md'), 'file', fileFinding('a.md'));
      await engine.upsertFenceCandidatePart(op, fingerprint('a.md'), ids('a.md'), 'page', pageFinding(7));
      await engine.upsertFenceCandidatePart(op, fingerprint('b.md'), ids('b.md'), 'file', fileFinding('b.md'));
      await engine.upsertFenceCandidatePart(op, fingerprint('c.md'), ids('c.md'), 'page', pageFinding(8, 'llm'));
      await engine.upsertFenceCandidatePart(op, fingerprint('b.md'), ids('b.md'), 'file', fileFinding('b2.md'));
      const listed = await engine.listFenceCandidateRecords(op);
      const scoped = await engine.listFenceCandidateRecords(op, [source!.id]);
      const other = await engine.listFenceCandidateRecords(op, ['nope']);

      // Clearing a part a candidate lacks leaves it; clearing the page part of `a` keeps its file part.
      await engine.clearFenceCandidateParts(op, [fingerprint('a.md'), fingerprint('b.md'), fingerprint('missing.md')], 'page');
      const afterPage = await engine.listFenceCandidateRecords(op);
      await engine.clearFenceCandidateParts(op, [fingerprint('a.md'), fingerprint('b.md'), fingerprint('c.md')], 'file');
      const afterFile = await engine.listFenceCandidateRecords(op);
      await engine.clearFenceCandidateParts(op, [], 'page');

      expect(absent).toBeNull();
      expect(stored).toEqual({ ...record, rules: '1.2' } as never);
      expect(listed.map((r) => r.key)).toEqual(['a.md', 'b.md', 'c.md']);
      expect(listed[0]).toMatchObject({ version: 1, source_id: source!.id, key: 'a.md', page: { page_id: 7 }, file: { path: 'a.md' } });
      expect(scoped).toEqual(listed);
      expect(other).toEqual([]);
      expect(afterPage.map((r) => [r.key, 'page' in r, 'file' in r])).toEqual([['a.md', false, true], ['b.md', false, true], ['c.md', true, false]].map(([k, p, f]) => [k, p, f]));
      expect(afterFile.map((r) => r.key)).toEqual(['c.md']);
      // The incarnation is a fresh uuid per brain.
      const masked = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(source!.incarnation, '<incarnation>'));
      return masked({ absent, stored, listed, scoped, other, afterPage, afterFile });
    },
  );

  parityTest(
    'a candidate of a source incarnation that no longer exists is not listed',
    { methods: ['listFenceCensusSources', 'upsertFenceCandidatePart', 'listFenceCandidateRecords'] },
    async (engine) => {
      const [source] = await engine.listFenceCensusSources(null);
      const stale = { sourceId: source!.id, incarnation: '00000000-0000-4000-8000-000000000000', key: 'old.md' };
      await engine.upsertFenceCandidatePart('fence-candidate', `${source!.id}:${stale.incarnation}:old.md`, stale, 'file', fileFinding('old.md'));
      const listed = await engine.listFenceCandidateRecords('fence-candidate');
      expect(listed).toEqual([]);
      return listed;
    },
  );

  parityTest(
    'segmented pages count when they have no path or their checkout was not walked',
    { methods: ['putPage', 'createSegmentedPageShell', 'countSegmentedFencePages'] },
    async (engine) => {
      const empty = await engine.countSegmentedFencePages(['default'], []);
      await engine.createSegmentedPageShell('notes/seg-a', { type: 'note', title: 'a' } as never, { sourceId: 'default' });
      await engine.createSegmentedPageShell('notes/seg-b', { type: 'note', title: 'b' } as never, { sourceId: 'default' });
      await put(engine, 'notes/whole', 'a whole body');
      const unwalked = await engine.countSegmentedFencePages(['default'], []);
      const walked = await engine.countSegmentedFencePages(['default'], ['default']);
      const elsewhere = await engine.countSegmentedFencePages(['other'], []);
      expect({ empty, unwalked, walked, elsewhere }).toEqual({ empty: 0, unwalked: 2, walked: 2, elsewhere: 0 });
      return { empty, unwalked, walked, elsewhere };
    },
  );

  parityTest(
    'the fence trend and budget ledger reads answer nothing on a brain that never wrote them',
    { methods: ['readFenceTrendRecords', 'readBudgetLedgerDay'] },
    async (engine) => {
      const trend = await engine.readFenceTrendRecords('fence-trend', ['default'], '2026-01-01');
      const ledger = await engine.readBudgetLedgerDay('fence_repair', 'fence-repair', '2026-11-19');
      expect({ trend, ledger }).toEqual({ trend: [], ledger: null });
      return { trend, ledger };
    },
  );
});
