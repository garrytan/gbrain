/**
 * BrainEngine parity — staging a segmented page whose body has world facts-fence rows (page-body/ingest.ts
 * `stageSegmentedImport`, through `stageOccurrenceChunks` and the fence overlay `readFenceOverlayRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: staging a new segmented page whose body holds a facts fence of world rows gives the same staged
 *    chunks, row counts and staging state on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust
 *    arm with GBRAIN_TEST_RUST_ARM=1): a row a write-gate hold names is left out of the chunk text, a row written below
 *    the page's trust tier moves to the low-tier block, and a row with no stored fact stays.
 *  - Regression: the overlay was a raw `executeRaw` query, which the Rust engine refuses, so a segmented page with
 *    world fact rows could not be staged on a Rust brain while the SQL engines staged it.
 *  - Why existing coverage misses it: fence-overlay.test.ts reads the overlay on its own and segmented-body.test.ts
 *    stages bodies with no facts fence, so no case ran the staging with fence rows in the body.
 *  - Seam: none. Real engines, the real staging function and typed methods only. The seed holds, facts and page tier
 *    use the same typed writes as fence-overlay.test.ts. Page ids, occurrence ids and staging ids are folded out.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { holdFingerprint } from '../../src/core/write-gate-store.ts';
import { fenceRowHoldTexts } from '../../src/core/eligibility/fence-overlay.ts';
import { stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/staged-example';

const row = (rowNum: number, claim: string): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: '2024-01-01', source: 'user', active: true,
});
const ROWS = [row(1, 'Ana lives in Lima'), row(2, 'Ana sings opera'), row(3, 'Ana rides horses')];
const BODY = `Ana Example runs acme-example.\n\n## Facts\n\n${renderFactsTable(ROWS)}\n`;

/** Run `fn` in a transaction whose write trust context declares `tier` and `origin`. */
function declaredWrite(engine: BrainEngine, tier: string, origin: Record<string, unknown>, fn: (tx: BrainEngine) => Promise<unknown>) {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify(origin)]);
    return fn(tx);
  });
}

describe('engine parity: staging a segmented page with world fact rows', () => {
  parityTest('a new segmented page with world fence rows stages the same chunks', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'upsertWriteGateHold', 'readFenceOverlayRows',
      'openBodyStaging', 'stageSegmentTexts', 'allocateBodyOccurrenceIds', 'readSegmentTexts', 'readPageSnapshot', 'setBodyStagingState'],
  }, async (engine) => {
    await declaredWrite(engine, 'tool_observed', { channel: 'tool' }, tx =>
      tx.putPage(SLUG, { type: 'person', title: 'Ana Example', compiled_truth: BODY, timeline: '' }));
    // Row 1 has a fact written below the page's tier; row 2 is held by a write-gate hold; row 3 has no stored fact.
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => tx.insertFacts([{
      fact: ROWS[0]!.claim, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: 1, kind: 'fact', visibility: 'world', source: 'fence',
    }] as never, { source_id: SRC }));
    await engine.upsertWriteGateHold({
      kind: 'fact', source_id: SRC, slug: SLUG, fingerprint: holdFingerprint('fact', fenceRowHoldTexts(ROWS[1]!)), detector_version: 1, tier: 'agent_written',
      reason_families: ['override'], reasons: ['override found'], detector_error: false, payload: { row_num: 2, fact: ROWS[1]!.claim },
      write_origin: null, request_id: null,
    } as never);
    const staged = await stageSegmentedImport(engine, {
      slug: SLUG, sourceId: SRC, existing: null, baseRevision: null,
      page: { title: 'Ana Example', type: 'person', compiled_truth: BODY, timeline: '', frontmatter: {}, tags: [] },
      policy: {} as never, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' },
    });
    const { prepared } = staged;
    const chunks = (prepared.createChunks?.chunks ?? []).map(c => ({ text: c.chunk_text, source: c.chunk_source }));
    const text = chunks.map(c => c.text).join('\n');
    expect(text).not.toContain('Ana sings opera');
    expect(text).toContain('Ana rides horses');
    return { newGeneration: prepared.newGeneration, rows: prepared.rows, unchunked: prepared.unchunked, chunks };
  });
});
