/**
 * BrainEngine parity — the fence overlay's read of one page (engine-sql/cli-reads-ops.ts `readFenceOverlayRows`,
 * eligibility/fence-overlay.ts `loadFenceChunkOverlay` and `heldRowsForCaller`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for each world facts-fence row of a page body, every engine arm reads the same live page tier, the tier
 *    of the page's newest fact at the row number and whether that fact is activation-flagged, whether a held write-gate
 *    hold names the row's fingerprint on the page, and, for a world-only fact reader, whether a narrower stored fact
 *    holds the row. So chunk text, search labels and remote page bodies omit and demote the same rows on every engine.
 *  - Regression: the overlay ran its query through `executeRaw`, which the Rust engine refuses. Chunking, evidence
 *    text and remote page reads on a Rust brain then failed or lost the overlay, while the SQL engines omitted held
 *    rows and demoted rows written below the page's tier.
 *  - Why existing coverage misses it: test/fence-chunk-overlay.test.ts runs the SQL engines only, and no parity case
 *    read the overlay.
 *  - Seam: none. Real engines, typed methods only; the caller context is the default one (no member, no grant).
 *    Fact purges are not seeded here; test/engine-parity/fact-purge-ledger.test.ts reads `purged`.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { holdFingerprint } from '../../src/core/write-gate-store.ts';
import { fenceRowHoldTexts, heldRowsForCaller, loadFenceChunkOverlay } from '../../src/core/eligibility/fence-overlay.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/overlay-example';
const OTHER = 'people/other-example';

const row = (rowNum: number, claim: string): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: '2024-01-01', source: 'user', active: true,
});
const ROWS = [row(1, 'Ana lives in Lima'), row(2, 'Ana keeps bees'), row(3, 'Ana sings opera'), row(4, 'Ana paints'),
  row(5, 'Ana rides horses'), row(6, 'Ana swims daily')];
const BODY = `Ana Example runs acme-example.\n\n## Facts\n\n${renderFactsTable(ROWS)}\n`;
const fp = (r: ParsedFact) => holdFingerprint('fact', fenceRowHoldTexts(r));

/** Run `fn` in a transaction whose write trust context declares `tier` and `origin`. */
function declaredWrite(engine: BrainEngine, tier: string, origin: Record<string, unknown>, fn: (tx: BrainEngine) => Promise<unknown>) {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify(origin)]);
    return fn(tx);
  });
}

/**
 * Fixture: the page is tool-observed. Row 1 has an expired agent-written fact (expired facts still count); row 2 has one with an activation flag receipt;
 * row 3 has a held hold on its fingerprint; row 4's agent-written fact is stored private; row 5 has a
 * tool-observed fact (the page's own tier, so it stays); row 6 has no fact and only a released hold.
 * The other page holds row 1's fingerprint, which must not hold this page's row 1.
 */
async function seed(engine: BrainEngine): Promise<void> {
  await declaredWrite(engine, 'tool_observed', { channel: 'tool' }, tx =>
    tx.putPage(SLUG, { type: 'person', title: 'Ana Example', compiled_truth: BODY, timeline: '' }));
  const fact = async (tier: string, rowNum: number, text: string, visibility: 'world' | 'private' = 'world') => {
    const out = await declaredWrite(engine, tier, { channel: tier === 'agent_written' ? 'agent' : 'tool' }, tx => tx.insertFacts([{
      fact: text, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: rowNum, kind: 'fact', visibility, source: 'fence',
    }] as never, { source_id: SRC })) as { ids: number[] };
    return out.ids[0]!;
  };
  await engine.expireFact(await fact('agent_written', 1, 'Ana lives in Lima'));
  const flagged = await fact('agent_written', 2, 'Ana keeps bees');
  await fact('agent_written', 4, 'Ana paints', 'private');
  await fact('tool_observed', 5, 'Ana rides horses');
  await engine.upsertWriteGateReceipt({
    target_table: 'facts', target_id: String(flagged), source_id: SRC, content_hash: 'h-bees', tier: 'agent_written', detector_version: 1,
    verdict: 'flag', reason_families: ['override'], reasons: ['override found'], detector_error: false, request_id: null,
  });
  const hold = (slug: string, r: ParsedFact) => engine.upsertWriteGateHold({
    kind: 'fact', source_id: SRC, slug, fingerprint: fp(r), detector_version: 1, tier: 'agent_written',
    reason_families: ['override'], reasons: ['override found'], detector_error: false, payload: { row_num: r.rowNum, fact: r.claim },
    write_origin: null, request_id: null,
  } as never);
  await hold(SLUG, ROWS[2]!);
  await hold(OTHER, ROWS[0]!);
  await engine.decideWriteGateHold(await hold(SLUG, ROWS[5]!), 'released', 'owner');
}

const view = (o: Awaited<ReturnType<typeof loadFenceChunkOverlay>>) => o && ({
  omit: sorted([...o.omit]), demote: sorted([...o.demote].map(([n, t]) => `${n}:${t}`)),
  unconfirmed: sorted([...(o.unconfirmed ?? [])]), held: sorted([...(o.held ?? [])]),
});

describe('engine parity: the fence overlay of one page', () => {
  parityTest('loadFenceChunkOverlay omits held rows and demotes rows below the page tier', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'expireFact', 'upsertWriteGateReceipt',
      'upsertWriteGateHold', 'decideWriteGateHold', 'readFenceOverlayRows'],
  }, async (engine) => {
    await seed(engine);
    const page = { sourceId: SRC, slug: SLUG, compiled_truth: BODY, timeline: '' };
    const plain = view(await loadFenceChunkOverlay(engine, page));
    expect(plain).toEqual({ omit: [3], demote: ['1:agent_written', '2:agent_written', '4:agent_written'], unconfirmed: [2], held: [] });
    const hidden = view(await loadFenceChunkOverlay(engine, page, { hideHeld: true }));
    expect(hidden).toEqual({ omit: [3, 4], demote: ['1:agent_written', '2:agent_written'], unconfirmed: [2], held: [4] });
    const noHolds = view(await loadFenceChunkOverlay(engine, page, { holdFingerprint: null }));
    expect(noHolds?.omit).toEqual([]);
    const callerHeld = sorted([...(await heldRowsForCaller(engine, true, page)) ?? []]);
    expect(callerHeld).toEqual([4]);
    expect(await heldRowsForCaller(engine, false, page)).toBeUndefined();
    expect(await loadFenceChunkOverlay(engine, { ...page, compiled_truth: 'No fence here.' })).toBeUndefined();
    return { plain, hidden, noHolds, callerHeld };
  });

  parityTest('readFenceOverlayRows reads each incoming row in order', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'expireFact', 'upsertWriteGateReceipt',
      'upsertWriteGateHold', 'decideWriteGateHold', 'readFenceOverlayRows'],
  }, async (engine) => {
    await seed(engine);
    const incoming = [ROWS[4]!, ROWS[0]!, ROWS[2]!, ROWS[3]!, ROWS[5]!].map(r => ({ row_num: r.rowNum, claim: r.claim, visibility: 'world', fp: fp(r) }));
    const rows = await engine.readFenceOverlayRows({ sourceId: SRC, slug: SLUG }, [...incoming, { row_num: 3, claim: 'Ana sings opera', visibility: 'world', fp: null }], { hideHeld: true });
    expect(rows).toEqual([
      { row_num: 5, page_tier: 'tool_observed', row_tier: 'tool_observed', row_flagged: false, purged: false, held: false, narrower: false },
      { row_num: 1, page_tier: 'tool_observed', row_tier: 'agent_written', row_flagged: false, purged: false, held: false, narrower: false },
      { row_num: 3, page_tier: 'tool_observed', row_tier: null, row_flagged: null, purged: false, held: true, narrower: false },
      { row_num: 4, page_tier: 'tool_observed', row_tier: 'agent_written', row_flagged: false, purged: false, held: false, narrower: true },
      { row_num: 6, page_tier: 'tool_observed', row_tier: null, row_flagged: null, purged: false, held: false, narrower: false },
      { row_num: 3, page_tier: 'tool_observed', row_tier: null, row_flagged: null, purged: false, held: false, narrower: false },
    ]);
    const open = await engine.readFenceOverlayRows({ sourceId: SRC, slug: SLUG }, incoming.slice(3, 4), { hideHeld: false });
    expect(open).toEqual([{ row_num: 4, page_tier: 'tool_observed', row_tier: 'agent_written', row_flagged: false, purged: false, held: false, narrower: false }]);
    const elsewhere = await engine.readFenceOverlayRows({ sourceId: SRC, slug: OTHER }, incoming.slice(1, 2), { hideHeld: true });
    expect(elsewhere).toEqual([{ row_num: 1, page_tier: null, row_tier: null, row_flagged: null, purged: false, held: true, narrower: false }]);
    expect(await engine.readFenceOverlayRows({ sourceId: SRC, slug: SLUG }, [], { hideHeld: true })).toEqual([]);
    return { rows, open, elsewhere };
  });
});
