/**
 * BrainEngine parity — the facts trust reads over stamped tiers, write origins and write-gate receipts:
 * readFactForOwnerAction, countDerivedFactTaint, listLexicalContestCandidates, listStandingPreferences and
 * matchSavedFacts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) over facts written at declared trust tiers, with write
 *    origins that name taint inputs, flag receipts and a claimed source whose lift has not finished.
 *  - Regression: `gbrain trust confirm` binds the owner's preview to readFactForOwnerAction's row; the taint share in
 *    doctor counts countDerivedFactTaint; a lower-tier write is contested against listLexicalContestCandidates; and
 *    `gbrain trust review` lists listStandingPreferences; the saved-facts block of `search` / `query` ranks and corrects
 *    by matchSavedFacts. An engine that answers differently binds, counts, contests, lists or surfaces other facts.
 *    Before this file the Rust engine refused all five.
 *  - Why existing coverage misses it: the facts-trust.test.ts cases seed through typed writes with no declared tier,
 *    no write origin and no receipt, so every tier is `unknown`, the taint count is zero and the review list is empty;
 *    their matchSavedFacts case has four rows and no page, cue, CJK, visibility or trust-floor rule.
 *  - Seam: none. Facts are written in a transaction whose write trust settings declare the tier and write origin;
 *    receipts go through the typed write-gate member; the claimed source is created with its config. Fact ids
 *    differ between arms: rows are named by fact text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { CORRECTION_CUE } from '../../src/core/search/saved-facts-match.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const at = (s: string) => new Date(s);
const note = (title: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: 'x', frontmatter });

type Seed = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string; tier?: string; origin?: Record<string, unknown>; flag?: string[] };

const receipt = (families: string[]) => ({
  content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag' as const, reason_families: families,
  reasons: families.map(f => `${f} found`), detector_error: false, request_id: null,
});

/** Write each row in its own transaction declaring its tier and write origin; name each id by its fact text. */
async function remember(engine: BrainEngine, rows: Seed[], sourceId = SRC): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const [i, { tier, origin, flag, ...row }] of rows.entries()) {
    const valid_from = new Date(Date.UTC(2026, 4, 1 + i));
    const write = (tx: BrainEngine) => tx.insertFact({ source: 'mcp:remember', entity_slug: null, valid_from, ...row } as never, { source_id: sourceId });
    const { id } = tier
      ? await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
          [tier, tier, JSON.stringify(origin ?? { channel: tier })]);
        return write(tx);
      })
      : await write(engine);
    if (flag) await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(id), source_id: sourceId, ...receipt(flag) });
    ids.set(row.fact, id);
  }
  return ids;
}

/** Each value's kind, so an arm that returns a number as text or a time as text differs. */
const kinds = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? 'null' : v instanceof Date ? 'date' : typeof v]));

describe('facts trust reads over stamped tiers', () => {
  parityTest('readFactForOwnerAction returns the stored row the owner binding hashes, columns in order, or null', {
    methods: ['transaction', 'applyTransactionSettings', 'insertFact', 'expireFact', 'readFactForOwnerAction'],
  }, async (engine) => {
    const ids = await remember(engine, [
      { fact: 'Acme has 12 people', entity_slug: 'companies/acme', tier: 'tool_observed', claim_metric: 'headcount', claim_value: 12.5,
        claim_unit: 'people', claim_period: '2026-Q1', context: 'from the board deck' },
      { fact: 'Acme had 9 people', entity_slug: 'companies/acme', tier: 'operator_curated' },
      { fact: 'An untiered fact' },
    ]);
    await engine.expireFact(ids.get('Acme had 9 people')!, { supersededBy: ids.get('Acme has 12 people')! });
    const read = async (fact: string) => {
      const row = await engine.readFactForOwnerAction(ids.get(fact)!) as Record<string, unknown>;
      const { id, superseded_by, expired_at, ...rest } = row;
      return {
        columns: Object.keys(row),
        kinds: { ...kinds(rest), expired_at: kinds({ expired_at }).expired_at },
        values: rest,
        idIsTarget: Number(id) === ids.get(fact),
        supersededByLive: superseded_by == null ? null : Number(superseded_by) === ids.get('Acme has 12 people'),
        expired: expired_at != null,
      };
    };
    const out = { live: await read('Acme has 12 people'), ended: await read('Acme had 9 people'), untiered: await read('An untiered fact'),
      missing: await engine.readFactForOwnerAction(987654321) };
    expect(out.live.columns).toEqual(['id', 'source_id', 'trust_tier', 'fact', 'entity_slug', 'kind', 'claim_metric', 'claim_value', 'claim_unit',
      'claim_period', 'value', 'event_type', 'dimension', 'context', 'expired_at', 'superseded_by']);
    expect(out.live.values).toMatchObject({ trust_tier: 'tool_observed', claim_value: 12.5, context: 'from the board deck' });
    expect(out.ended).toMatchObject({ values: { trust_tier: 'operator_curated' }, supersededByLive: true, expired: true });
    expect(out.ended.kinds.expired_at).toBe('date');
    expect(out.untiered.values.trust_tier).toBe('unknown');
    expect(out.missing).toBeNull();
    return out;
  });

  parityTest('countDerivedFactTaint counts the facts whose write origin names taint inputs, and the external ones among them', {
    methods: ['transaction', 'applyTransactionSettings', 'insertFact', 'countDerivedFactTaint'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const before = await engine.countDerivedFactTaint();
    await remember(engine, [
      { fact: 'Derived from a web page', tier: 'external_untrusted', origin: { channel: 'ingest', taint_inputs: ['url:a'] } },
      { fact: 'Derived from my notes', tier: 'agent_written', origin: { channel: 'dream', taint_inputs: [] } },
      { fact: 'Null taint inputs', tier: 'agent_written', origin: { channel: 'dream', taint_inputs: null } },
      { fact: 'External, no taint key', tier: 'external_untrusted', origin: { channel: 'ingest' } },
      { fact: 'No origin at all' },
    ]);
    await remember(engine, [{ fact: 'Derived in another source', tier: 'external_untrusted', origin: { taint_inputs: ['x'] } }], 'other');
    const out = { before, after: await engine.countDerivedFactTaint() };
    expect(out).toEqual({ before: { derived: 0, external: 0 }, after: { derived: 4, external: 2 } });
    return out;
  });

  parityTest('listLexicalContestCandidates returns the active slot facts more trusted than the writer, newest first, by page', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'listLexicalContestCandidates'],
  }, async (engine) => {
    await engine.putPage('memory/members/pat', note('Pat'));
    await engine.putPage('memory/scope', note('Scope'));
    await engine.putPage('notes/pat', note('Pat notes'));
    const slot = { entity_slug: 'people/pat', kind: 'fact' as const, visibility: 'private' as const };
    await remember(engine, [
      { fact: 'Pat lives in Lisbon', ...slot, tier: 'operator_curated' },
      { fact: 'Pat lives in Braga', ...slot, tier: 'tool_observed' },
      { fact: 'Pat lives in Evora', ...slot, tier: 'agent_written' },
      { fact: 'Pat lives in Sintra', ...slot },
      { fact: 'Pat lives in Faro', ...slot, tier: 'user_confirmed', valid_until: at('2020-01-01T00:00:00Z') },
      { fact: 'Pat lives in Nice', ...slot, tier: 'user_confirmed', visibility: 'world' },
      { fact: 'Pat likes Lisbon', ...slot, tier: 'user_confirmed', kind: 'preference' },
      { fact: 'Sam lives in Lisbon', ...slot, tier: 'user_confirmed', entity_slug: 'people/sam' },
    ]);
    const fence = (fact: string, page: string, row_num: number) => ({ fact, ...slot, source_markdown_slug: page, row_num, source: 'fence',
      valid_from: at(`2026-06-0${row_num}T00:00:00Z`) });
    await engine.insertFacts([fence('Pat lives in Porto', 'memory/members/pat', 1), fence('Pat lives in Coimbra', 'memory/scope', 2),
      fence('Pat lives in Aveiro', 'notes/pat', 3)] as never, { source_id: SRC });
    const read = async (writer: 'external_untrusted' | 'agent_written' | 'unknown' | 'tool_observed' | 'user_confirmed', pageSlug?: string) =>
      (await engine.listLexicalContestCandidates({ sourceId: SRC, entitySlug: 'people/pat', kind: 'fact', visibility: 'private', pageSlug, writer }))
        .map(r => ({ fact: r.fact, trust_tier: r.trust_tier }));
    const out = {
      external: await read('external_untrusted'), agent: await read('agent_written'), unknown: await read('unknown'),
      observed: await read('tool_observed'), confirmed: await read('user_confirmed'),
      memberPage: await read('external_untrusted', 'memory/members/pat'), scopePage: await read('external_untrusted', 'memory/scope'),
      plainPage: await read('external_untrusted', 'notes/pat'), emptyPage: await read('external_untrusted', ''),
    };
    expect(out.agent.map(r => r.fact)).toEqual(['Pat lives in Braga', 'Pat lives in Lisbon']);
    expect(out.external.map(r => r.fact)).toContain('Pat lives in Aveiro');
    expect(out.observed.map(r => r.fact)).toEqual(['Pat lives in Lisbon']);
    expect(out.confirmed).toEqual([]);
    expect(out.memberPage.map(r => r.fact)).toEqual(['Pat lives in Porto']);
    expect(out.emptyPage).toEqual(out.external);
    return out;
  });

  parityTest('listStandingPreferences lists flagged unconfirmed standing instructions outside a claim still being lifted', {
    methods: ['transaction', 'applyTransactionSettings', 'insertFact', 'expireFact', 'upsertWriteGateReceipt', 'listStandingPreferences'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'claimed', { trust_tier: 'operator_curated', trust_claimed_at: '2026-01-01T00:00:00Z' });
    await createSource(engine, backend, 'lifted', { trust_tier: 'operator_curated', trust_claimed_at: '2026-01-01T00:00:00Z',
      trust_claim_lifted_at: '2026-01-02T00:00:00Z' });
    await createSource(engine, backend, 'connector', { kind: 'imessage', trust_tier: 'operator_curated', trust_claimed_at: '2026-01-01T00:00:00Z' });
    const standing = ['standing_instruction'];
    const ids = await remember(engine, [
      { fact: 'Always reply in French', kind: 'preference', tier: 'agent_written', flag: standing },
      { fact: 'Send the report every Friday', kind: 'commitment', tier: 'external_untrusted', flag: ['override', 'standing_instruction'] },
      { fact: 'Untiered standing preference', kind: 'preference', flag: standing },
      { fact: 'Observed standing preference', kind: 'preference', tier: 'tool_observed', flag: standing },
      { fact: 'Flagged for another family', kind: 'preference', tier: 'agent_written', flag: ['override'] },
      { fact: 'Unflagged preference', kind: 'preference', tier: 'agent_written' },
      { fact: 'A flagged plain fact', kind: 'fact', tier: 'agent_written', flag: standing },
      { fact: 'An expired standing preference', kind: 'preference', tier: 'agent_written', flag: standing },
    ]);
    await engine.expireFact(ids.get('An expired standing preference')!);
    await remember(engine, [{ fact: 'Untiered in a pending claim', kind: 'preference', flag: standing },
      { fact: 'Agent-written in a pending claim', kind: 'preference', tier: 'agent_written', flag: standing }], 'claimed');
    await remember(engine, [{ fact: 'Untiered after the lift', kind: 'preference', flag: standing }], 'lifted');
    await remember(engine, [{ fact: 'Untiered in a connector', kind: 'commitment', flag: standing }], 'connector');
    const read = async (opts: { sourceId?: string; since?: Date }) => (await engine.listStandingPreferences(opts)).map((r): Record<string, unknown> => {
      const { id, created_at, ...rest } = r as unknown as Record<string, unknown>;
      return { ...rest, hasId: id != null, created: created_at instanceof Date ? 'date' : typeof created_at };
    });
    const out = { all: await read({}), source: await read({ sourceId: 'claimed' }), since: await read({ since: at('2020-01-01T00:00:00Z') }),
      future: await read({ since: at('2999-01-01T00:00:00Z') }) };
    expect(out.all.map(r => r.fact)).toEqual(['Always reply in French', 'Send the report every Friday', 'Untiered standing preference',
      'Agent-written in a pending claim', 'Untiered after the lift', 'Untiered in a connector']);
    expect(out.source.map(r => r.fact)).toEqual(['Agent-written in a pending claim']);
    expect(out.since).toEqual(out.all);
    expect(out.future).toEqual([]);
    return out;
  });

  parityTest('matchSavedFacts keeps the active facts that share enough query words, with cue rows in their own pool', {
    methods: ['transaction', 'applyTransactionSettings', 'insertFact', 'insertFacts', 'expireFact', 'putPage', 'softDeletePage', 'matchSavedFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', note('Open'));
    await engine.putPage('notes/quarantined', note('Quarantined', { quarantine: { reason: 'junk_pattern' } }));
    await engine.putPage('notes/deleted', note('Deleted'));
    // A slug with no slash: the parser reads `people/priya` as one file-path token, so only a bare slug adds its words.
    const priya = 'priya-rao';
    const ids = await remember(engine, [
      { fact: 'Priya prefers dark roast coffee', entity_slug: priya, tier: 'operator_curated' },
      { fact: 'Priya now prefers green tea', entity_slug: priya, tier: 'agent_written' },
      { fact: 'Correction: Priya prefers coffee with oat milk', entity_slug: priya, tier: 'external_untrusted' },
      { fact: 'I retracted the coffee note', entity_slug: priya, tier: 'tool_observed' },
      { fact: 'Corrections about coffee were filed', entity_slug: priya },
      { fact: 'Disregard what I said about roast', entity_slug: priya, tier: 'agent_written' },
      { fact: 'A private coffee roast note', entity_slug: priya, visibility: 'private' },
      { fact: 'coffee roast audit checkpoint', entity_slug: priya, source: 'cli:extract-conversation-facts:terminal:v2' },
      { fact: 'coffee roast that lapsed', entity_slug: priya, valid_until: at('2020-01-01T00:00:00Z') },
      { fact: 'coffee roast forgotten', entity_slug: priya },
      { fact: '王小明喜欢咖啡 roast', entity_slug: 'people/wang' },
      { fact: 'Unrelated note about gardens', entity_slug: priya },
    ]);
    await engine.expireFact(ids.get('coffee roast forgotten')!);
    await engine.insertFacts(['open', 'quarantined', 'deleted'].map((page, i) => ({
      fact: `coffee roast on the ${page} page`, entity_slug: priya, source_markdown_slug: `notes/${page}`, row_num: 1,
      kind: 'fact' as const, visibility: 'world' as const, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
    })) as never, { source_id: SRC });
    await engine.softDeletePage('notes/deleted');
    await remember(engine, [{ fact: 'Priya roasts coffee at home', entity_slug: priya, tier: 'agent_written' }], 'other');
    type Q = Parameters<BrainEngine['matchSavedFacts']>[0];
    const match = async (terms: string[], extra: Partial<Q> = {}) => {
      const rows = await engine.matchSavedFacts({ sources: [SRC], terms, pats: terms.map(() => null), cue: CORRECTION_CUE, supersede: false,
        excludePrivate: false, worldOnly: false, ...extra });
      return rows.map((r): Record<string, unknown> => {
        const { id, at: when, created_at, matched, need, trust_rank, pool_rank, ...rest } = r as unknown as Record<string, unknown>;
        return { ...rest, hasId: id != null, at: when instanceof Date ? when.toISOString() : String(when),
          created: created_at instanceof Date ? 'date' : typeof created_at,
          matched: (matched as unknown[]).map(Number), need: Number(need), trust_rank: Number(trust_rank), pool_rank: Number(pool_rank) };
      });
    };
    const words = ['priya', 'coffee', 'roast'];
    const out = {
      plain: await match(words),
      cue: await match(words, { supersede: true }),
      stopword: await match(['the', 'coffee', 'roast']),
      worldOnly: await match(['coffee', 'roast'], { worldOnly: true }),
      excludePrivate: await match(['coffee', 'roast'], { excludePrivate: true }),
      floor: await match(['coffee', 'roast'], { minTrust: 'tool_observed' as never }),
      cjk: await match(['王小明', 'roast'], { pats: ['%王小明%', null] }),
      sources: await match(['coffee', 'roast'], { sources: [SRC, 'other'] }),
      none: await match(['zebra']),
      empty: await match(['the', 'a']),
    };
    const facts = (rows: Array<Record<string, unknown>>) => rows.map(r => r.fact);
    expect(facts(out.plain)).toContain('Priya prefers dark roast coffee');
    expect(facts(out.plain)).not.toContain('Priya now prefers green tea');
    expect(facts(out.plain)).not.toContain('I retracted the coffee note');
    expect(facts(out.cue)).toContain('I retracted the coffee note');
    expect(facts(out.cue)).toContain('Disregard what I said about roast');
    expect(facts(out.cue)).not.toContain('Corrections about coffee were filed');
    expect(facts(out.stopword)).toContain('coffee roast on the open page');
    expect(facts(out.stopword)).not.toContain('coffee roast on the quarantined page');
    expect(facts(out.stopword)).not.toContain('coffee roast on the deleted page');
    expect(facts(out.stopword)).not.toContain('coffee roast audit checkpoint');
    expect(facts(out.stopword)).not.toContain('coffee roast that lapsed');
    expect(facts(out.stopword)).not.toContain('coffee roast forgotten');
    expect(facts(out.worldOnly)).not.toContain('A private coffee roast note');
    expect(facts(out.floor)).not.toContain('A private coffee roast note');
    expect(facts(out.cjk)).toEqual(['王小明喜欢咖啡 roast']);
    expect(facts(out.sources)).toContain('Priya roasts coffee at home');
    expect(out.none).toEqual([]);
    expect(out.empty).toEqual([]);
    return out;
  });

  parityTest('matchSavedFacts cuts each pool at 200 rows, ranked by match count, then newest', {
    methods: ['insertFacts', 'matchSavedFacts'],
  }, async (engine) => {
    await engine.insertFacts(Array.from({ length: 205 }, (_, i) => ({
      fact: `zebra herd sighting ${i}`, entity_slug: null, source_markdown_slug: null, row_num: i + 1, kind: 'fact' as const,
      visibility: 'world' as const, source: 'mcp:remember', valid_from: new Date(Date.UTC(2026, 0, 1, 0, i)),
    })) as never, { source_id: SRC });
    const rows = await engine.matchSavedFacts({ sources: [SRC], terms: ['zebra'], pats: [null], cue: CORRECTION_CUE, supersede: false,
      excludePrivate: false, worldOnly: false });
    const out = { n: rows.length, first: rows[0]?.fact, last: rows.at(-1)?.fact, ranks: [...new Set(rows.map(r => Number(r.pool_rank)))].length };
    expect(out).toEqual({ n: 200, first: 'zebra herd sighting 204', last: 'zebra herd sighting 5', ranks: 200 });
    return out;
  });
});
