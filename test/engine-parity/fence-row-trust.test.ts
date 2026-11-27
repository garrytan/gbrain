/**
 * BrainEngine parity — the fence-row trust read recall's query arm and synthesize run on the pages they return
 * (stampPageTrust, src/core/eligibility/stamp.ts applyFenceRowTrust), and synthesize's keyless refusal, on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a chunk holding facts-fence rows, the label a reader sees folds in the current state of each row's
 *    newest live fact (expired facts skipped, the highest id wins): its stored trust tier (the chunk takes the lowest),
 *    an unconfirmed instruction-family flag and a pending supersede proposal. recall with a query and synthesize show
 *    the same labels on PGLite, Postgres and Rust. Keyless synthesize answers the protocol error `unavailable` with a
 *    suggestion on every engine (docs/protocol/MEMORY_VERBS_v1.md).
 *  - Regression: on a Rust brain the read ran through `executeRaw` (FENCE_ROW_SQL), which the Rust engine refuses, so
 *    recall with a query and synthesize failed (memory-verb conformance 18/24 on Rust in the GBEV-3 keyless pilot).
 *  - Why existing coverage misses it: test/memory-verbs-conformance.test.ts runs on PGLite only, and no parity case
 *    put facts-fence rows under a recall query or a synthesize gather.
 *  - Seam: the chat transport (__setChatTransportForTests) stands in for the model and records the prompt synthesize
 *    sends; the gateway is keyless, so the query arm is keyword-only. Pages come from the import path; facts, write-gate
 *    receipts and trust proposals from typed members; tiers through maintenanceTransaction's write trust.
 */
import { afterAll, beforeEach, describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { maintenanceTransaction } from '../../src/core/persistence/attribution.ts';
import { FENCE_TRUST_ORIGIN } from '../../src/core/eligibility/fence-overlay.ts';
import type { TrustTier, WriteTrust } from '../../src/core/trust/tier.ts';
import { dispatchToolCall, type DispatchOpts } from '../../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { emptyHome, withEnv } from '../helpers/with-env.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'notes/harbor-ledger';
const trustAt = (tier: TrustTier): WriteTrust => ({ tier, origin: { channel: 'test:fixture' } });
const FENCE = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | The harbor ledger lists three moorings | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | The harbor ledger opens at dawn | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 3 | The harbor ledger keeps a tide table | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 4 | The harbor ledger was rewritten | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const CONTENT = `---\ntitle: Harbor ledger\ntype: note\n---\n\n# Harbor ledger\n\nThe harbor ledger notes.\n\n## Facts\n\n${FENCE}\n`;

beforeEach(() => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  __setChatTransportForTests(null);
});
afterAll(() => { resetGateway(); __setChatTransportForTests(null); });

/** A fence fact at `row` of the page, written at `tier`; its id. */
async function fenceFact(engine: BrainEngine, row: number, fact: string, tier: TrustTier): Promise<number> {
  const out = await maintenanceTransaction(engine, tx => tx.insertFacts([{ fact, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: row,
    kind: 'fact', visibility: 'world', source: 'fence' }] as never, { source_id: 'default' }), trustAt(tier));
  if (out.ids.length !== 1) throw new Error(`fence fact at row ${row} was not stored: ${JSON.stringify(out)}`);
  return Number(out.ids[0]);
}

/**
 * The page with four fence rows (a fence row holds one fact; the facts the import stored are replaced here), each with
 * a different current state:
 *  - row 1: an operator-curated fact;
 *  - row 2: an agent-written fact with an instruction-family flag (the chunk's lowest tier, and unconfirmed);
 *  - row 3: a tool-observed fact a pending supersede proposal challenges;
 *  - row 4: an expired fact at the lowest tier (skipped: it lowers nothing).
 */
async function seed(engine: BrainEngine) {
  await maintenanceTransaction(engine, tx => importFromContent(tx, SLUG, CONTENT, { noEmbed: true }), trustAt('operator_curated'));
  await engine.deleteFactsForPage(SLUG, 'default');
  await fenceFact(engine, 1, 'The harbor ledger lists three moorings', 'operator_curated');
  const flagged = await fenceFact(engine, 2, 'The harbor ledger opens at dawn', 'agent_written');
  await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(flagged), source_id: 'default', content_hash: 'h-flagged',
    tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'], reasons: ['ignore prior rules'],
    detector_error: false, request_id: null });
  const challenged = await fenceFact(engine, 3, 'The harbor ledger keeps a tide table', 'tool_observed');
  const expired = await fenceFact(engine, 4, 'The harbor ledger was rewritten', 'external_untrusted');
  await engine.expireFact(expired);
  const challenger = await fenceFact(engine, 9, 'The harbor ledger lost its tide table', 'agent_written');
  await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: 'default', target: { table: 'facts', id: challenged },
    related: { table: 'facts', id: challenger }, before: {}, proposer: 'parity' });
}

const remote: DispatchOpts = { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' };
async function call(engine: BrainEngine, name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, remote);
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
}

/** What a reader sees of each fence-bearing result: its label fields and the fence trust marker line. */
function labels(results: unknown): Array<Record<string, unknown>> {
  return (results as Array<Record<string, unknown>>)
    .filter(r => r.slug === SLUG && String(r.chunk ?? '').includes('gbrain:facts:begin'))
    .map(r => ({ trust_tier: r.trust_tier ?? null, origin: r.origin ?? null, unconfirmed: r.unconfirmed ?? null, contested: r.contested ?? null }));
}

describe('engine parity: the fence-row trust of recall and synthesize', () => {
  parityTest('recall with a query labels a fence chunk by its rows\' newest live facts: lowest tier, a flag and a pending supersede proposal', {
    methods: ['putPage', 'deleteFactsForPage', 'insertFacts', 'expireFact', 'upsertWriteGateReceipt', 'insertTrustProposal', 'listFenceRowTrust'],
  }, async (engine) => {
    await seed(engine);
    const { isError, body } = await call(engine, 'recall', { query: 'harbor ledger tide table moorings dawn' });
    const out = { isError, error: isError ? body.error : null, labels: isError ? [] : labels(body.results) };
    expect(out.isError).toBe(false);
    // The page is operator-curated; its fence chunk takes row 2's agent-written tier and flag. Row 4's lower tier is
    // expired, so it lowers nothing.
    expect(out.labels).toEqual([{ trust_tier: 'agent_written', origin: FENCE_TRUST_ORIGIN, unconfirmed: true, contested: null }]);
    return out;
  });

  parityTest('keyless synthesize over a page with fence rows answers the protocol error unavailable with a suggestion', {
    methods: ['putPage', 'deleteFactsForPage', 'insertFacts', 'expireFact', 'upsertWriteGateReceipt', 'insertTrustProposal', 'listFenceRowTrust'],
  }, async (engine) => {
    // The gather runs before the key check (verbs.ts synthesize): a page with fence rows reaches listFenceRowTrust first.
    await seed(engine);
    resetGateway();
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() },
      () => call(engine, 'synthesize', { question: 'what does the harbor ledger say?' }));
    const out = { isError, error: body.error, protocol_version: body.protocol_version, suggestion: typeof body.suggestion === 'string' && body.suggestion.trim().length > 0 };
    expect(out).toEqual({ isError: true, error: 'unavailable', protocol_version: 1, suggestion: true });
    return out;
  });

  parityTest('synthesize for a world-only caller sends the fence chunk to the model under its rows\' current trust labels', {
    methods: ['putPage', 'deleteFactsForPage', 'insertFacts', 'expireFact', 'upsertWriteGateReceipt', 'insertTrustProposal', 'listFenceRowTrust'],
  }, async (engine) => {
    await seed(engine);
    const prompts: string[] = [];
    __setChatTransportForTests(async (opts) => {
      prompts.push(JSON.stringify(opts));
      return { text: JSON.stringify({ answer: 'The ledger answer.', citations: [], gaps: ['none'] }), blocks: [], stopReason: 'end' as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic' };
    });
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' },
      () => call(engine, 'synthesize', { question: 'what does the harbor ledger say about the tide table?' }));
    const sent = prompts.join('\n');
    // The prompt's page tag carries the trust a reader of the evidence sees (think/index.ts renderThinkPages).
    const tags = [...sent.matchAll(/<page slug=\\"([^\\"]+)\\"[^>]*?trust=\\"([^\\"]+)\\"(?: origin=\\"([^\\"]+)\\")?/g)]
      .map(m => ({ slug: m[1], trust: m[2], origin: m[3] ?? null }));
    const out = { isError, error: isError ? body.error : null, answer: body.answer ?? null, tags };
    expect(out).toEqual({ isError: false, error: null, answer: 'The ledger answer.',
      tags: [{ slug: SLUG, trust: 'agent_written', origin: FENCE_TRUST_ORIGIN }] });
    return out;
  });
  parityTest('listFenceRowTrust reads the newest live fact at each fence row: its tier, its activation flag and its pending supersede proposal', {
    methods: ['putPage', 'deleteFactsForPage', 'insertFacts', 'expireFact', 'upsertWriteGateReceipt', 'insertTrustProposal', 'listFenceRowTrust'],
  }, async (engine) => {
    await seed(engine);
    const key = (row_num: number, slug = SLUG, source_id = 'default') => ({ source_id, slug, row_num });
    const rows = await engine.listFenceRowTrust([key(3), key(1), key(2), key(4), key(1), key(7), key(1, 'notes/other'), key(1, SLUG, 'elsewhere')]);
    const out = { rows: rows.map(r => ({ ...r, contested: r.contested?.replace(/^tp\d+:/, 'tp:') ?? null }))
      .sort((a, b) => a.row_num - b.row_num), none: await engine.listFenceRowTrust([]) };
    expect(out).toEqual({ rows: [
      { source_id: 'default', slug: SLUG, row_num: 1, trust_tier: 'operator_curated', flagged: false, contested: null },
      { source_id: 'default', slug: SLUG, row_num: 2, trust_tier: 'agent_written', flagged: true, contested: null },
      { source_id: 'default', slug: SLUG, row_num: 3, trust_tier: 'tool_observed', flagged: false, contested: 'tp:challenged' },
    ], none: [] });
    return out;
  });
});
