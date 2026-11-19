/**
 * BrainEngine parity — a fact list read's visibility list, widened per row for a member caller and a private-facts
 * grant.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a visibility list without 'private' (factVisibilitySql, access/member-facts.ts) also admits a private fact
 *    held on the caller's own member page while that page names the member as a reader and the caller may read it
 *    (memberFactAdmitSql), and a private fact in a source the caller's private-facts grant names whose holding,
 *    provenance and entity pages are none of member, private, missing or quarantined and that has a page to check
 *    (grantedPrivateFactSql). listFactsByEntity, listFactsSince, listFactsKeyset and listFactsBySession agree with each
 *    other, with and without `excludePrivate`, and no caller sees a fact held on another member's page, a fact whose
 *    provenance page is private, or a fact its grant does not reach.
 *  - Regression: the Rust arm compared the widened SQL with the bare list, found them different and refused every one of
 *    these reads for a member caller and a granted caller (store-members/facts.ts visibilityFilter).
 *  - Why existing coverage misses it: the fact list cases read as the no-caller record, whose list is never widened.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { MEMBER_PAGE_PREFIX } from '../../src/core/access/principals.ts';

const { parityTest } = parityArms(testBackends());

const ENTITY = 'people/a-example';
const SESSION = 'session-widening';
const ALICE_PAGE = `${MEMBER_PAGE_PREFIX}alice-example`;
const BOB_PAGE = `${MEMBER_PAGE_PREFIX}bob-example`;

const page = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note', title, compiled_truth: title, timeline: '', frontmatter });

/** Member pages that name their member, open and private pages, and one fact for each rule of the widened list. */
async function fixture(engine: BrainEngine) {
  await engine.putPage(ENTITY, { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
  await engine.putPage('people/b-example', { type: 'person', title: 'B', compiled_truth: 'B', timeline: '', frontmatter: { visibility: 'private' } });
  await engine.putPage('notes/open', page('Open'));
  await engine.putPage('notes/private', page('Private', { visibility: 'private' }));
  await engine.putPage('notes/readers', page('Readers', { readable_by: ['member:alice-example'] }));
  await engine.putPage('notes/quarantined', page('Quarantined', { quarantine: { reason: 'test' } }));
  await engine.putPage(ALICE_PAGE, page('alice-example', { readable_by: ['member:alice-example'] }));
  await engine.putPage(BOB_PAGE, page('bob-example', { readable_by: ['member:bob-example'] }));
  await engine.putPage('notes/open', page('Open other'), { sourceId: 'other' });
  const rows: Array<Record<string, unknown>> = [
    { fact: 'world fact', source_markdown_slug: 'notes/open', visibility: 'world' },
    { fact: 'own member fact', source_markdown_slug: ALICE_PAGE },
    { fact: 'other member fact', source_markdown_slug: BOB_PAGE },
    { fact: 'granted fact', source_markdown_slug: 'notes/open' },
    { fact: 'private holding fact', source_markdown_slug: 'notes/private' },
    { fact: 'readers holding fact', source_markdown_slug: 'notes/readers' },
    { fact: 'quarantined holding fact', source_markdown_slug: 'notes/quarantined' },
    { fact: 'missing holding fact', source_markdown_slug: 'notes/gone' },
    { fact: 'unpaged fact', source_markdown_slug: null },
    { fact: 'transcript fact', source_markdown_slug: 'notes/open', source: 'transcript:chat' },
    { fact: 'private provenance fact', source_markdown_slug: 'notes/open', source: 'mcp:put_page', context: 'notes/private.md extracted' },
    { fact: 'member provenance fact', source_markdown_slug: 'notes/open', source: 'mcp:put_page', context: `${ALICE_PAGE} saved` },
    { fact: 'private entity fact', source_markdown_slug: 'notes/open', entity_slug: 'people/b-example' },
  ];
  await engine.insertFacts(rows.map((r, i) => ({
    entity_slug: ENTITY, visibility: 'private', source: 'fence', ...r, row_num: i + 1, kind: 'fact', source_session: SESSION,
    valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
  })) as never, { source_id: 'default' });
  await engine.insertFacts([{
    fact: 'other source fact', entity_slug: ENTITY, source_markdown_slug: 'notes/open', visibility: 'private', source: 'fence',
    row_num: 1, kind: 'fact', source_session: SESSION, valid_from: new Date(Date.UTC(2026, 5, 1)),
  }] as never, { source_id: 'other' });
}

/** Restricted callers (a page names readers): plain, the member, a grant on `default`, a grant on `other`, and both. */
const CALLERS = {
  plain: { identity: [], hidePrivate: true },
  alice: { identity: ['member:alice-example'], hidePrivate: true },
  granted: { identity: [], privateFactSources: ['default'], hidePrivate: true },
  grantedOther: { identity: [], privateFactSources: ['other'], hidePrivate: true },
  aliceGranted: { identity: ['member:alice-example'], privateFactSources: ['default'], hidePrivate: true },
} as const;

type Reads = Record<string, string[]>;

async function readAll(engine: BrainEngine, sourceId: string, shape: Record<string, unknown>): Promise<Reads> {
  return {
    byEntity: sorted((await engine.listFactsByEntity(sourceId, ENTITY, shape)).map(r => r.fact)),
    since: sorted((await engine.listFactsSince(sourceId, new Date(Date.UTC(2000, 0, 1)), shape)).map(r => r.fact)),
    keyset: sorted((await engine.listFactsKeyset(sourceId, null, shape)).map(r => r.fact)),
    bySession: sorted((await engine.listFactsBySession(sourceId, SESSION, shape)).map(r => r.fact)),
  };
}

/** The facts each read shows, by caller; the four reads must agree (byEntity reads ENTITY only). */
async function byCaller(engine: BrainEngine, sourceId: string, shape: Record<string, unknown>) {
  const out: Record<string, Reads> = {};
  for (const [name, caller] of Object.entries(CALLERS)) out[name] = await withCallerAccess(caller, () => readAll(engine, sourceId, shape));
  for (const reads of Object.values(out)) {
    for (const read of ['keyset', 'bySession']) expect(reads[read]).toEqual(reads.since!);
    expect(reads.byEntity).toEqual(reads.since!.filter(f => f !== 'private entity fact'));
  }
  return out;
}

describe('engine parity: a fact list read widens its visibility list for a member and a private-facts grant', () => {
  parityTest(
    'a world-only list admits the member\'s own member-page facts and the granted facts whose pages are open, and nothing else',
    { methods: ['putPage', 'insertFacts', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const world = { activeOnly: true, limit: 50, visibility: ['world' as const] };
      const out = await byCaller(engine, 'default', world);
      const since = (name: keyof typeof CALLERS) => out[name]!.since!;
      expect(since('plain')).toEqual(['world fact']);
      expect(since('alice')).toEqual(['own member fact', 'world fact']);
      expect(since('granted')).toEqual(['granted fact', 'world fact']);
      expect(since('grantedOther')).toEqual(['world fact']);
      expect(since('aliceGranted')).toEqual(['granted fact', 'own member fact', 'world fact']);
      const other = await byCaller(engine, 'other', world);
      expect(other.grantedOther!.since).toEqual(['other source fact']);
      expect(other.granted!.since).toEqual([]);
      return { out, other };
    },
  );

  parityTest(
    'with excludePrivate the widened list still never shows a fact the provenance gate hides',
    { methods: ['putPage', 'insertFacts', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const hotMemory = { activeOnly: true, limit: 30, visibility: ['world' as const], fingerprint: true, excludePrivate: true };
      const out = await byCaller(engine, 'default', hotMemory);
      for (const reads of Object.values(out)) {
        for (const hidden of ['other member fact', 'private holding fact', 'private provenance fact', 'readers holding fact', 'private entity fact']) {
          expect(reads.since).not.toContain(hidden);
        }
      }
      expect(out.alice!.since).toContain('own member fact');
      expect(out.granted!.since).toContain('granted fact');
      expect(out.plain!.since).toEqual(['world fact']);
      return out;
    },
  );

  parityTest(
    'a list that names private is not widened: every caller reads the same private facts the provenance gate allows',
    { methods: ['putPage', 'insertFacts', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const both = { activeOnly: true, limit: 50, visibility: ['world' as const, 'private' as const], excludePrivate: true };
      return byCaller(engine, 'default', both);
    },
  );

  parityTest(
    'listSupersessions widens a world-only list the same way',
    { methods: ['putPage', 'insertFacts', 'listSupersessions'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const pair = (slug: string, n: number) => [
        { fact: `${slug} old`, superseded_by_row: n + 1 },
        { fact: `${slug} new` },
      ].map((r, i) => ({ entity_slug: ENTITY, source_markdown_slug: slug, visibility: 'private', source: 'fence', kind: 'fact',
        source_session: SESSION, row_num: n + i, valid_from: new Date(Date.UTC(2026, 6, 1 + i)), ...r }));
      await engine.insertFacts([...pair('notes/open', 40), ...pair(ALICE_PAGE, 50), ...pair('notes/private', 60)] as never, { source_id: 'default' });
      const out: Record<string, string[]> = {};
      for (const [name, caller] of Object.entries(CALLERS)) {
        out[name] = await withCallerAccess(caller, async () =>
          sorted((await engine.listSupersessions('default', { limit: 50, visibility: ['world'] })).map(r => r.fact)));
      }
      expect(out.plain).toEqual([]);
      expect(out.alice).toEqual([`${ALICE_PAGE} old`]);
      expect(out.granted).toEqual(['notes/open old']);
      expect(out.aliceGranted).toEqual([`${ALICE_PAGE} old`, 'notes/open old']);
      return out;
    },
  );
});
