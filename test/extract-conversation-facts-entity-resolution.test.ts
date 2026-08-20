/**
 * Conversation backfill save-time resolution against the shipped
 * alias_exact cascade (v0.46.15 / #3730).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  extractConversationFactsFingerprint,
  PER_SEGMENT_SOURCE_PREFIX,
  runExtractConversationFactsCore,
  TERMINAL_AUDIT_SOURCE,
} from '../src/commands/extract-conversation-facts.ts';
import {
  BudgetExhausted,
  BudgetTracker,
} from '../src/core/budget/budget-tracker.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';
import * as resolve from '../src/core/entities/resolve.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { loadOpCheckpoint } from '../src/core/op-checkpoint.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

function message(name: string, date: string, time: string, body: string): string {
  return `**${name}** (${date} ${time}): ${body}`;
}

const ONE_SEGMENT_BODY = [
  message('Alpha Example', '2026-08-12', '10:00 AM', 'The role was accepted.'),
  message('Beta Example', '2026-08-12', '10:01 AM', 'Congratulations.'),
].join('\n');

const TWO_SEGMENT_BODY = [
  message('Alpha Example', '2026-08-12', '10:00 AM', 'First segment.'),
  message('Beta Example', '2026-08-12', '10:01 AM', 'Still first.'),
  message('Alpha Example', '2026-08-12', '11:00 AM', 'Second segment.'),
  message('Beta Example', '2026-08-12', '11:01 AM', 'Still second.'),
].join('\n');

const extractedFacts: ExtractedFact[] = [
  {
    fact: 'Brian accepted the role',
    kind: 'event',
    entity_slug: 'Brian',
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  },
  {
    fact: 'An unlisted person attended',
    kind: 'event',
    entity_slug: 'Unlisted Person',
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  },
  {
    fact: 'The weather was clear',
    kind: 'fact',
    entity_slug: null,
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'low',
  },
];

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
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  await seedConversation(ONE_SEGMENT_BODY);
});

async function seedConversation(body: string): Promise<void> {
  await engine.putPage('sessions/example', {
    type: 'conversation',
    title: 'Example conversation',
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
  });
  await engine.putPage('people/brian-example', {
    type: 'person',
    title: 'Brian Example',
    compiled_truth: '# Brian Example',
    timeline: '',
    frontmatter: {},
  });
  await engine.setPageAliases('people/brian-example', 'default', ['brian']);
}

function extractorFor(...batches: ExtractedFact[][]) {
  let index = 0;
  return async (): Promise<ExtractedFact[]> =>
    (batches[index++] ?? []).map((row) => ({ ...row }));
}

async function checkpointEntries(): Promise<string[]> {
  return loadOpCheckpoint(engine, {
    op: 'extract-conversation-facts',
    fingerprint: extractConversationFactsFingerprint({ sourceId: 'default' }),
  });
}

async function dataEntities(): Promise<Array<string | null>> {
  const rows = await engine.executeRaw<{ entity_slug: string | null }>(
    `SELECT entity_slug
       FROM facts
      WHERE source = $1
        AND source_markdown_slug = 'sessions/example'
      ORDER BY row_num`,
    [PER_SEGMENT_SOURCE_PREFIX],
  );
  return rows.map((row) => row.entity_slug);
}

async function terminalCount(): Promise<number> {
  const rows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*) AS count
       FROM facts
      WHERE source = $1
        AND source_markdown_slug = 'sessions/example'`,
    [TERMINAL_AUDIT_SOURCE],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('conversation backfill entity resolution', () => {
  test('canonicalizes aliases via alias_exact, preserves null, and counts fallback slugification', async () => {
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'sessions/example',
        types: ['conversation'],
        sleepMs: 0,
        extractor: extractorFor(extractedFacts),
      });

      expect(await dataEntities()).toEqual([
        'people/brian-example',
        'unlisted-person',
        null,
      ]);
      expect(result.fallback_slugify_count).toBe(1);
      expect(result.resolution_errors).toBe(0);
      expect(result.facts_inserted).toBe(3);
      expect(await terminalCount()).toBe(1);

      const stderr = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderr).toContain(
        'entity_resolution_counts={"alias_exact":1,"fallback_slugify":1}',
      );
      expect(stderr).not.toContain('alias_match');
      expect(stderr).not.toContain('alias_redirect');
    } finally {
      writeSpy.mockRestore();
    }
  });

  test('a lowercase hyphenated display form still hits page_aliases', async () => {
    await engine.putPage('people/kendall-example', {
      type: 'person',
      title: 'Kendall Example',
      compiled_truth: '# Kendall Example',
      timeline: '',
      frontmatter: {},
    });
    await engine.setPageAliases('people/kendall-example', 'default', [
      'kendall',
      'kendall-example',
    ]);

    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'sessions/example',
      types: ['conversation'],
      sleepMs: 0,
      extractor: extractorFor([
        {
          fact: 'Kendall joined the call',
          kind: 'event',
          entity_slug: 'kendall',
          source: 'test',
          source_session: null,
          confidence: 1,
          notability: 'medium',
        },
        {
          fact: 'Kendall Example spoke again',
          kind: 'event',
          entity_slug: 'kendall-example',
          source: 'test',
          source_session: null,
          confidence: 1,
          notability: 'medium',
        },
      ]),
    });

    expect(await dataEntities()).toEqual([
      'people/kendall-example',
      'people/kendall-example',
    ]);
    expect(result.fallback_slugify_count).toBe(0);
    expect(result.resolution_errors).toBe(0);
  });

  test('a deleted page alias falls through instead of stamping a dead target', async () => {
    await engine.putPage('people/ghost-example', {
      type: 'person',
      title: 'Ghost Example',
      compiled_truth: '# Ghost Example',
      timeline: '',
      frontmatter: {},
    });
    await engine.setPageAliases('people/ghost-example', 'default', ['spectre']);
    await engine.softDeletePage('people/ghost-example');

    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'sessions/example',
      types: ['conversation'],
      sleepMs: 0,
      extractor: extractorFor([{
        fact: 'A ghost was mentioned',
        kind: 'event',
        entity_slug: 'Spectre',
        source: 'test',
        source_session: null,
        confidence: 1,
        notability: 'medium',
      }]),
    });

    expect(await dataEntities()).toEqual(['spectre']);
    expect(result.fallback_slugify_count).toBe(1);
  });

  test('best-effort resolver failure keeps the raw value and later segments checkpoint', async () => {
    await seedConversation(TWO_SEGMENT_BODY);
    const original = resolve.resolveEntitySlugWithSource;
    const spy = spyOn(resolve, 'resolveEntitySlugWithSource').mockImplementation(
      async (eng, sourceId, raw) => {
        if (raw === 'Unlisted Person') {
          throw new Error('resolver unavailable for unlisted person');
        }
        return original(eng, sourceId, raw);
      },
    );
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'sessions/example',
        types: ['conversation'],
        sleepMs: 0,
        extractor: extractorFor(
          [extractedFacts[0]],
          [extractedFacts[1], extractedFacts[0], extractedFacts[2]],
        ),
      });

      expect(await dataEntities()).toEqual([
        'people/brian-example',
        'Unlisted Person',
        'people/brian-example',
        null,
      ]);
      expect(result.resolution_errors).toBe(1);
      expect(result.fallback_slugify_count).toBe(0);
      expect(result.segments_processed).toBe(2);
      expect(result.facts_inserted).toBe(4);
      expect(result.pages_processed).toBe(1);
      expect(await checkpointEntries()).toContain(
        'default|sessions/example|2026-08-12T11:01:00Z',
      );
      expect(await terminalCount()).toBe(1);

      const stderr = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderr).toContain('entity resolution failed for "Unlisted Person"');
      expect(stderr).toContain('keeping raw value');
    } finally {
      spy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test('BudgetExhausted from resolution halts without becoming a resolution error', async () => {
    const spy = spyOn(resolve, 'resolveEntitySlugWithSource').mockImplementation(
      async () => {
        throw new BudgetExhausted('resolver budget exhausted', {
          reason: 'cost',
          spent: 2,
          cap: 1,
        });
      },
    );
    try {
      const tracker = new BudgetTracker({ maxCostUsd: 1, label: 'track1-resolution' });
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'sessions/example',
        types: ['conversation'],
        sleepMs: 0,
        budgetTracker: tracker,
        extractor: extractorFor(extractedFacts),
      });

      expect(result.budget_exhausted).toBeTrue();
      expect(result.resolution_errors).toBe(0);
      expect(result.facts_inserted).toBe(0);
      expect(await dataEntities()).toEqual([]);
      expect(await terminalCount()).toBe(0);
      expect(await checkpointEntries()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('failed data insert writes no terminal or telemetry and retries cleanly', async () => {
    const originalInsertFacts = engine.insertFacts.bind(engine);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      engine.insertFacts = async (facts, opts) => {
        if (facts.some((row) => row.source === PER_SEGMENT_SOURCE_PREFIX)) {
          throw new Error('constraint sentinel');
        }
        return originalInsertFacts(facts, opts);
      };
      await expect(runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'sessions/example',
        types: ['conversation'],
        sleepMs: 0,
        extractor: extractorFor(extractedFacts),
      })).rejects.toThrow('constraint sentinel');

      expect(await dataEntities()).toEqual([]);
      expect(await terminalCount()).toBe(0);
      expect(await checkpointEntries()).toEqual([]);
      const failedStderr = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(failedStderr).not.toContain('entity_resolution_counts=');
      engine.insertFacts = originalInsertFacts;

      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'sessions/example',
        types: ['conversation'],
        sleepMs: 0,
        extractor: extractorFor(extractedFacts),
      });
      expect(result.facts_inserted).toBe(3);
      expect(result.fallback_slugify_count).toBe(1);
      expect(result.resolution_errors).toBe(0);
      expect(await terminalCount()).toBe(1);
      expect(await checkpointEntries()).toContain(
        'default|sessions/example|2026-08-12T10:01:00Z',
      );
    } finally {
      engine.insertFacts = originalInsertFacts;
      writeSpy.mockRestore();
    }
  });

  test('cycle propagates an abort instead of aggregating it as a source warning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runPhaseConversationFactsBackfill(engine, {
      signal: controller.signal,
      dryRun: true,
    })).rejects.toThrow('aborted');
  });
});
