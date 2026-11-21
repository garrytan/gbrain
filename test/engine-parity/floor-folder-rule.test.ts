/**
 * BrainEngine parity — the remote provenance floor of the forget reads for a caller record whose `restricted` flag is
 * false (the short member-access form) over a provenance page that sits under a folder rule.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the short form is `page_readers IS NULL AND folder_rule_ids IS NULL`, so a fact whose provenance page
 *    (source_markdown_slug) is stamped by a folder rule fails the floor for a `restricted: false` caller, whether the
 *    rule covers derived pages or is raw-only. The full form (`restricted: true`) judges the provenance page as an
 *    origin and so spares a raw-only rule's pages. hasHiddenFactCopy, readLinkedFactCopies and readFactWithdrawalClaim
 *    answer the same on every arm under both forms.
 *  - Regression: the Rust store's unrestricted branch tested `readable_by` only, so a provenance page under a folder
 *    rule passed the floor on Rust while PGLite and Postgres hid it.
 *  - Why existing coverage misses it: forget-reach-reads.test.ts runs its `restricted: false` reads on a brain with no
 *    folder rule.
 *  - Seam: none. A `restricted: false` record over a brain that holds a folder rule is the state a stale flag read
 *    leaves (the brain's access.restrictions_present flag is set once a rule is applied, so a fresh request would build
 *    `restricted: true`); the record is built by hand to reach it. Rows come from typed members.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { FolderRule } from '../../src/core/access/folder-rules.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'work';
const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: 'x', timeline: '' });
const RULES: FolderRule[] = [
  { id: 'diary', prefix: 'private/', readable_by: ['member:alice-example'] },
  { id: 'raw', prefix: 'raw/', readable_by: ['member:alice-example'], covers_derived: false },
];

async function insert(engine: BrainEngine, row: { fact: string; entity: string | null; page: string }, n: number): Promise<number> {
  const out = await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    return tx.insertFacts([{ fact: row.fact, entity_slug: row.entity, source_markdown_slug: row.page, row_num: n, kind: 'fact',
      visibility: 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1)) }] as never, { source_id: SRC });
  });
  return Number(out.ids[0]!);
}

describe('engine parity: the remote provenance floor under a folder rule', () => {
  parityTest('a fact on a provenance page under a folder rule fails the floor for a restricted:false caller', {
    methods: ['putPage', 'insertFacts', 'applyAccessRuleChanges', 'readLinkedFactCopies', 'hasHiddenFactCopy', 'readFactWithdrawalClaim'],
  }, async (engine, backend) => {
    await createSource(engine, backend, SRC);
    for (const slug of ['notes/open', 'private/diary-x', 'raw/log-x']) await engine.putPage(slug, note(slug), { sourceId: SRC });
    await proposeRevision(engine, SRC, RULES, { origin: 'cli', store: 'database' });
    const target = await insert(engine, { fact: 'Alice keeps bees', entity: null, page: 'notes/open' }, 1);
    const ids = new Map([['open', await insert(engine, { fact: 'Alice keeps bees', entity: 'people/a-example', page: 'notes/open' }, 2)],
      ['diary', await insert(engine, { fact: 'Alice keeps bees', entity: 'people/b-example', page: 'private/diary-x' }, 3)],
      ['raw', await insert(engine, { fact: 'Alice keeps bees', entity: 'people/c-example', page: 'raw/log-x' }, 4)]]);
    const nameOf = new Map([...ids].map(([name, id]) => [id, name]));
    const reads = async () => ({
      linked: (await engine.readLinkedFactCopies({ id: target, sourceId: SRC, worldOnly: true, remoteFloor: true })).map(r => nameOf.get(Number(r.id))),
      hidden: await engine.hasHiddenFactCopy({ id: target, sourceId: SRC }),
      claim: Object.fromEntries(await Promise.all([...ids].map(async ([name, id]) =>
        [name, (await engine.readFactWithdrawalClaim({ id, sourceId: SRC, worldOnly: true, memberPage: null, remoteFloor: true })) !== null]))),
    });
    const out = { unrestricted: await withCallerAccess({ restricted: false }, reads), restricted: await withCallerAccess({ restricted: true }, reads) };
    expect(out.unrestricted).toEqual({ linked: ['open'], hidden: true, claim: { open: true, diary: false, raw: false } });
    expect(out.restricted).toEqual({ linked: ['open', 'raw'], hidden: true, claim: { open: true, diary: false, raw: true } });
    return out;
  });
});
