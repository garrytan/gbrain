/**
 * BrainEngine parity — a fenced import on a source with fact purge tombstones (import-file.ts `importFromContent`,
 * facts/purge-overlay.ts `dropPurgedFenceRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: importing a page whose facts fence holds a purged claim stores the page without that row, and no
 *    chunk of the page holds it. A tombstone applies at its own visibility, under subject '*' or the page's
 *    slug; a tombstone of another subject or another visibility drops nothing. The other rows keep their row numbers.
 *  - Regression: the overlay's source probe (`sourceHasPurges`) ran through `executeRaw`, which the Rust engine
 *    refuses, so every fenced import on a Rust source with a purge stopped before it saved the page.
 *  - Why existing coverage misses it: test/engine-parity/take-purge-overlay.test.ts calls the overlay directly with
 *    takes only, withdrawal-fence.test.ts covers a malformed fence, and test/purge-overlay-reservations.test.ts runs
 *    PGLite only. No case ran a whole fenced import over a fact purge on every arm.
 *  - Seam: none. Real engines, typed methods only. The tombstones' fingerprints come from facts of a scratch page,
 *    as purge_fact reads them (loadPurgeTarget); no generated id is compared.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/fenced-import-example';
const OTHER = 'people/other-fenced-import-example';
const SCRATCH = 'people/fingerprint-scratch-example';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964ac';

/** The claim's fingerprint, read the way purge_fact reads it, from a fact of a scratch page. */
async function fingerprintOf(engine: BrainEngine, rowNum: number, claim: string, visibility: 'world' | 'private'): Promise<string> {
  const out = await engine.insertFacts([{ fact: claim, entity_slug: SCRATCH, source_markdown_slug: SCRATCH, row_num: rowNum, kind: 'fact',
    visibility, source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
  return (await engine.loadPurgeTarget(out.ids[0]!, SRC))!.fact_hash;
}

async function tombstone(engine: BrainEngine, visibility: 'world' | 'private', subject: string, rowNum: number, claim: string): Promise<void> {
  await engine.insertFactPurge({ sourceId: SRC, visibility, subject, factHash: await fingerprintOf(engine, rowNum, claim, visibility),
    requestId: REQUEST, actor: 'owner:local', reason: 'parity' });
}

const row = (n: number, claim: string, visibility: string) =>
  `| ${n} | ${claim} | preference | 1.0 | ${visibility} | medium | 2026-01-01 |  | chat |  |`;

const page = `---
type: person
title: Fenced Import Example
---

# Fenced Import Example

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${row(1, 'Prefers email', 'world')}
${row(2, 'Plays chess', 'world')}
${row(3, 'Has a budget', 'world')}
${row(4, 'Has a garden', 'private')}
${row(5, 'Lives in Lisbon', 'world')}
<!--- gbrain:facts:end -->
`;

describe('engine parity: a fenced import over fact purges', () => {
  parityTest('importFromContent drops the fence rows a tombstone covers at its visibility, for subject * or the page', {
    methods: ['insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'readSourcePurgeFlags', 'getPage', 'getChunks'],
    timeout: 60_000,
  }, async (engine) => {
    await tombstone(engine, 'world', '*', 1, 'Prefers email');
    await tombstone(engine, 'world', OTHER, 2, 'Plays chess');
    await tombstone(engine, 'private', SLUG, 3, 'Has a budget');
    await tombstone(engine, 'private', SLUG, 4, 'Has a garden');
    const flags = await engine.readSourcePurgeFlags(SRC);
    expect(flags).toEqual({ facts: true, takes: false });
    const result = await importFromContent(engine, SLUG, page, { sourceId: SRC });
    expect(result.status).toBe('imported');
    const stored = await engine.getPage(SLUG, { sourceId: SRC });
    expect(stored).not.toBeNull();
    const fence = parseFactsFence(stored!.compiled_truth).facts.map((f) => ({ row_num: f.rowNum, claim: f.claim, visibility: f.visibility }));
    expect(fence).toEqual([
      { row_num: 2, claim: 'Plays chess', visibility: 'world' },
      { row_num: 3, claim: 'Has a budget', visibility: 'world' },
      { row_num: 5, claim: 'Lives in Lisbon', visibility: 'world' },
    ]);
    // The chunks are cut from the stored text, so no purged claim reaches search either.
    const chunks = (await engine.getChunks(SLUG, { sourceId: SRC })).map((c) => c.chunk_text);
    expect(chunks.join('\n')).toContain('Lives in Lisbon');
    for (const purged of ['Prefers email', 'Has a garden']) expect(chunks.join('\n')).not.toContain(purged);
    return { flags, status: result.status, fence, chunks };
  });
});
