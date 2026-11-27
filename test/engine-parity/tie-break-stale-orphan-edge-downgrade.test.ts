/**
 * BrainEngine parity — four reads cut by a LIMIT keep the same rows on every engine when their sort key ties.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a tie is broken by a unique key after the existing sort keys:
 *    the orphan lifetime sample (orphanLifetimes) by the lifetime id, the stale-mention scan (scanStaleMentions) by the
 *    lowest page id, the edge-contradiction subject cut (runPhaseEdgeContradictions, max_subjects) by the lowest subject
 *    page id, and the identity-downgrade record of a renamed file (recordIdentityDowngrades) by the lowest page id.
 *  - Regression: each statement cut by LIMIT sorted on a key that rows share (an event slug, a page slug that two sources
 *    both hold, one refreshed_at stamped by a single refresh, one source_path two soft-deleted pages carry), so the rows
 *    that survived the cut were whichever the sort met first, and Postgres and PGLite could keep different ones.
 *  - Why existing coverage misses it: the cases give every row its own slug, timestamp or path, so no limit ever cut a tie.
 *  - Seam: none. Pages, mention links, the works_at assertions of the edge case (one batch, so the relationship rows share
 *    one refresh stamp), the orphan case's belief events and lifetime and the identity case's soft-deleted pages (written
 *    and deleted in one transaction, so they share one deleted_at) all go through typed engine members. The only SQL is the
 *    heap rewrite of two cases, a physical-layout step that runs on the SQL arms and does nothing on the Rust arm.
 */
import { createHash } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { orphanLifetimes } from '../../src/core/belief/coverage-report.ts';
import { scanStaleMentions } from '../../src/core/by-mention.ts';
import { runPhaseEdgeContradictions, type EdgeJudgeFn } from '../../src/core/cycle/edge-contradictions.ts';
import { recordIdentityDowngrades } from '../../src/core/sync-identity-downgrades.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra }) as never;

/** Keys whose insert order is neither byte order nor reverse byte order. */
const KEYS = ['m', 'c', 'x', 'a', 'q', 'f'];
const ORPHAN_PUBLICATION = '00000000-0000-4000-8000-0000000000d1';

/**
 * Rewrites each row once, highest id first, so a heap scan meets the rows in reverse id order. Physical layout only, so it
 * runs on the SQL arms; the Rust store keeps no heap and has nothing to rewrite.
 */
async function rewriteNewestFirst(engine: BrainEngine, backend: ParityBackend, table: 'pages', column: string): Promise<void> {
  if (backend === 'rust') return;
  const ids = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM ${table} ORDER BY id DESC`);
  for (const { id } of ids) await engine.executeRaw(`UPDATE ${table} SET ${column} = ${column} WHERE id = $1`, [Number(id)]);
}

/**
 * Fixture: rewrites each person's relationship rows once, highest page id first, so a heap scan meets them in reverse id order.
 * Physical layout only, so it runs on the SQL arms; the Rust store keeps no heap and has nothing to rewrite.
 */
async function rewriteNewestFirstRelationships(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  if (backend === 'rust') return;
  const subjects = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM pages WHERE slug LIKE 'people/%' ORDER BY id DESC`);
  for (const { id } of subjects) await engine.executeRaw(`UPDATE link_relationships SET refreshed_at = refreshed_at WHERE from_page_id = $1`, [Number(id)]);
}

describe('orphan lifetime sample', () => {
  parityTest('orphanLifetimes cuts rows of one slug by the lifetime id', { methods: ['readLedgerSource', 'insertBeliefEvents', 'mintBeliefLifetime', 'listOrphanLifetimes'] }, async (engine) => {
    const { incarnation } = (await engine.readLedgerSource('default'))!;
    const lifetime = (key: string) => `00000000-0000-4000-8000-0000000000${key.charCodeAt(0).toString(16)}`;
    // Five events name five lifetimes that do not exist, and one open lifetime has no page. All six rows carry one slug, so
    // only the lifetime id can order them; the open lifetime has the highest id, so it belongs after the events.
    await engine.insertBeliefEvents(KEYS.map((key, ord) => ({
      event_key: createHash('md5').update(`orphan-${key}`).digest('hex'), source_id: 'default', source_incarnation: incarnation, page_lifetime: lifetime(key),
      slug: 'tie/orphan', subject_kind: 'page', subject_key: 'page', event_type: 'page.baseline', origin: 'live', trust_tier: 'unknown', writer_tier: null,
      tier_basis: 'unknown', visibility: 'world', publication_id: ORPHAN_PUBLICATION, ord, source_time: null, valid_from: null, valid_until: null,
      value: null, value_hash: null, prior_hash: null, state_hash: '', cause: '{}', claim_fp: null, purged: false, redacted_fields: null,
    })));
    await engine.mintBeliefLifetime({ lifetime: lifetime('z'), sourceId: 'default', incarnation, slug: 'tie/orphan', pageId: 1 });
    const orphans = await orphanLifetimes(engine, 'default', 3, { deep: true });
    expect(orphans.count).toBe(KEYS.length + 1);
    const sampled = orphans.samples.map(s => [s.page_lifetime, s.reason]);
    expect(sampled).toEqual([...KEYS].sort().slice(0, 3).map(key => [lifetime(key), 'no_lifetime']));
    return sampled;
  });
});

describe('stale-mention scan', () => {
  parityTest('scanStaleMentions cuts pages that two sources share by slug at the lowest page id', { methods: ['putPage', 'addLinksBatch', 'readStaleMentionScan'] }, async (engine, backend) => {
    // Six sources each hold `dup/page`, which mentions a target of its own source and never names it, so the link is stale.
    for (const id of KEYS) await createSource(engine, backend, `src-${id}`);
    for (const id of KEYS) {
      await engine.putPage('dup/page', note('dup page'), { sourceId: `src-${id}` });
      await engine.putPage(`target-${id}`, note(`target ${id}`), { sourceId: `src-${id}` });
      await engine.addLinksBatch([{ from_slug: 'dup/page', to_slug: `target-${id}`, link_type: 'mentions', context: '', link_source: 'mentions',
        from_source_id: `src-${id}`, to_source_id: `src-${id}` }]);
    }
    // A rewrite per page, newest first, leaves the heap in reverse id order, so a tie that only the sort met first picks the newest pages.
    await rewriteNewestFirst(engine, backend, 'pages', 'updated_at');
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
  parityTest('runPhaseEdgeContradictions cuts subjects that share one refreshed_at at the lowest page id', { methods: ['putPage', 'setConfig', 'addLinksBatch'] }, async (engine, backend) => {
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
    // The works_at assertions the extractor would write, in one batch, so their relationship rows take one refresh stamp
    // and only the page id can order the subjects.
    await engine.addLinksBatch(KEYS.flatMap(key => ['companies/acme-example', 'companies/widget-co'].map(company => ({
      from_slug: `people/${key}-example`, to_slug: company, link_type: 'works_at', context: '', link_source: 'markdown', origin_slug: `people/${key}-example`,
      from_source_id: sourceOf(key), to_source_id: sourceOf(key), origin_source_id: sourceOf(key),
    }))));
    // A rewrite per subject, newest page first, leaves the heap in reverse id order, so a tie that only the sort met first picks the newest pages.
    await rewriteNewestFirstRelationships(engine, backend);
    const judged: string[] = [];
    const judge: EdgeJudgeFn = async ({ subject }) => { judged.push(subject.slug); return []; };
    const result = await runPhaseEdgeContradictions(engine, { judge });
    expect(result.totals).toMatchObject({ subjects: 2, judged: 2 });
    expect(judged).toEqual(KEYS.slice(0, 2).map(key => `people/${key}-example`));
    return judged;
  });
});

describe('identity downgrade record', () => {
  parityTest('recordIdentityDowngrades names the lowest page id when soft-deleted pages share one source_path and deleted_at', {
    methods: ['putPage', 'softDeletePage', 'transaction', 'readIdentityDowngradeOldPage', 'readRenameIdentityRows', 'countIdentityDowngradeCarry', 'writeOpCheckpointRecord'],
  }, async (engine) => {
    // The pages table allows one live-or-deleted page per (source_id, slug) but not one per source_path: six pages that an
    // old file once backed are soft-deleted in one sync, so they carry one path and one deleted_at.
    const slugs = KEYS.map(key => `notes/${key}`);
    // A live page's origin is unique, so each page is deleted before the next records the path; one transaction gives them
    // one deleted_at.
    const ids: number[] = [];
    await engine.transaction(async tx => {
      for (const slug of slugs) {
        ids.push((await tx.putPage(slug, note(slug, { source_path: 'notes/old.md' }))).id);
        await tx.softDeletePage(slug, { sourceId: 'default' });
      }
    });
    const [record] = await recordIdentityDowngrades(engine, 'default', [{ from: 'notes/old.md', to: 'notes/new.md', similarity: 0.4, reason: 'no_identity_signal' }]);
    expect(record.old_page_id).toBe(Math.min(...ids));
    expect(record.old_slug).toBe(slugs[0]);
    return { old_slug: record.old_slug };
  });
});
