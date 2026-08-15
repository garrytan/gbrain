/**
 * Write-back fidelity THROUGH THE ADAPTERS (cathedral-4, deterministic).
 *
 * The BrainBench write-back suite renders normalized fixture turns directly —
 * it never exercises raw-format parsing, detection, redaction, or the
 * importer. This e2e closes that gap in-repo: raw fixture FILES (a codex
 * rollout and an openclaw session) enter via runTranscriptsIngest
 * (parse → redact → render → import), then the SHIPPED extractor core runs
 * with an injected GOLD extractor (the BrainBench decision-15 seam — zero
 * LLM calls), and planted facts are probed in the facts table with
 * provenance intact. Cross-harness continuity: facts from BOTH harnesses'
 * sessions coexist in one source, queryable together.
 *
 * The full BrainBench raw-fixture schema (sidecar type + loader + corpus-hash
 * coverage + baseline re-cut) lives in the sibling gbrain-evals repo and is a
 * filed follow-up; this test is the in-repo fidelity pin.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import type { ExtractInput, ExtractedFact } from '../../src/core/facts/extract.ts';

const CODEX_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'codex-rollout.jsonl');
const AGENT_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'agent-session.jsonl');

/** Gold facts planted in the raw fixtures, keyed by a probe substring. */
const GOLD: Array<{ probe: string; fact: string; entity_slug: string | null }> = [
  { probe: 'fund-a led the widget-co seed', fact: 'fund-a led the widget-co seed round', entity_slug: 'widget-co' },
  { probe: 'bridge check-in', fact: 'the bridge check-in happens every Thursday', entity_slug: null },
  { probe: 'acme-seed memo', fact: 'alice-example is drafting the acme-seed memo', entity_slug: 'alice-example' },
];

/** Deterministic gold extractor: emits gold facts whose probe is in the segment. */
async function goldExtractor(input: ExtractInput): Promise<ExtractedFact[]> {
  return GOLD.filter((g) => input.turnText.includes(g.probe)).map((g) => ({
    fact: g.fact,
    kind: 'event',
    source: input.source,
    confidence: 0.95,
    notability: 'medium',
    entity_slug: g.entity_slug,
  })) as ExtractedFact[];
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('write-back fidelity through the adapter path', () => {
  test('raw codex + openclaw files → pages → gold extraction → facts with provenance', async () => {
    const ingest = await runTranscriptsIngest(engine, {
      paths: [CODEX_FIXTURE, AGENT_FIXTURE],
      sourceId: 'default',
      userPatternsPath: '/nonexistent-patterns.txt',
    });
    expect(ingest.sessionsImported).toBe(2);

    const extract = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slugs: [...new Set(ingest.slugsTouched)],
      extractor: goldExtractor,
      overrideDisabled: true,
    });
    expect(extract.pages_processed).toBe(2);
    expect(extract.facts_inserted).toBeGreaterThanOrEqual(GOLD.length);

    // Probe survival + provenance via the raw facts table (deterministic read).
    const facts = await engine.executeRaw<{ fact: string; source: string; source_markdown_slug: string }>(
      `SELECT fact, source, source_markdown_slug FROM facts
       WHERE source_id = 'default' AND source LIKE 'cli:extract-conversation-facts%'`,
    );
    for (const g of GOLD) {
      const hit = facts.find((f) => f.fact === g.fact);
      expect(hit).toBeTruthy();
      // Provenance points back at an imported conversation page.
      expect(hit!.source_markdown_slug).toMatch(/^conversations\/sessions\//);
    }

    // CROSS-HARNESS CONTINUITY: one source holds facts grounded in BOTH
    // harnesses' sessions — "what did I decide, in whichever agent I said it".
    const slugsWithFacts = new Set(facts.map((f) => f.source_markdown_slug));
    expect([...slugsWithFacts].some((s) => s.includes('-codex-'))).toBe(true);
    expect([...slugsWithFacts].some((s) => s.includes('-openclaw-'))).toBe(true);
  });

  test('re-extraction is deduped by the durable-outcome gate (no double facts)', async () => {
    const ingest = await runTranscriptsIngest(engine, {
      paths: [CODEX_FIXTURE],
      sourceId: 'default',
      userPatternsPath: '/nonexistent-patterns.txt',
    });
    const slugs = [...new Set(ingest.slugsTouched)];
    const first = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slugs,
      extractor: goldExtractor,
      overrideDisabled: true,
    });
    expect(first.facts_inserted).toBeGreaterThan(0);
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slugs,
      extractor: goldExtractor,
      overrideDisabled: true,
    });
    expect(second.facts_inserted).toBe(0);
    expect(second.pages_skipped_completed).toBe(1);
  });
});
