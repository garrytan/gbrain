/**
 * A held `fence_absent` generation is answered by a fence that parses again. When the page's fence parses and the
 * stored rows already match it (nothing to retire, insert or update), the reconcile used to return before asking the
 * generation primitive, so the hold stayed forever (doctor `generation_held` never cleared).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { emptyFenceBlock } from '../src/core/generations/fence.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const FENCED = `# Page

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | seeded | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |
<!--- gbrain:facts:end -->
`;

async function put(body: string): Promise<void> {
  await engine.putPage('people/alice', { title: 'alice', type: 'person', compiled_truth: body, frontmatter: {}, timeline: '' });
}

async function heldReasons(): Promise<string[]> {
  const res = await engine.executeRaw<{ held_reason: string }>(
    `SELECT held_reason FROM derived_generations WHERE kind = 'fact_fence' AND owner_key = $1 AND state = 'held'`, ['page:people/alice']);
  return res.map(row => row.held_reason);
}

describe('extract_facts clears a fence_absent hold once the fence parses', () => {
  test('an in-sync empty fence answers the hold', async () => {
    await put(FENCED);
    await runExtractFacts(engine, { slugs: ['people/alice'] });
    await put('# Page\n\nNo fence.\n');
    await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(await heldReasons()).toEqual(['fence_absent']);

    // The held row is gone by another route, so the empty fence has nothing left to retire.
    await engine.executeRaw(`DELETE FROM facts WHERE source_markdown_slug = 'people/alice'`);
    await put(`# Page\n\n${emptyFenceBlock('facts')}`);
    await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(await heldReasons()).toEqual([]);
  });
});
