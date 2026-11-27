/**
 * BrainEngine parity: the ontology re-key and `repair ontology-facts` statements the re-key duplicate drop
 * (src/core/facts/ontology-rekey.ts) and `repair ontology-facts` (src/core/repair/ontology-facts.ts) ran through
 * `executeRaw` before they were members (src/core/engine-sql/ontology-repair.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listRekeyLosers names the fact a re-key would duplicate under each closed move shape (a conversation slot
 *    always loses to an ontology observation, then a retired row to an active one, then the row already at the target),
 *    and refuses a shape that is not one of them; repointSupersededToKept, clearOntologySlots and deleteRekeyLosers drop
 *    it (a conversation fact keeps its row); listOntologyFactCandidates lists the fenced and retired ontology rows with
 *    whether each was withdrawn or would duplicate another, and restoreOntologyFact restores one only while it is as the
 *    preview saw it (a withdrawal that landed since expires the restored row again).
 *  - Regression: an engine that drops a clause deletes an ontology fact a re-key should have kept, restores a row that
 *    changed since the preview or restores a withdrawn observation as live.
 *  - Why existing coverage misses it: the statements ran through `executeRaw`, which the parity cases cannot call (D18),
 *    so no case compared them across engines.
 *  - Seam: none. Facts come from insertFacts and mergeOntologyFact, withdrawals from insertFactWithdrawal. Ids differ
 *    between arms, so every case maps them to the name of the row it seeded.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const at = (iso: string) => new Date(iso);

describe('engine parity: ontology re-key and repair statements', () => {
  const VALID_FROM = '2026-01-01T00:00:00Z';
  const obs = (entitySlug: string, dimension: string, value: string, source: string, validFrom = VALID_FROM) =>
    ({ entitySlug, dimension, value, source, validFrom, sourceId: 'default' });
  const factsOf = async (engine: BrainEngine, slug: string) => (await engine.listFactsByEntity('default', slug)).map(f => f.fact);

  parityTest('a re-key drops the observation the move would duplicate; a conversation slot loses and keeps its row', {
    methods: ['mergeOntologyFact', 'insertFacts', 'listFactsByEntity', 'listRekeyLosers', 'repointSupersededToKept', 'clearOntologySlots', 'deleteRekeyLosers'],
  }, async (engine) => {
    // An ontology observation on the old entity, and a conversation fact on the new one holding the same key.
    const old = await engine.mergeOntologyFact(obs('people/dan-old-example', 'location', 'Lisbon', 'meetings/chat-a'));
    await engine.insertFacts([{ fact: 'Dan lives in Lisbon.', entity_slug: 'people/dan-example', kind: 'fact', visibility: 'private',
      source: 'cli:extract-conversation-facts', source_markdown_slug: 'meetings/chat-a', row_num: 1, valid_from: at(VALID_FROM), dimension: 'location', value: 'Lisbon' } as never], { source_id: 'default' });
    const conversation = (await engine.listFactsByEntity('default', 'people/dan-example'))[0]!;
    const move = { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/dan-old-example', 'people/dan-example'] as [unknown, unknown] };
    const losers = await engine.listRekeyLosers('default', move);
    const named = losers.map(l => [Number(l.id) === Number(conversation.id) ? 'conversation fact' : 'ontology fact', Number(l.keep) === Number(old.factId) ? 'ontology fact' : 'other']);
    await engine.clearOntologySlots(losers.map(l => Number(l.id)));
    await engine.deleteRekeyLosers(losers.map(l => Number(l.id)));
    const out: Record<string, unknown> = { named, oldAfter: await factsOf(engine, 'people/dan-old-example'), newAfter: await factsOf(engine, 'people/dan-example') };

    // Two ontology observations: the move's own row loses to the one already at the target, and supersession follows the survivor.
    const first = await engine.mergeOntologyFact(obs('people/eve-old-example', 'location', 'Lisbon', 'meetings/chat-b', '2026-01-01T00:00:00Z'));
    const second = await engine.mergeOntologyFact(obs('people/eve-old-example', 'location', 'Porto', 'meetings/chat-b', '2026-02-01T00:00:00Z'));
    const target = await engine.mergeOntologyFact(obs('people/eve-example', 'location', 'Porto', 'meetings/chat-b', '2026-02-01T00:00:00Z'));
    const eveMove = { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/eve-old-example', 'people/eve-example'] as [unknown, unknown] };
    const eveLosers = await engine.listRekeyLosers('default', eveMove);
    out.eveLosers = eveLosers.map(l => [Number(l.id) === Number(second.factId) ? 'moving Porto' : 'other', Number(l.keep) === Number(target.factId) ? 'target Porto' : 'other']);
    await engine.repointSupersededToKept(eveLosers.map(l => Number(l.id)), eveLosers.map(l => Number(l.keep)));
    await engine.clearOntologySlots(eveLosers.map(l => Number(l.id)));
    await engine.deleteRekeyLosers(eveLosers.map(l => Number(l.id)));
    const left = await engine.listFactsByEntity('default', 'people/eve-old-example');
    out.eveOld = left.map(f => [f.fact, f.superseded_by === null ? null : Number(f.superseded_by) === Number(target.factId) ? 'target Porto' : 'other']);
    out.eveTarget = await factsOf(engine, 'people/eve-example');
    out.nothingToDrop = (await engine.listRekeyLosers('default', { ...eveMove, params: ['people/nobody', 'people/eve-example'] })).length;
    expect(first.factId).not.toBeNull();
    expect(out).toMatchObject({
      named: [['conversation fact', 'ontology fact']],
      oldAfter: ['location: Lisbon'], newAfter: ['Dan lives in Lisbon.'],
      eveLosers: [['moving Porto', 'target Porto']], nothingToDrop: 0,
    });
    return out;
  });

  parityTest('the ontology candidates list the fenced and retired rows with their class, and a restore applies only to a row as previewed', {
    methods: ['insertFacts', 'listOntologyFactCandidates', 'restoreOntologyFact'],
  }, async (engine) => {
    const row = (fact: string, over: Record<string, unknown>) => ({
      fact, entity_slug: 'people/fay-example', kind: 'fact', visibility: 'world', source: 'manual', source_markdown_slug: 'people/fay-example', row_num: null,
      valid_from: at(VALID_FROM), dimension: 'location', value: fact, ...over,
    });
    await engine.insertFacts([
      row('Lisbon', { row_num: 1 }),
      row('Porto', { row_num: 2, expired_at: at('2026-03-01T12:34:56.789Z') }),
      // Holds the key `Faro` would have once restored: the fenced Faro is a duplicate.
      row('Faro', { row_num: 3 }),
      row('Faro', { source_markdown_slug: 'manual', row_num: null }),
      // Conversation slots are never candidates.
      row('Braga', { source: 'cli:extract-conversation-facts', row_num: 4 }),
      // A plain fact has no ontology slot.
      row('plain fact', { dimension: null, value: null, row_num: 5 }),
    ] as never, { source_id: 'default' });
    const candidates = await engine.listOntologyFactCandidates(['default']);
    const name = (id: number | string) => candidates.find(c => Number(c.id) === Number(id));
    const view = candidates.map(c => ({ entity: c.entity_slug, dimension: c.dimension, row_num: c.row_num === null ? null : Number(c.row_num), page: c.page,
      expired: c.expired_at, withdrawn: c.withdrawn, consolidated: c.consolidated, duplicate: c.duplicate }));
    const byRow = (n: number) => candidates.find(c => Number(c.row_num) === n)!;
    const restore = (c: (typeof candidates)[number], over: Record<string, unknown> = {}) => engine.restoreOntologyFact({ id: Number(c.id), source_id: c.source_id,
      row_num: c.row_num === null ? null : Number(c.row_num), page: c.page, expired_at: c.expired_at, ...over });
    const out = {
      candidates: view,
      restoreChangedRow: (await restore(byRow(1), { row_num: 99 })).length,
      restoreChangedPage: (await restore(byRow(1), { page: 'people/other' })).length,
      restoreChangedExpiry: (await restore(byRow(1), { expired_at: '2026-03-01T00:00:00.000000Z' })).length,
      restoreDuplicate: (await restore(byRow(3))).length,
      restoreFenced: (await restore(byRow(1))).map(r => r.expired),
      restoreRetired: (await restore(byRow(2))).map(r => r.expired),
      restoreAgain: (await restore(byRow(1))).length,
      after: (await engine.listOntologyFactCandidates(['default'])).map(c => Number(c.row_num)),
      otherSource: (await engine.listOntologyFactCandidates(['nowhere'])).length,
    };
    expect(name(byRow(1).id)).toBeDefined();
    expect(candidates).toHaveLength(3);
    expect(out).toMatchObject({ restoreChangedRow: 0, restoreChangedPage: 0, restoreChangedExpiry: 0, restoreDuplicate: 0,
      restoreFenced: [false], restoreRetired: [false], restoreAgain: 0, after: [3], otherSource: 0 });
    expect(view.find(c => c.row_num === 3)?.duplicate).toBe(true);
    expect(view.find(c => c.row_num === 2)?.expired).toMatch(/^2026-03-01T12:34:56\.789000Z$/);
    return out;
  });

  parityTest('each closed re-key shape selects its own rows, and a text that is not one of them is refused', {
    methods: ['mergeOntologyFact', 'listRekeyLosers'],
  }, async (engine) => {
    // Two keys, each held by a row on the old entity and a row on the new one: `a`/`b` and `c`/`d`.
    const a = await engine.mergeOntologyFact(obs('people/hal-old-example', 'location', 'Lisbon', 'meetings/chat-c'));
    const b = await engine.mergeOntologyFact(obs('people/hal-example', 'location', 'Lisbon', 'meetings/chat-c'));
    const c = await engine.mergeOntologyFact(obs('people/hal-old-example', 'role', 'Founder', 'meetings/chat-c'));
    const d = await engine.mergeOntologyFact(obs('people/hal-example', 'role', 'Founder', 'meetings/chat-c'));
    const label = new Map([[a.factId, 'a'], [b.factId, 'b'], [c.factId, 'c'], [d.factId, 'd']].map(([id, name]) => [Number(id), name]));
    const losers = async (move: { where: string; entity: string; sms: string; params: [unknown, unknown] }) =>
      (await engine.listRekeyLosers('default', move)).map(l => `${label.get(Number(l.id))}>${label.get(Number(l.keep))}`);
    const [oldE, newE, page] = ['people/hal-old-example', 'people/hal-example', 'meetings/chat-c'];
    const out: Record<string, unknown> = {
      unfenced: await losers({ where: 'f.entity_slug = $2 AND f.row_num IS NULL', entity: '$3::text', sms: 'f.source_markdown_slug', params: [oldE, newE] }),
      offPage: await losers({ where: 'f.entity_slug = $2 AND f.source_markdown_slug IS DISTINCT FROM $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: [oldE, newE] }),
      entity: await losers({ where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: [oldE, newE] }),
      // Every row of the page moves onto one entity: the oldest of each key stays.
      page: await losers({ where: 'f.source_markdown_slug = $2', entity: '$3::text', sms: '$2::text', params: [page, newE] }),
      pageLive: await losers({ where: 'f.source_markdown_slug = $3 AND f.expired_at IS NULL', entity: '$2::text', sms: 'f.source_markdown_slug', params: [newE, page] }),
      noParam: await losers({ where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: [null, newE] }),
    };
    const refused = async (move: { where: string; entity: string; sms: string; params: [unknown, unknown] }) => {
      try { await engine.listRekeyLosers('default', move); return 'accepted'; } catch (e) { return (e as Error).message; }
    };
    out.badWhere = await refused({ where: 'true', entity: '$3::text', sms: 'f.source_markdown_slug', params: [oldE, newE] });
    out.badEntity = await refused({ where: 'f.entity_slug = $2', entity: "'x'", sms: 'f.source_markdown_slug', params: [oldE, newE] });
    out.badSms = await refused({ where: 'f.entity_slug = $2', entity: '$3::text', sms: "'x'", params: [oldE, newE] });
    expect(out).toMatchObject({
      unfenced: ['a>b', 'c>d'], offPage: ['a>b', 'c>d'], entity: ['a>b', 'c>d'], page: ['b>a', 'd>c'], pageLive: ['b>a', 'd>c'], noParam: [],
    });
    expect(String(out.badWhere)).toContain('rekey move is not one of the supported shapes');
    return out;
  });

  parityTest('a restore applies the withdrawal an expired row gets back, and the candidate list reports the withdrawn row', {
    methods: ['insertFacts', 'insertFactWithdrawal', 'listOntologyFactCandidates', 'restoreOntologyFact'],
  }, async (engine) => {
    await engine.insertFacts([{
      fact: 'Ivy lives in Lisbon.', entity_slug: 'people/ivy-example', kind: 'fact', visibility: 'private', source: 'manual', source_markdown_slug: 'people/ivy-example',
      row_num: 1, valid_from: at(VALID_FROM), dimension: 'location', value: 'Lisbon',
    } as never, {
      fact: 'Ivy works at Acme.', entity_slug: 'people/ivy-example', kind: 'fact', visibility: 'private', source: 'manual', source_markdown_slug: 'people/ivy-example',
      row_num: 2, valid_from: at(VALID_FROM), dimension: 'employer', value: 'Acme',
    } as never], { source_id: 'default' });
    const before = await engine.listOntologyFactCandidates(['default']);
    // A withdrawal lands after the preview: the first row is withdrawn, so restoring it expires it again.
    await engine.insertFactWithdrawal('default', 'private', 'Ivy lives in Lisbon.', 'people/ivy-example', '2026-04-01T00:00:00.000000Z');
    const after = await engine.listOntologyFactCandidates(['default']);
    const restore = (c: (typeof after)[number]) => engine.restoreOntologyFact({ id: Number(c.id), source_id: c.source_id,
      row_num: c.row_num === null ? null : Number(c.row_num), page: c.page, expired_at: c.expired_at });
    const out = {
      withdrawnBefore: before.map(c => c.withdrawn),
      withdrawnAfter: after.map(c => [Number(c.row_num), c.withdrawn]),
      restored: [(await restore(after[0]!)).map(r => r.expired), (await restore(after[1]!)).map(r => r.expired)],
      left: (await engine.listOntologyFactCandidates(['default'])).length,
    };
    expect(out).toMatchObject({ withdrawnBefore: [false, false], withdrawnAfter: [[1, true], [2, false]], restored: [[true], [false]], left: 0 });
    return out;
  });
});
