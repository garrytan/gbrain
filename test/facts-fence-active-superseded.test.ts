/**
 * An active facts-fence row is never linked as superseded, whatever its context cell says.
 *
 * 1. Protects: parseFactsFence reads `superseded by #N` in the context cell as a supersession link only on a
 *    struck row (`~~claim~~`), the same rule it already applies to `forgotten:`. An unstruck row stays a live
 *    fact: facts.superseded_by is NULL after extract_facts and the fact is in recall's candidate pool.
 * 2. Fails when: an unstruck row whose context mentions `superseded by #N` gets facts.superseded_by set (on
 *    first reconcile, when a struck row is reinstated by removing the strikethrough, or when a fact is written
 *    with that context), which hides it from every read that filters `superseded_by IS NULL`.
 * 3. Existing coverage: facts-fence and extract-facts-phase pin struck rows with the context note and active
 *    rows without it; nothing pinned an active row that carries the note.
 * 4. Real seams: PGLite, putPage, runExtractFacts, writeFactsToFence on a temp brain directory and
 *    collectFactCandidates; no provider calls (keyword arm only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { collectFactCandidates } from '../src/core/search/fact-relevance.ts';

let engine: PGLiteEngine;
const SLUG = 'people/deal-example';

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => { await resetPgliteState(engine); }, 60_000);

const page = (rows: string): string => `# Deal

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

const ROW_2 = '| 2 | Closed in Q3 | fact | 1.0 | world | high | 2026-07-01 |  | call |  |';
const STRUCK = `| 1 | ~~Will close by Q2~~ | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #2 |\n${ROW_2}`;
const ACTIVE = `| 1 | Will close by Q2 | commitment | 0.6 | world | medium | 2026-01-01 |  | call | superseded by #2 |\n${ROW_2}`;

async function reconcile(rows: string): Promise<void> {
  await engine.putPage(SLUG, { title: 'Deal', type: 'person', compiled_truth: page(rows), frontmatter: {}, timeline: '' });
  await runExtractFacts(engine, { slugs: [SLUG] });
}

async function row1(rowNum = 1): Promise<{ superseded: boolean; expired: boolean }> {
  const [r] = await engine.executeRaw<{ superseded: boolean; expired: boolean }>(
    `SELECT superseded_by IS NOT NULL AS superseded, expired_at IS NOT NULL AS expired FROM facts WHERE source_markdown_slug = $1 AND row_num = $2`, [SLUG, rowNum]);
  return r!;
}

async function recalled(): Promise<string[]> {
  const pool = await collectFactCandidates(engine, 'close Q2', { sourceId: 'default', remote: false, excludePrivate: false }, null,
    { depth: { keyword: 20, cosine: 0, entity: 0 } });
  return pool.candidates.map(c => c.fact);
}

describe('an active fence row whose context says "superseded by #N"', () => {
  test('the parser links only a struck row', () => {
    const struck = parseFactsFence(page(STRUCK));
    expect(struck.warnings).toEqual([]);
    expect({ active: struck.facts[0]!.active, supersededBy: struck.facts[0]!.supersededBy }).toEqual({ active: false, supersededBy: 2 });
    const active = parseFactsFence(page(ACTIVE));
    expect(active.warnings).toEqual([]);
    expect({ active: active.facts[0]!.active, supersededBy: active.facts[0]!.supersededBy }).toEqual({ active: true, supersededBy: undefined });
    expect(active.facts[0]!.context).toBe('superseded by #2');
  });

  test('first reconcile leaves the row live, unlinked and recallable', async () => {
    await reconcile(ACTIVE);
    expect(await row1()).toEqual({ superseded: false, expired: false });
    expect(await recalled()).toContain('Will close by Q2');
  }, 60_000);

  test('reinstating a superseded row by removing the strikethrough clears its link', async () => {
    await reconcile(STRUCK);
    expect((await row1()).superseded).toBe(true);
    await reconcile(ACTIVE);
    expect(await row1()).toEqual({ superseded: false, expired: false });
    expect(await recalled()).toContain('Will close by Q2');
  }, 60_000);

  test('a fact written with that context lands live, unlinked and recallable', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-fence-active-superseded-'));
    try {
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
      const target = { sourceId: 'default', localPath: brainDir, slug: SLUG, resolutionSource: 'exact_page' as const };
      const input = (fact: string, context?: string): FenceInputFact => ({ fact, kind: 'fact', notability: 'high', source: 'call', visibility: 'world',
        confidence: 1.0, validFrom: new Date(Date.UTC(2026, 0, 1)), embedding: null, sessionId: null, ...(context ? { context } : {}) });
      expect((await writeFactsToFence(engine, target, [input('Closed in Q3')])).inserted).toBe(1);
      expect((await writeFactsToFence(engine, target, [input('Will close by Q2', 'superseded by #1')])).inserted).toBe(1);
      expect(await row1(2)).toEqual({ superseded: false, expired: false });
      expect(await recalled()).toContain('Will close by Q2');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);
});
