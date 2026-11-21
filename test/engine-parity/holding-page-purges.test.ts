/**
 * BrainEngine parity: `insertHoldingPagePurges`, the tombstones a fact purge stores under the holding pages of the facts
 * it removes (GST-2492; engine-sql/facts-purge.ts, called by facts/purge.ts inside the purge transaction).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for the listed fact ids that are in the named source, sit on a holding page (`memory/unattributed` or a
 *    slug ending in `/memory/unattributed`) and name an entity, one tombstone is stored per holding page under the
 *    purged fingerprint and visibility, none twice (the first row keeps its request, actor and reason). Facts of an
 *    ordinary page, facts with no entity, ids that name no fact and facts of another source store nothing. The claim
 *    checks then answer purged under the holding page and nothing else, and the source reports purges possible.
 *  - Regression: the Rust engine refused the member, so on a Rust brain the purge transaction stopped before it stored
 *    anything and a holding page could take a purged claim back; a Rust member that stored the tombstone for the wrong
 *    facts (an ordinary page's, or another source's) would hide claims a purge never named.
 *  - Why existing coverage misses it: fact-purge-sites.test.ts reads the tombstones back with a raw SELECT, which the
 *    Rust arm refuses, so that case stops on the raw read and never compares the member. This file reads them with the
 *    typed claim checks (`isFactPurged`, `readFenceOverlayRows`, `readLedgerSource`) only.
 *  - Seam: none. Real engines, typed methods only; the purge fingerprints come from `loadPurgeTarget`, the purge's own
 *    read, so no engine's hash function is assumed.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const HOLDING = 'memory/unattributed';
const NESTED = 'members/ann/memory/unattributed';
const ORDINARY = 'notes/ordinary';
const REQ = 'b0000000-0000-4000-8000-0000000000c1';
const REQ2 = 'b0000000-0000-4000-8000-0000000000c2';
const page = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} page`, timeline: '' });

const rows = new WeakMap<BrainEngine, number>();
/** One fence fact; every arm numbers its rows alike. Returns its id. */
async function fenced(engine: BrainEngine, text: string, slug: string, entity: string | null, source = SRC): Promise<number> {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  const res = await engine.insertFacts([{ fact: text, entity_slug: entity, kind: 'fact', visibility: 'private', source: 'fence', row_num: n,
    source_markdown_slug: slug }] as never, { source_id: source });
  return Number(res.ids[0]);
}

const hashOf = async (engine: BrainEngine, id: number, source = SRC) => (await engine.loadPurgeTarget(id, source))!.fact_hash;

describe('engine parity: the holding page purge tombstones', () => {
  parityTest('a purge stores one tombstone per holding page of the facts about an entity with no page, none twice', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'transaction', 'insertHoldingPagePurges', 'isFactPurged', 'readFenceOverlayRows', 'readLedgerSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    for (const slug of [HOLDING, NESTED, ORDINARY]) await engine.putPage(slug, page(slug));
    await engine.putPage(HOLDING, page('other holding'), { sourceId: 'other' } as never);
    const claim = 'Acme raised a seed round';
    const tea = 'Acme serves tea';
    const alice = await fenced(engine, claim, HOLDING, 'acme');
    const nested = await fenced(engine, claim, NESTED, 'acme');
    const ordinary = await fenced(engine, claim, ORDINARY, 'acme');
    const bare = await fenced(engine, claim, HOLDING, null);
    const sibling = await fenced(engine, tea, HOLDING, 'acme');
    const elsewhere = await fenced(engine, claim, HOLDING, 'acme', 'other');
    const hash = await hashOf(engine, alice);
    const teaHash = await hashOf(engine, sibling);
    const before = (await engine.readLedgerSource(SRC))?.purgesPossible;
    const stored = await engine.transaction(async tx => {
      await tx.insertHoldingPagePurges(SRC, 'private', hash, REQ, 'local_cli:me', 'because', [alice, alice, nested, ordinary, bare, elsewhere, 999999]);
      // The same key again, with another request and actor, changes nothing; so does a list that names nothing eligible.
      await tx.insertHoldingPagePurges(SRC, 'private', hash, REQ2, 'local_cli:you', null, [alice]);
      await tx.insertHoldingPagePurges(SRC, 'private', teaHash, REQ, 'local_cli:me', null, []);
      await tx.insertHoldingPagePurges(SRC, 'private', teaHash, REQ, 'local_cli:me', null, [ordinary]);
      return 'stored';
    });
    const answers: Record<string, boolean> = {};
    for (const [label, text] of [['claim', claim], ['tea', tea]] as const) {
      for (const visibility of ['private', 'world'] as const) {
        for (const subject of [HOLDING, NESTED, ORDINARY, 'acme', null]) {
          answers[`${label}/${visibility}/${subject}`] = await engine.isFactPurged(SRC, visibility, text, subject);
        }
      }
    }
    const incoming = [{ row_num: 1, claim, visibility: 'private', fp: null }, { row_num: 2, claim: tea, visibility: 'private', fp: null }];
    const overlay: Record<string, unknown> = {};
    for (const slug of [HOLDING, NESTED, ORDINARY]) {
      overlay[slug] = (await engine.readFenceOverlayRows({ sourceId: SRC, slug }, incoming, { hideHeld: false })).map(r => [r.row_num, r.purged]);
    }
    const after = (await engine.readLedgerSource(SRC))?.purgesPossible;
    const otherSource = (await engine.readLedgerSource('other'))?.purgesPossible;
    const out = { before, stored, after, otherSource, answers, overlay };
    expect(out.before).toBe(false);
    expect(out.after).toBe(true);
    expect(out.otherSource).toBe(false);
    const purged = Object.entries(answers).filter(([, v]) => v).map(([k]) => k);
    expect(purged).toEqual([`claim/private/${HOLDING}`, `claim/private/${NESTED}`]);
    return out;
  });

  parityTest('a purge that names no eligible fact stores nothing and leaves the source with no purges', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'transaction', 'insertHoldingPagePurges', 'readLedgerSource'],
  }, async (engine) => {
    await engine.putPage(ORDINARY, page('ordinary'));
    const own = await fenced(engine, 'Beta hired a CTO', ORDINARY, 'beta');
    const hash = await hashOf(engine, own);
    await engine.transaction(async tx => {
      await tx.insertHoldingPagePurges(SRC, 'world', hash, REQ, 'local_cli:me', 'none', [own]);
      await tx.insertHoldingPagePurges(SRC, 'world', hash, REQ, 'local_cli:me', null, []);
    });
    const out = { purgesPossible: (await engine.readLedgerSource(SRC))?.purgesPossible };
    expect(out).toEqual({ purgesPossible: false });
    return out;
  });
});
