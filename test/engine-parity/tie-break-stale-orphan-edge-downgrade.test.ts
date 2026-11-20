/**
 * BrainEngine parity — four reads cut by a LIMIT keep the same rows on every engine when their sort key ties.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1,
 *    where the identity-downgrade record, the stale-mention scan and the orphan lifetime sample answer from typed members and
 *    the edge-contradiction cut runs raw SQL and stops on raw_sql) a tie is broken by a unique key after the existing sort keys:
 *    the orphan lifetime sample (orphanLifetimes) by the lifetime id, the stale-mention scan (scanStaleMentions) by the
 *    lowest page id, the edge-contradiction subject cut (runPhaseEdgeContradictions, max_subjects) by the lowest subject
 *    page id, and the identity-downgrade record of a renamed file (recordIdentityDowngrades) by the lowest page id.
 *  - Regression: each statement cut by LIMIT sorted on a key that rows share (an event slug, a page slug that two sources
 *    both hold, one refreshed_at stamped by a single refresh, one source_path two soft-deleted pages carry), so the rows
 *    that survived the cut were whichever the sort met first, and Postgres and PGLite could keep different ones.
 *  - Why existing coverage misses it: the cases give every row its own slug, timestamp or path, so no limit ever cut a tie.
 *  - Seam: pages and mention links go through the engine writers. Typed insertBeliefEvents writes belief events that name a
 *    missing lifetime (the open lifetime of the deleted page comes from the test-only seed seedBeliefPageLifetimes, which
 *    needs the same test-seeds addon), harness-only SQL inserts the relationship rows with one refreshed_at (the put_page operation cannot run on the Rust
 *    arm), and gives soft-deleted pages one source_path and one deleted_at (no typed write sets them; the Rust arm uses the
 *    test-only seed seedPageOrigin, which needs an addon built with GBRAIN_RUST_TEST_SEEDS=1). The identity-downgrade record,
 *    the stale-mention scan and the orphan sample read through typed members, so the Rust arm answers them (the scan's heap
 *    rewrite is skipped there, as the Rust store keeps pages by id); the edge-contradiction cut runs raw SQL, so the Rust arm
 *    stops on raw_sql.
 */
import { describe, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { orphanLifetimes } from '../../src/core/belief/coverage-report.ts';
import { scanStaleMentions } from '../../src/core/by-mention.ts';
import { runPhaseEdgeContradictions, type EdgeJudgeFn } from '../../src/core/cycle/edge-contradictions.ts';
import { recordIdentityDowngrades } from '../../src/core/sync-identity-downgrades.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventRow } from '../../src/core/engine-sql/collate-belief-writes.ts';
import { createSource, parityArms, seedBeliefLifetimes, seedPageOrigin } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra }) as never;

/** Keys whose insert order is neither byte order nor reverse byte order. */
const KEYS = ['m', 'c', 'x', 'a', 'q', 'f'];

/** Rewrites each row once, highest id first, so a heap scan meets the rows in reverse id order. */
async function rewriteNewestFirst(engine: BrainEngine, table: 'pages', column: string): Promise<void> {
  const ids = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM ${table} ORDER BY id DESC`);
  for (const { id } of ids) await engine.executeRaw(`UPDATE ${table} SET ${column} = ${column} WHERE id = $1`, [Number(id)]);
}

describe('orphan lifetime sample', () => {
  parityTest('orphanLifetimes cuts rows of one slug by the lifetime id', { methods: ['putPage', 'deletePages', 'readLedgerSource', 'insertBeliefEvents', 'listOrphanLifetimes'], testSeeds: true }, async (engine, backend) => {
    const { incarnation } = (await engine.readLedgerSource('default'))!;
    const lifetime = (key: string) => `00000000-0000-4000-8000-0000000000${key.charCodeAt(0).toString(16)}`;
    // Five events name five lifetimes that do not exist, and one open lifetime has no page. All six rows carry one slug, so
    // only the lifetime id can order them; the open lifetime's id is minted at random and sorts after the events' ids.
    await engine.insertBeliefEvents(KEYS.map((key): BeliefEventRow => ({
      event_key: createHash('md5').update(`orphan-${key}`).digest('hex'), source_id: 'default', source_incarnation: incarnation, page_lifetime: lifetime(key),
      slug: 'tie/orphan', subject_kind: 'page', subject_key: '["page"]', event_type: 'page.baseline', origin: 'live', trust_tier: 'unknown', writer_tier: null,
      tier_basis: 'unknown', visibility: 'world', publication_id: randomUUID(), ord: 0, source_time: null, valid_from: null, valid_until: null, value: null,
      value_hash: null, prior_hash: null, state_hash: '', cause: '{}', claim_fp: null, purged: false, redacted_fields: null,
    })));
    await engine.putPage('tie/orphan', note('tie orphan'));
    await seedBeliefLifetimes(engine, backend, 'default', ['tie/orphan']);
    await engine.deletePages(['tie/orphan'], { sourceId: 'default' });
    const orphans = await orphanLifetimes(engine, 'default', 3, { deep: true });
    expect(orphans.count).toBe(KEYS.length + 1);
    const sampled = orphans.samples.map(s => [s.page_lifetime, s.reason]);
    expect(sampled).toEqual([...KEYS].sort().slice(0, 3).map(key => [lifetime(key), 'no_lifetime']));
    return sampled;
  });
});

describe('stale-mention scan', () => {
  parityTest('scanStaleMentions cuts pages that two sources share by slug at the lowest page id', { methods: ['putPage', 'addLinksBatch'] }, async (engine, backend) => {
    // Six sources each hold `dup/page`, which mentions a target of its own source and never names it, so the link is stale.
    for (const id of KEYS) await createSource(engine, backend, `src-${id}`);
    for (const id of KEYS) {
      await engine.putPage('dup/page', note('dup page'), { sourceId: `src-${id}` });
      await engine.putPage(`target-${id}`, note(`target ${id}`), { sourceId: `src-${id}` });
      await engine.addLinksBatch([{ from_slug: 'dup/page', to_slug: `target-${id}`, link_type: 'mentions', context: '', link_source: 'mentions',
        from_source_id: `src-${id}`, to_source_id: `src-${id}` }]);
    }
    // A rewrite per page, newest first, leaves the heap in reverse id order, so a tie that only the sort met first picks the newest pages.
    // BrainEngine has no such write; the Rust store keeps pages by id, so its arm has no heap order to disturb and does nothing.
    if (backend !== 'rust') await rewriteNewestFirst(engine, 'pages', 'updated_at');
    const scan = await scanStaleMentions(engine, { limit: 3 });
    expect(scan.totalPagesWithMentions).toBe(6);
    expect(scan.pagesScanned).toBe(3);
    // The first three sources written own the lowest page ids, and the examples list them in that order.
    const examples = scan.examples.map(e => [e.from, e.to]);
    expect(examples).toEqual(KEYS.slice(0, 3).map(id => ['dup/page', `target-${id}`]));
    return examples;
  });
});

describe('edge contradiction subjects', () => {
  parityTest('runPhaseEdgeContradictions cuts subjects that share one refreshed_at at the lowest page id', { methods: ['putPage', 'setConfig', 'executeRaw'], requires: 'raw_sql' }, async (engine, backend) => {
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    await engine.setConfig('dream.edge_contradictions.max_subjects', '2');
    // The first three people live in `src-b` and the last three in `src-a`, so the group key (source, page, type) sorts the
    // later pages first; each source has its own two companies, and every person works at both.
    const sourceOf = (key: string) => (KEYS.indexOf(key) < 3 ? 'src-b' : 'src-a');
    for (const id of ['src-a', 'src-b']) {
      await createSource(engine, backend, id);
      for (const slug of ['companies/acme-example', 'companies/widget-co']) await engine.putPage(slug, note(slug, { type: 'company' }), { sourceId: id });
    }
    for (const key of KEYS) await engine.putPage(`people/${key}-example`, note(key, { type: 'person' }), { sourceId: sourceOf(key) });
    // The relationship rows the extractor would derive, all with one refresh stamp, so only the page id can order the subjects.
    await engine.executeRaw(`INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantics, valid_ranges, status_now, evidence_hash, refreshed_at)
      SELECT f.id, t.id, 'works_at', 'all', f.source_id, 'state', datemultirange(daterange('2019-02-01', NULL)), 'live', md5(f.slug || t.slug), '2026-01-01T00:00:00Z'::timestamptz
        FROM pages f JOIN pages t ON t.source_id = f.source_id AND t.slug LIKE 'companies/%' WHERE f.slug LIKE 'people/%'`);
    const subjects = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM pages WHERE slug LIKE 'people/%' ORDER BY id DESC`);
    for (const { id } of subjects) await engine.executeRaw(`UPDATE link_relationships SET refreshed_at = refreshed_at WHERE from_page_id = $1`, [Number(id)]);
    const judged: string[] = [];
    const judge: EdgeJudgeFn = async ({ subject }) => { judged.push(subject.slug); return []; };
    const result = await runPhaseEdgeContradictions(engine, { judge });
    expect(result.totals).toMatchObject({ subjects: 2, judged: 2 });
    expect(judged).toEqual(KEYS.slice(0, 2).map(key => `people/${key}-example`));
    return judged;
  });
});

describe('identity downgrade record', () => {
  parityTest('recordIdentityDowngrades names the lowest page id when soft-deleted pages share one source_path and deleted_at', { methods: ['putPage', 'getPage', 'readSoftDeletedPageAtOrigin', 'listLivePagesAtOrigin', 'countPageCarryRows', 'writeOpCheckpointValues'], testSeeds: true }, async (engine, backend) => {
    // The pages table allows one live-or-deleted page per (source_id, slug) but not one per source_path: six pages that an
    // old file once backed are soft-deleted in one sync, so they carry one path and one deleted_at.
    const slugs = KEYS.map(key => `notes/${key}`);
    const ids: number[] = [];
    for (const slug of slugs) {
      await engine.putPage(slug, note(slug));
      ids.push((await engine.getPage(slug))!.id);
    }
    for (const slug of [...slugs].reverse()) await seedPageOrigin(engine, backend, 'default', slug, 'notes/old.md', '2026-01-01T00:00:00Z');
    const [record] = await recordIdentityDowngrades(engine, 'default', [{ from: 'notes/old.md', to: 'notes/new.md', similarity: 0.4, reason: 'no_identity_signal' }]);
    expect(record.old_page_id).toBe(ids[0]);
    expect(record.old_slug).toBe(slugs[0]);
    return { old_slug: record.old_slug };
  });
});
