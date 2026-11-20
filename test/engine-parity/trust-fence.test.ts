/**
 * BrainEngine parity — the fence guard's read of a page's fact rows (engine-sql/trust-fence.ts `listFenceFactRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listFenceFactRows returns the same live fence rows of a page, in row-number order, that the writer's trust
 *    tier, a held widening proposal or an opened row keeps from being superseded, on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers this differently (a stricter or looser rank test, an extractor row nobody claims
 *    guarded, a struck row guarded) lets a lower-trust page publish expire a row it may not, or blocks an ordinary
 *    re-publish; the Rust engine has no SQL, so the read has to exist as a typed member.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside trust/fence-guard.ts, which the
 *    parity cases cannot call (D18).
 *  - Seam: `withWriteTrustSettings`. The writer's tier and the opened ids are transaction-local settings
 *    (`gbrain.write_trust_tier`, `gbrain.write_open_facts`); every arm sets them with `applyTransactionSettings` inside
 *    `transaction` (on Rust they go to the store's write trust context on the transaction's handle). Reads stay typed
 *    members (no executeRaw: D18).
 *  - Rust fact rows store the tier their writer declared (rust/docs/store/facts.md), and the held arm reads the Rust
 *    `trust_proposals` family, so every case below expects one answer on every arm.
 *  - listHeldRows (trust/fence-guard.ts `heldRows`): the take or timeline rows a lower-tier write may not delete, more
 *    trusted than the writer or under a pending `forget`. Rust take and timeline records store their stamped tier, so both
 *    cases expect one answer on every arm; the takes case asks the guard itself, so an agent-tier write is refused on an
 *    operator-curated take.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { heldRows } from '../../src/core/trust/fence-guard.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/fence-example';
const at = (s: string) => new Date(s);

const fenceRow = (n: number, fact: string, extra: Record<string, unknown> = {}) => ({
  row_num: n, source_markdown_slug: SLUG, fact, entity_slug: SLUG, source: 'fence', kind: 'fact' as const, visibility: 'world' as const,
  valid_from: at(`2026-02-0${n}T01:02:03.250Z`), ...extra,
});

const incomingOf = (rows: Array<{ row_num: number; fact: string; visibility: string }>) => JSON.stringify(rows);

/** Fixture: run `fn` with the write trust settings `names` set to `values` for one transaction (SET LOCAL ends with it). */
async function withWriteTrustSettings<T>(engine: BrainEngine, names: string[], values: string[],
  fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(names, values);
    return fn(tx);
  });
}

/** Replaces each fact id in a fence read with the claim it was inserted with, so answers compare across arms. */
const labelled = (ids: number[], facts: string[]) => {
  const label = new Map(ids.map((id, i) => [Number(id), facts[i]!]));
  return (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> => rows.map((row) => ({ ...row, id: label.get(Number(row.id)) ?? `other:${String(row.id)}` }));
};

describe('engine parity: the fence guard read of a page\'s fact rows', () => {
  parityTest('listFenceFactRows answers the guard\'s question in the default context: no writer tier, nothing opened', {
    methods: ['insertFacts', 'listFenceFactRows'],
  }, async (engine) => {
    const rows = [
      fenceRow(3, 'Gamma'),
      fenceRow(2, 'Beta'),
      fenceRow(1, 'Alpha', { visibility: 'private' }),
      fenceRow(4, 'Delta extracted', { source: 'cli:extract-conversation-facts:session-1' }),
      { ...fenceRow(1, 'Alpha elsewhere'), source_markdown_slug: 'people/other-fence' },
    ];
    const { ids } = await engine.insertFacts(rows as never, { source_id: SRC });
    expect(ids).toHaveLength(rows.length);
    const incoming = incomingOf([
      { row_num: 1, fact: 'Alpha', visibility: 'world' },
      { row_num: 2, fact: 'Beta changed', visibility: 'world' },
      { row_num: 4, fact: 'Delta claimed', visibility: 'world' },
    ]);
    const answer = await engine.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming });
    const empty = await engine.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming: '[]' });
    const otherSource = await engine.listFenceFactRows({ sourceId: 'parity-missing', slug: SLUG, incoming });
    const otherSlug = await engine.listFenceFactRows({ sourceId: SRC, slug: 'people/nobody', incoming });
    // Every stored row is `unknown` and the writer is undeclared (`unknown`): nothing is above the writer, held or opened.
    expect({ answer, empty, otherSource, otherSlug }).toEqual({ answer: [], empty: [], otherSource: [], otherSlug: [] });
    return { answer, empty, otherSource, otherSlug };
  });

  parityTest('gbrain repair open-facts: a named private row whose cell turns world is opened in place, and the context clears after', {
    methods: ['insertFacts', 'listFenceFactRows', 'listFenceRetireCandidates'],
  }, async (engine) => {
    // Every row is written undeclared (`unknown`), so no row is above the undeclared writer: only the opened ids decide.
    const rows = [
      fenceRow(1, 'Alpha', { visibility: 'private' }),
      fenceRow(2, 'Beta', { visibility: 'private' }),
      fenceRow(3, 'Gamma'),
      fenceRow(4, 'Delta', { visibility: 'private' }),
      { ...fenceRow(1, 'Alpha'), visibility: 'private' as const, source_markdown_slug: 'people/other-fence' },
    ];
    const { ids } = await engine.insertFacts(rows as never, { source_id: SRC });
    expect(ids).toHaveLength(rows.length);
    const [alpha, beta, , , elsewhere] = ids as number[];
    const label = labelled(ids as number[], ['Alpha', 'Beta', 'Gamma', 'Delta', 'Alpha elsewhere']);
    // Alpha: same row and claim, private to world (opened). Beta: named, but its claim changed (not opened). Gamma: stated
    // as it is. Delta: private to world but not named. The other page's Alpha is named but is not this page's row.
    const incoming = incomingOf([
      { row_num: 1, fact: 'Alpha', visibility: 'world' },
      { row_num: 2, fact: 'Beta changed', visibility: 'world' },
      { row_num: 3, fact: 'Gamma', visibility: 'world' },
      { row_num: 4, fact: 'Delta', visibility: 'world' },
    ]);
    const target = { sourceId: SRC, slug: SLUG, incoming };
    const read = async (db: BrainEngine) => ({
      guarded: label(await db.listFenceFactRows(target) as never),
      retired: label(await db.listFenceRetireCandidates(target) as never),
    });
    const opened = await withWriteTrustSettings(engine, ['gbrain.write_open_facts'], [[alpha, beta, elsewhere].join(',')], read);
    const after = await read(engine);
    expect(opened.guarded).toEqual([{ id: 'Alpha', row_num: 1, fact: 'Alpha', visibility: 'private', trust_tier: 'unknown', above: false, opened: true }]);
    expect(opened.retired.map((r) => r.id)).toEqual(['Beta', 'Delta']);
    expect({ guarded: after.guarded, retired: after.retired.map((r) => r.id) }).toEqual({ guarded: [], retired: ['Alpha', 'Beta', 'Delta'] });
    return { opened, after };
  });

  parityTest('an agent writer below a stored fact\'s tier: the more trusted row is listed above the writer, the opened row as opened', {
    methods: ['insertFacts', 'listFenceFactRows'],
  }, async (engine) => {
    // An operator curated Gamma; an undeclared write left Zeta private. An MCP agent put (agent_written) then rewrites both.
    const write = (tier: string, rows: Array<ReturnType<typeof fenceRow>>) => withWriteTrustSettings(engine,
      ['gbrain.write_trust_tier'], [tier], async (tx) => (await tx.insertFacts(rows as never, { source_id: SRC })).ids as number[]);
    const [gamma] = await write('operator_curated', [fenceRow(3, 'Gamma')]);
    const [zeta] = await write('', [fenceRow(6, 'Zeta', { visibility: 'private' })]);
    const label = labelled([gamma!, zeta!], ['Gamma', 'Zeta']);
    const incoming = incomingOf([
      { row_num: 3, fact: 'Gamma changed by an agent', visibility: 'world' },
      { row_num: 6, fact: 'Zeta', visibility: 'world' },
    ]);
    const answer = label(await withWriteTrustSettings(engine, ['gbrain.write_trust_tier', 'gbrain.write_origin', 'gbrain.write_open_facts'],
      ['agent_written', JSON.stringify({ channel: 'mcp:put_page' }), String(zeta)],
      (tx) => tx.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming })) as never);
    // Gamma stays listed (operator_curated is above agent_written), so the guard files a proposal instead of expiring it.
    expect(answer).toEqual([
      { id: 'Gamma', row_num: 3, fact: 'Gamma', visibility: 'world', trust_tier: 'operator_curated', above: true, opened: false },
      { id: 'Zeta', row_num: 6, fact: 'Zeta', visibility: 'private', trust_tier: 'unknown', above: false, opened: true },
    ]);
    return answer;
  });

  parityTest('a row above the writer, held by a widening proposal, or opened, is listed in row order with its stored tier', {
    methods: ['insertFacts', 'insertTrustProposal', 'listFenceFactRows'],
  }, async (engine) => {
    // A row is stamped with its writer's declared tier, so the tiers are set by writing under them.
    const write = (tier: string, rows: Array<ReturnType<typeof fenceRow>>) => withWriteTrustSettings(engine,
      ['gbrain.write_trust_tier'], [tier], async (tx) => (await tx.insertFacts(rows as never, { source_id: SRC })).ids as number[]);
    const [gamma, alpha] = await write('operator_curated', [fenceRow(3, 'Gamma'), fenceRow(1, 'Alpha')]);
    const [beta] = await write('external_untrusted', [fenceRow(2, 'Beta')]);
    const [, epsilon, zeta, eta] = await write('', [
      fenceRow(4, 'Delta extracted', { source: 'cli:extract-conversation-facts:session-1' }),
      fenceRow(5, 'Epsilon', { visibility: 'private' }),
      fenceRow(6, 'Zeta', { visibility: 'private' }),
      fenceRow(7, 'Eta', { visibility: 'private' }),
    ]);
    expect([gamma, alpha, beta, epsilon, zeta, eta].every((id) => typeof id === 'number')).toBe(true);
    // A widening proposal that stored Epsilon narrower and is still pending holds it while the fence asks for world. Eta's
    // proposal has no `visibility` in its before state, so it holds nothing.
    const filed = await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: epsilon! },
      related: { table: 'facts', id: epsilon! }, before: { visibility: 'world' }, proposer: 'test' });
    const unheld = await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: eta! },
      related: { table: 'facts', id: eta! }, before: { fact: 'Eta' }, proposer: 'test' });
    expect([filed.created, unheld.created]).toEqual([true, true]);
    const incoming = incomingOf([
      { row_num: 1, fact: 'Alpha', visibility: 'world' },
      { row_num: 2, fact: 'Beta changed', visibility: 'world' },
      { row_num: 3, fact: 'Gamma changed', visibility: 'world' },
      { row_num: 5, fact: 'Epsilon', visibility: 'world' },
      { row_num: 6, fact: 'Zeta', visibility: 'world' },
      { row_num: 7, fact: 'Eta', visibility: 'world' },
    ]);
    const read = (tier: string, opened: string) => withWriteTrustSettings(engine,
      ['gbrain.write_trust_tier', 'gbrain.write_open_facts'], [tier, opened],
      async (tx) => (await tx.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming })).map((r) => ({
        row_num: Number(r.row_num), fact: r.fact, trust_tier: r.trust_tier, above: r.above, opened: r.opened,
      })));
    const row = (row_num: number, fact: string, trust_tier: string, above: boolean, opened = false) => ({ row_num, fact, trust_tier, above, opened });
    // Rank, most trusted first: operator_curated, unknown, external_untrusted. An external writer is below Gamma (row 3) and
    // below the unknown Epsilon, Zeta and Eta, and level with Beta; Alpha is stated as it is, and the extractor row is nobody's claim.
    const external = await read('external_untrusted', '');
    expect(external).toEqual([
      row(3, 'Gamma', 'operator_curated', true), row(5, 'Epsilon', 'unknown', true), row(6, 'Zeta', 'unknown', true),
      row(7, 'Eta', 'unknown', true),
    ]);
    // An operator-curated writer is above nothing: only Epsilon (held by the pending proposal) and Zeta (opened) are listed.
    const operator = await read('operator_curated', `${zeta}`);
    expect(operator).toEqual([row(5, 'Epsilon', 'unknown', false), row(6, 'Zeta', 'unknown', false, true)]);
    // An undeclared writer is `unknown`: it is below Gamma, and the proposal still holds Epsilon.
    const undeclared = await read('', '');
    expect(undeclared).toEqual([row(3, 'Gamma', 'operator_curated', true), row(5, 'Epsilon', 'unknown', false)]);
    return { external, operator, undeclared };
  });
});

describe('engine parity: a fence append sets its page trust back', () => {
  parityTest('restorePageTrust lowers freely, raises only under a promotion, and sets the origin the caller passes', {
    methods: ['putPage', 'readPageTrustRows', 'restorePageTrust', 'applyTransactionSettings', 'transaction'],
  }, async (engine) => {
    const page = { type: 'note' as const, title: 'Kept', compiled_truth: 'Kept body.', timeline: '' };
    const owner = { channel: 'owner-example' };
    await withWriteTrustSettings(engine, ['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify(owner)], (tx) => tx.putPage('notes/kept', page));
    const trust = async () => {
      const [row] = await engine.readPageTrustRows({ keys: [{ source_id: SRC, slug: 'notes/kept' }] });
      return { tier: row!.trust_tier, origin: row!.write_origin ?? null };
    };
    const [kept] = await engine.readPageTrustRows({ keys: [{ source_id: SRC, slug: 'notes/kept' }] });
    const pageId = Number(kept!.id);
    const agent = ['gbrain.write_trust_tier', 'gbrain.write_origin'];
    const agentValues = ['agent_written', JSON.stringify({ channel: 'agent-example' })];
    // The fence append: an agent rewrite lowers the page, then the restore raises it back under the page's own promotion.
    const appended = await withWriteTrustSettings(engine, agent, agentValues, async (tx) => {
      await tx.putPage('notes/kept', { ...page, compiled_truth: 'Kept body, appended.' });
      const lowered = await (async () => {
        const [row] = await tx.readPageTrustRows({ ids: [pageId] });
        return { tier: row!.trust_tier, origin: row!.write_origin ?? null };
      })();
      await tx.applyTransactionSettings(['gbrain.write_trust_promotion'], ['operator_curated']);
      await tx.restorePageTrust({ pageId, trustTier: 'operator_curated', writeOrigin: JSON.stringify(owner) });
      return lowered;
    });
    const restored = await trust();
    // A lower needs no promotion; a null origin clears it.
    await withWriteTrustSettings(engine, agent, agentValues,
      (tx) => tx.restorePageTrust({ pageId, trustTier: 'external_untrusted', writeOrigin: null }));
    const lowered = await trust();
    // A raise a declared writer makes without a promotion keeps the stored tier.
    await withWriteTrustSettings(engine, agent, agentValues,
      (tx) => tx.restorePageTrust({ pageId, trustTier: 'operator_curated', writeOrigin: JSON.stringify(owner) }));
    const unpromoted = await trust();
    // A raise the promotion does not cover keeps the stored tier too.
    await withWriteTrustSettings(engine, [...agent, 'gbrain.write_trust_promotion'], [...agentValues, 'tool_observed'],
      (tx) => tx.restorePageTrust({ pageId, trustTier: 'operator_curated', writeOrigin: null }));
    const capped = await trust();
    // An unknown page id writes nothing.
    await withWriteTrustSettings(engine, agent, agentValues,
      (tx) => tx.restorePageTrust({ pageId: 987_654, trustTier: 'agent_written', writeOrigin: null }));
    const after = await trust();
    expect(appended).toEqual({ tier: 'agent_written', origin: { channel: 'agent-example' } });
    expect(restored).toEqual({ tier: 'operator_curated', origin: owner });
    expect(lowered).toEqual({ tier: 'external_untrusted', origin: null });
    expect(unpromoted.tier).toBe('external_untrusted');
    expect(capped.tier).toBe('external_untrusted');
    expect(after).toEqual(capped);
    return { appended, restored, lowered, unpromoted, capped, after };
  });
});

describe('engine parity: the held-row read of a lower-tier write', () => {
  parityTest('listHeldRows lists the page\'s timeline rows above the writer, or under a pending forget, by id', {
    methods: ['putPage', 'addTimelineEntry', 'listStoredTimelineRows', 'insertTrustProposal', 'listHeldRows'],
  }, async (engine) => {
    const body = { type: 'note' as const, title: 'Held', compiled_truth: 'Body.', timeline: '' };
    const page = await engine.putPage('notes/held', body);
    const other = await engine.putPage('notes/held-other', { ...body, title: 'Other' });
    // A row is stamped with its writer's declared tier, so the tiers are set by writing under them.
    const add = (slug: string, summary: string, tier: string) => withWriteTrustSettings(engine,
      ['gbrain.write_trust_tier', 'gbrain.write_trust_promotion'], [tier, tier],
      (tx) => tx.addTimelineEntry(slug, { date: '2026-03-01', summary, detail: '', source: '' }));
    expect([
      await add('notes/held', 'plain', ''),
      await add('notes/held', 'curated', 'operator_curated'),
      await add('notes/held', 'agent', 'agent_written'),
      await add('notes/held-other', 'other page', 'operator_curated'),
    ]).toEqual([true, true, true, true]);
    const rows = [...await engine.listStoredTimelineRows(SRC, 'notes/held'), ...await engine.listStoredTimelineRows(SRC, 'notes/held-other')];
    const idOf = (summary: string) => Number(rows.find((r) => r.summary === summary)!.id);
    const ids = ['plain', 'curated', 'agent', 'other page'].map(idOf);
    const label = new Map(ids.map((id, i) => [id, ['plain', 'curated', 'agent', 'other page'][i]!]));
    const named = (out: Array<{ id: number; trust_tier: string }>) => out.map((r) => `${label.get(Number(r.id)) ?? `other:${r.id}`}=${r.trust_tier}`);
    const all = [...ids, 999_999];
    const read = (opts: { writer?: string; pending?: boolean; pageId?: number; ids?: number[] } = {}) => engine.listHeldRows({
      table: 'timeline_entries', pageId: opts.pageId ?? Number(page.id), ids: opts.ids ?? all,
      ...(opts.writer !== undefined ? { writer: opts.writer } : {}), ...(opts.pending ? { pending: true } : {}),
    }).then(named);
    // No declared tier: the writer is `unknown`, below the curated and agent rows; the other page's row is not this page's.
    const undeclared = await read();
    expect(undeclared).toEqual(['curated=operator_curated', 'agent=agent_written']);
    const agentWriter = await read({ writer: 'agent_written' });
    expect(agentWriter).toEqual(['curated=operator_curated']);
    // A name that is no tier ranks 0, below `unknown`.
    const noTier = await read({ writer: 'no-such-tier' });
    expect(noTier).toEqual(['plain=unknown', 'curated=operator_curated', 'agent=agent_written']);
    // With no writer named, the declared tier of the transaction is the writer.
    const declared = await withWriteTrustSettings(engine, ['gbrain.write_trust_tier'], ['operator_curated'],
      async (tx) => named(await tx.listHeldRows({ table: 'timeline_entries', pageId: Number(page.id), ids: all })));
    expect(declared).toEqual([]);
    // A pending forget on the plain row holds it only when `pending` asks for the open contest.
    const filed = await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'timeline_entries', id: ids[0]! },
      before: {}, proposer: 'test' });
    expect(filed.created).toBe(true);
    const curatedWriter = await read({ writer: 'operator_curated' });
    expect(curatedWriter).toEqual([]);
    const contested = await read({ writer: 'operator_curated', pending: true });
    expect(contested).toEqual(['plain=unknown']);
    const otherPage = await read({ pageId: Number(other.id), writer: 'agent_written' });
    expect(otherPage).toEqual(['other page=operator_curated']);
    const none = await read({ ids: [] });
    expect(none).toEqual([]);
    return { undeclared, agentWriter, noTier, declared, curatedWriter, contested, otherPage, none };
  });

  parityTest('heldRows refuses a lower-tier write on a higher-tier take: the page\'s takes above the writer, or under a pending forget, by id', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'insertTrustProposal', 'listHeldRows'],
  }, async (engine) => {
    const body = { type: 'note' as const, title: 'Held takes', compiled_truth: 'Body.', timeline: '' };
    const page = await engine.putPage('notes/held-takes', body);
    const other = await engine.putPage('notes/held-takes-other', { ...body, title: 'Other' });
    // A take is stamped with its writer's declared tier, so the tiers are set by writing under them.
    const add = (pageId: number, rowNum: number, claim: string, tier: string) => withWriteTrustSettings(engine,
      ['gbrain.write_trust_tier', 'gbrain.write_trust_promotion'], [tier, tier],
      (tx) => tx.addTakesBatch([{ page_id: pageId, row_num: rowNum, claim, kind: 'take', holder: 'h', weight: 0.5 }]));
    expect([
      await add(Number(page.id), 1, 'plain', ''),
      await add(Number(page.id), 2, 'curated', 'operator_curated'),
      await add(Number(page.id), 3, 'agent', 'agent_written'),
      await add(Number(other.id), 1, 'other page', 'operator_curated'),
    ]).toEqual([1, 1, 1, 1]);
    const takes = [...await engine.listTakes({ page_id: Number(page.id) }), ...await engine.listTakes({ page_id: Number(other.id) })];
    const idOf = (claim: string) => Number(takes.find((t) => t.claim === claim)!.id);
    const claims = ['plain', 'curated', 'agent', 'other page'];
    const ids = claims.map(idOf);
    const label = new Map(ids.map((id, i) => [id, claims[i]!]));
    const named = (held: Map<number, string>) => [...held].map(([id, tier]) => `${label.get(id) ?? `other:${id}`}=${tier}`);
    const all = [...ids, 999_999];
    const guard = (writer: 'agent_written' | 'operator_curated' | undefined, opts: { pending?: boolean; pageId?: number } = {}) =>
      heldRows(engine, 'takes', opts.pageId ?? Number(page.id), all, { ...(writer ? { writer } : {}), ...(opts.pending ? { pending: true } : {}) }).then(named);
    // An agent-tier write may not delete or overwrite the operator-curated take; the plain take is not above it.
    const agentWriter = await guard('agent_written');
    expect(agentWriter).toEqual(['curated=operator_curated']);
    // An operator-curated write is above every take of the page, so nothing is held.
    const curatedWriter = await guard('operator_curated');
    expect(curatedWriter).toEqual([]);
    // With no writer named, the transaction's declared tier is the writer: undeclared is `unknown`, below both stamped takes.
    const undeclared = await engine.transaction(async (tx) => named(await heldRows(tx, 'takes', Number(page.id), all)));
    expect(undeclared).toEqual(['curated=operator_curated', 'agent=agent_written']);
    // A pending forget on the plain take holds it only when the open contest is asked for.
    const filed = await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: ids[0]! },
      before: {}, proposer: 'test' });
    expect(filed.created).toBe(true);
    const contested = await guard('operator_curated', { pending: true });
    expect(contested).toEqual(['plain=unknown']);
    const otherPage = await guard('agent_written', { pageId: Number(other.id) });
    expect(otherPage).toEqual(['other page=operator_curated']);
    return { agentWriter, curatedWriter, undeclared, contested, otherPage };
  });
});
