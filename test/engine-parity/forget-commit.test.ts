/**
 * BrainEngine parity — the statements a forget's withdrawal commits (recordFactWithdrawal, src/core/facts/withdrawal.ts;
 * src/core/persistence/forget-prepare.ts) and the withdrawal a refused remember names (factWithdrawnRefusal,
 * src/core/facts/single-prepare.ts), which ran through `executeRaw` before they had members
 * (src/core/engine-sql/trust-withdrawals.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: lockFactForWithdrawal answers a fact's visibility, text and ledger subject (its owned memory page, '*'
 *    for no or an unbacked entity, else the entity) when the withdrawal admits it: any fact, world facts and a private
 *    fact on the member page under worldOnly, and facts the remote floor admits under remoteFloor; an extraction outcome
 *    marker answers too; another source's fact or an unknown id answers null. queueWithdrawalReview queues one
 *    `withdraw` review row of subject '*' however often it runs. bumpWithdrawnPageRevisions gives each named inline page
 *    a new knowledge revision and answers it; readPageRevisions reads those revisions back; listSegmentedPagesBySlug
 *    answers no inline page. appendFactForgetReason appends its note to the fact's context after ' | ', or sets it on an
 *    empty context. readFactWithdrawnRow answers the withdrawal a save of the claim meets (its entity's before the
 *    source-wide one, then the newest) and readFactWithdrawnBacking whether the remote caller sees a withdrawn row.
 *  - Regression: on a Rust brain `gbrain forget` stopped at the withdrawal's raw statements and a remember of a
 *    forgotten claim refused with the engine's raw_sql refusal in place of `fact_withdrawn`.
 *  - Why existing coverage misses it: the statements were raw SQL inside withdrawal.ts, forget-prepare.ts and
 *    single-prepare.ts, so no engine arm ran them; test/engine-parity/forget-remember.test.ts reaches the refusal only
 *    through a whole remember.
 *  - Seam: none. Sources come from the harness fixture, rows from typed members. Ids, revisions and times differ
 *    between arms, so facts and pages are named by text and slug, revisions are compared only as changed or equal, and
 *    withdrawn_at is compared through Date.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: 'x', timeline: '', frontmatter });

/** Insert one fact in a transaction whose write trust settings declare the operator tier; its id. */
async function insert(engine: BrainEngine, row: { fact: string; entity: string | null; page: string | null; visibility?: 'world' | 'private'; sourceId?: string; source?: string; context?: string }, n: number): Promise<number> {
  const out = await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    return tx.insertFacts([{
      fact: row.fact, entity_slug: row.entity, source_markdown_slug: row.page, row_num: n, kind: 'fact',
      visibility: row.visibility ?? 'world', source: row.source ?? 'fence', valid_from: new Date(Date.UTC(2026, 6, 1)),
      ...(row.context !== undefined ? { context: row.context } : {}),
    }] as never, { source_id: row.sourceId ?? 'default' });
  });
  return Number(out.ids[0]!);
}

describe('engine parity: the forget commit and the fact_withdrawn refusal', () => {
  parityTest('lockFactForWithdrawal reads the claim and subject of a fact a withdrawal admits',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'lockFactForWithdrawal'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('people/e-example', note('E'));
      await engine.putPage('notes/open', note('Open'));
      await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
      const member = 'memory/members/alice-example';
      const rows: Array<{ name: string; fact: string; entity: string | null; page: string | null; visibility?: 'world' | 'private'; source?: string; sourceId?: string }> = [
        { name: 'w-entity', fact: '  Erin   ROWS boats ', entity: 'people/e-example', page: 'notes/open' },
        { name: 'w-unlinked', fact: 'Erin rows boats', entity: null, page: 'notes/open' },
        { name: 'w-unbacked', fact: 'Erin rows boats', entity: 'erinname', page: 'notes/open' },
        { name: 'w-private-page', fact: 'Erin rows boats', entity: 'people/f-example', page: 'notes/private' },
        { name: 'p-member', fact: 'Erin rows boats', entity: 'people/e-example', page: member, visibility: 'private' },
        { name: 'p-scope', fact: 'Erin rows boats', entity: null, page: 'memory/scope', visibility: 'private' },
        { name: 'p-open', fact: 'Erin rows boats', entity: 'people/e-example', page: 'notes/open', visibility: 'private' },
        { name: 'marker', fact: 'EXTRACTION_COMPLETE', entity: null, page: 'notes/open', source: 'cli:extract-conversation-facts:terminal' },
        { name: 'o-other', fact: 'Erin rows boats', entity: null, page: null, sourceId: 'other' },
      ];
      const ids = new Map<string, number>();
      for (const [i, r] of rows.entries()) ids.set(r.name, await insert(engine, r, i + 1));
      const forms: Record<string, { worldOnly: boolean; memberPage: string | null; remoteFloor: boolean }> = {
        any: { worldOnly: false, memberPage: null, remoteFloor: false },
        world: { worldOnly: true, memberPage: null, remoteFloor: false },
        member: { worldOnly: true, memberPage: member, remoteFloor: false },
        floor: { worldOnly: true, memberPage: null, remoteFloor: true },
      };
      const out: Record<string, Record<string, unknown>> = {};
      for (const [form, spec] of Object.entries(forms)) {
        out[form] = {};
        for (const name of ids.keys()) out[form][name] = await engine.lockFactForWithdrawal({ id: ids.get(name)!, sourceId: 'default', ...spec });
      }
      const extra = {
        otherSource: await engine.lockFactForWithdrawal({ id: ids.get('o-other')!, sourceId: 'other', ...forms.any }),
        unknown: await engine.lockFactForWithdrawal({ id: Math.max(...ids.values()) + 1000, sourceId: 'default', ...forms.any }),
      };
      const subjects = (form: string) => Object.fromEntries(Object.entries(out[form]).map(([name, row]) => [name, row ? (row as { subject: string }).subject : null]));
      expect(subjects('any')).toEqual({
        'w-entity': 'people/e-example', 'w-unlinked': '*', 'w-unbacked': '*', 'w-private-page': 'people/f-example',
        'p-member': member, 'p-scope': 'memory/scope', 'p-open': 'people/e-example', marker: '*', 'o-other': null,
      });
      expect(out.any['w-entity']).toEqual({ visibility: 'world', fact: '  Erin   ROWS boats ', subject: 'people/e-example' });
      expect(subjects('world')['p-member']).toBeNull();
      expect(subjects('member')['p-member']).toBe(member);
      expect(subjects('member')['p-open']).toBeNull();
      expect(subjects('floor')['w-private-page']).toBeNull();
      expect(subjects('floor')['w-entity']).toBe('people/e-example');
      expect(extra.otherSource).toEqual({ visibility: 'world', fact: 'Erin rows boats', subject: '*' });
      expect(extra.unknown).toBeNull();
      return { out, extra };
    });

  parityTest('the commit writes queue one review, move the page revisions and note the forget reason',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'getPage', 'insertFacts', 'listFactsForPage', 'listDueDecideReviewQueue',
      'queueWithdrawalReview', 'listSegmentedPagesBySlug', 'bumpWithdrawnPageRevisions', 'readPageRevisions', 'appendFactForgetReason'] },
    async (engine) => {
      await engine.putPage('people/e-example', note('E'));
      await engine.putPage('notes/open', note('Open'));
      const plain = await insert(engine, { fact: 'Erin rows boats', entity: 'people/e-example', page: 'notes/open' }, 1);
      const noted = await insert(engine, { fact: 'Erin sails', entity: 'people/e-example', page: 'notes/open', context: 'from a call' }, 2);

      await engine.queueWithdrawalReview('default', String(plain));
      await engine.queueWithdrawalReview('default', String(plain));
      const queue = (await engine.listDueDecideReviewQueue('withdraw', 'default', 10))
        .map(r => ({ kind: r.kind, a_ref: r.a_ref === String(plain) ? 'plain' : r.a_ref, b_ref: r.b_ref, attempts: r.attempts }));

      const slugs = ['notes/open', 'people/e-example', 'people/none-example'];
      const before = new Map<string, string>();
      for (const slug of slugs.slice(0, 2)) before.set(slug, String((await engine.getPage(slug) as unknown as { knowledge_revision?: string }).knowledge_revision ?? ''));
      const segmented = await engine.listSegmentedPagesBySlug('default', slugs);
      const bumped = await engine.bumpWithdrawnPageRevisions('default', slugs);
      const read = await engine.readPageRevisions(bumped.map(p => Number(p.id)));
      const bySlug = (rows: Array<{ slug: string; knowledge_revision: string }>) => new Map(rows.map(r => [r.slug, r.knowledge_revision]));
      const bumpedBySlug = bySlug(bumped);
      const readBySlug = bySlug(read);
      const revisions = slugs.slice(0, 2).map(slug => ({
        slug, bumped: bumpedBySlug.has(slug), changed: bumpedBySlug.get(slug) !== before.get(slug), readBack: readBySlug.get(slug) === bumpedBySlug.get(slug),
      }));

      await engine.appendFactForgetReason(plain, 'default', 'forgotten: wrong');
      await engine.appendFactForgetReason(noted, 'default', 'forgotten: stale');
      await engine.appendFactForgetReason(noted, 'other-source-example', 'forgotten: elsewhere');
      const contexts = (await engine.listFactsForPage('default', 'notes/open'))
        .map(f => ({ fact: f.fact, context: (f as unknown as { context: string | null }).context ?? null }))
        .sort((a, b) => a.fact.localeCompare(b.fact));

      expect(queue).toEqual([{ kind: 'withdraw', a_ref: 'plain', b_ref: '*', attempts: 0 }]);
      expect(segmented).toEqual([]);
      expect(revisions).toEqual([
        { slug: 'notes/open', bumped: true, changed: true, readBack: true },
        { slug: 'people/e-example', bumped: true, changed: true, readBack: true },
      ]);
      expect(bumped.length).toBe(2);
      expect(contexts).toEqual([
        { fact: 'Erin rows boats', context: 'forgotten: wrong' },
        { fact: 'Erin sails', context: 'from a call | forgotten: stale' },
      ]);
      return { queue, segmented, revisions, contexts };
    });

  parityTest('readFactWithdrawnRow and readFactWithdrawnBacking read the withdrawal a save of the claim meets',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'insertFactWithdrawal', 'expireFactsByWithdrawal',
      'readFactWithdrawnRow', 'readFactWithdrawnBacking'] },
    async (engine) => {
      await engine.putPage('people/e-example', note('E'));
      await engine.putPage('notes/open', note('Open'));
      await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
      const member = 'memory/members/alice-example';
      await insert(engine, { fact: 'Erin rows boats', entity: 'people/e-example', page: 'notes/open' }, 1);
      await insert(engine, { fact: 'Gil hides keys', entity: 'people/e-example', page: 'notes/private' }, 2);
      await insert(engine, { fact: 'Mia paints', entity: null, page: member, visibility: 'private' }, 3);
      const at = (day: number) => new Date(Date.UTC(2026, 8, day)).toISOString();
      const withdraw = async (visibility: string, claim: string, subject: string, day: number) => ({
        inserted: await engine.insertFactWithdrawal('default', visibility, claim, subject, at(day)),
        expired: (await engine.expireFactsByWithdrawal('default', visibility, claim, subject)).length,
      });
      const writes = {
        sourceWide: await withdraw('world', 'Erin rows boats', '*', 1),
        entity: await withdraw('world', '  ERIN rows   boats', 'people/e-example', 2),
        hidden: await withdraw('world', 'Gil hides keys', 'people/e-example', 3),
        unbackedOnly: await withdraw('world', 'Nobody saw this', '*', 4),
        memberPage: await withdraw('private', 'Mia paints', member, 5),
      };
      const spec = (fact: string, more: Partial<{ visibility: string; entitySlug: string | null; ownedPage: string | null; excludePrivate: boolean }> = {}) =>
        ({ sourceId: 'default', visibility: 'world', fact, entitySlug: null, ownedPage: null, excludePrivate: false, ...more });
      const norm = (row: { subject: string; visibility: string; withdrawn_at: string } | null) =>
        row ? { subject: row.subject, visibility: row.visibility, at: new Date(row.withdrawn_at).toISOString() } : null;
      const rows = {
        entityFirst: norm(await engine.readFactWithdrawnRow(spec('Erin rows boats', { entitySlug: 'people/e-example' }))),
        sourceWide: norm(await engine.readFactWithdrawnRow(spec('erin ROWS boats'))),
        otherEntity: norm(await engine.readFactWithdrawnRow(spec('Erin rows boats', { entitySlug: 'people/z-example' }))),
        none: norm(await engine.readFactWithdrawnRow(spec('Erin rows canoes'))),
        privateNone: norm(await engine.readFactWithdrawnRow(spec('Erin rows boats', { visibility: 'private' }))),
        hiddenLocal: norm(await engine.readFactWithdrawnRow(spec('Gil hides keys', { entitySlug: 'people/e-example' }))),
        hiddenRemote: norm(await engine.readFactWithdrawnRow(spec('Gil hides keys', { entitySlug: 'people/e-example', excludePrivate: true }))),
        seenRemote: norm(await engine.readFactWithdrawnRow(spec('Erin rows boats', { entitySlug: 'people/e-example', excludePrivate: true }))),
        unbackedRemote: norm(await engine.readFactWithdrawnRow(spec('Nobody saw this', { excludePrivate: true }))),
        memberPage: norm(await engine.readFactWithdrawnRow(spec('Mia paints', { visibility: 'private', ownedPage: member, excludePrivate: true }))),
      };
      const backing = {
        seen: await engine.readFactWithdrawnBacking(spec('Erin rows boats', { entitySlug: 'people/e-example', excludePrivate: true })),
        hidden: await engine.readFactWithdrawnBacking(spec('Gil hides keys', { entitySlug: 'people/e-example', excludePrivate: true })),
        unbacked: await engine.readFactWithdrawnBacking(spec('Nobody saw this', { excludePrivate: true })),
        memberPage: await engine.readFactWithdrawnBacking(spec('Mia paints', { visibility: 'private', ownedPage: member, excludePrivate: true })),
      };

      expect(rows.entityFirst).toEqual({ subject: 'people/e-example', visibility: 'world', at: at(2) });
      expect(rows.sourceWide).toEqual({ subject: '*', visibility: 'world', at: at(1) });
      expect(rows.otherEntity).toEqual({ subject: '*', visibility: 'world', at: at(1) });
      expect(rows.none).toBeNull();
      expect(rows.privateNone).toBeNull();
      expect(rows.hiddenLocal).toEqual({ subject: 'people/e-example', visibility: 'world', at: at(3) });
      expect(rows.unbackedRemote).toEqual({ subject: '*', visibility: 'world', at: at(4) });
      expect(rows.memberPage).toEqual({ subject: member, visibility: 'private', at: at(5) });
      expect(backing.unbacked).toEqual({ visible: false, hidden: false });
      expect(backing.memberPage.visible).toBe(true);
      return { writes, rows, backing };
    });
});
