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
 *    A held row (GST-2979: a private restatement whose visibility proposal names the copy it restates) is admitted by
 *    the grant only when the caller's reads admit every copy its proposals name, a copy that is itself held counting
 *    only when its own copies pass too (the hold chain).
 *  - Regression: the Rust arm compared the widened SQL with the bare list, found them different and refused every one of
 *    these reads for a member caller and a granted caller (store-members/facts.ts visibilityFilter). Then the Rust grant
 *    admission (widen.rs) ignored the hold, so a granted caller's fact list returned a private restatement whose copy
 *    the grant cannot read.
 *  - Why existing coverage misses it: the fact list cases read as the no-caller record, whose list is never widened.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { ALICE_PAGE, CALLERS, ENTITY, fixture, SESSION } from './fact-widening-fixture.ts';

const { parityTest } = parityArms(testBackends());

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

  parityTest(
    'a granted world-only list leaves out a held restatement whose proposal names a copy the caller cannot read, along the hold chain',
    { methods: ['putPage', 'insertFacts', 'insertTrustProposal', 'listFactsSince', 'listFactsKeyset'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const idOf = async (fact: string) => {
        const rows = await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), { activeOnly: true, limit: 100 });
        return Number(rows.find(r => r.fact === fact)!.id);
      };
      const held = ['held unreadable restatement', 'held readable restatement', 'held member restatement', 'held chain restatement', 'held chain copy'];
      await engine.insertFacts(held.map((fact, i) => ({
        fact, entity_slug: ENTITY, source_markdown_slug: 'notes/open', visibility: 'private', source: 'fence', kind: 'fact',
        source_session: SESSION, row_num: 101 + i, valid_from: new Date(Date.UTC(2026, 7, 1 + i)),
      })) as never, { source_id: 'default' });
      const hold = async (restatement: string, copy: string) => engine.insertTrustProposal({
        action: 'supersede_fact', sourceId: 'default', target: { table: 'facts', id: await idOf(copy) },
        related: { table: 'facts', id: await idOf(restatement) }, before: { visibility: 'world' }, after: { visibility: 'private' },
        proposer: 'remember.replaces',
      });
      // The copy sits on a private page, so no grant reads it.
      await hold('held unreadable restatement', 'private holding fact');
      // The copy is a granted fact on an open page.
      await hold('held readable restatement', 'granted fact');
      // The copy sits on alice's own member page: only a caller that is alice reads it.
      await hold('held member restatement', 'own member fact');
      // The copy is itself held by a copy no grant reads, so the chain refuses both.
      await hold('held chain restatement', 'held chain copy');
      await hold('held chain copy', 'private holding fact');
      const world = { activeOnly: true, limit: 50, visibility: ['world' as const] };
      const out: Record<string, { since: string[]; keyset: string[] }> = {};
      for (const [name, caller] of Object.entries(CALLERS)) {
        out[name] = await withCallerAccess(caller, async () => ({
          since: sorted((await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), world)).map(r => r.fact)),
          keyset: sorted((await engine.listFactsKeyset('default', null, world)).map(r => r.fact)),
        }));
        expect(out[name]!.keyset).toEqual(out[name]!.since);
      }
      expect(out.plain!.since).toEqual(['world fact']);
      expect(out.alice!.since).toEqual(['own member fact', 'world fact']);
      expect(out.granted!.since).toEqual(['granted fact', 'held readable restatement', 'world fact']);
      expect(out.aliceGranted!.since).toEqual(['granted fact', 'held member restatement', 'held readable restatement', 'own member fact', 'world fact']);
      expect(out.grantedOther!.since).toEqual(['world fact']);
      return out;
    },
  );
});
