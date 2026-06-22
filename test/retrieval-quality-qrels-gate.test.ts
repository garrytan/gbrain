import { describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { evaluateRetrievalQualityQrelsGate } from '../src/core/evaluation/retrieval-quality-gate.ts';
import { readContext } from '../src/core/services/read-context-service.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { SearchResult } from '../src/core/types.ts';

interface QrelsFixture {
  fixture_id: string;
  thresholds: {
    top1_match_rate: number;
    recall_at_10: number;
  };
  pages: Array<{
    slug: string;
    type: SearchResult['type'];
    title: string;
    content: string;
  }>;
  cases: Array<{
    id: string;
    query: string;
    gold_slugs: string[];
    candidate_slugs: string[];
  }>;
}

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/source-aware-retrieval-quality-qrels.json', import.meta.url),
  'utf8',
)) as QrelsFixture;

async function withEngine<T>(fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieval-quality-qrels-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function pageBySlug(slug: string): QrelsFixture['pages'][number] {
  const page = fixture.pages.find((entry) => entry.slug === slug);
  if (!page) throw new Error(`missing fixture page for ${slug}`);
  return page;
}

function candidateSearchForCase(testCase: QrelsFixture['cases'][number]) {
  return async (query: string): Promise<SearchResult[]> => {
    if (query !== testCase.query) return [];
    return testCase.candidate_slugs.map((slug, index) => {
      const page = pageBySlug(slug);
      return {
        slug,
        page_id: index + 1,
        title: page.title,
        type: page.type,
        chunk_text: page.content,
        chunk_source: 'compiled_truth',
        score: testCase.candidate_slugs.length - index,
        stale: false,
      };
    });
  };
}

// Note: this gate injects pre-ranked candidate lists to exercise selection/ranking math
// over the read path; it does NOT measure recall over a real index. Production-path recall
// (including the hybrid vector leg) is guarded by test/retrieval-recall-harness.test.ts.
describe('source-aware retrieval quality selection gate (pre-ranked candidates; not a recall measure)', () => {
  test('evaluates candidate slugs and reads the selected gold selector snapshot', async () => {
    await withEngine(async (engine) => {
      for (const page of fixture.pages) {
        await importFromContent(engine, page.slug, page.content, { path: `${page.slug}.md` });
      }

      const runs = [];
      for (const testCase of fixture.cases) {
        const retrieval = await retrieveContext(engine, {
          query: testCase.query,
          include_orientation: false,
          limit: 10,
        }, {
          candidateSearch: candidateSearchForCase(testCase),
        });
        const candidateSlugs = retrieval.candidates
          .map((candidate) => candidate.read_selector.slug)
          .filter((slug): slug is string => Boolean(slug));

        runs.push({
          id: testCase.id,
          query: testCase.query,
          gold_slugs: testCase.gold_slugs,
          candidate_slugs: candidateSlugs,
        });

        if (testCase.id === 'source-aware-top-hit') {
          expect(candidateSlugs[0]).toBe(testCase.gold_slugs[0]);
          const selectedSnapshots = retrieval.read_plan.selected_selector_snapshots ?? [];
          expect(selectedSnapshots[0]?.slug).toBe(testCase.gold_slugs[0]);

          const read = await readContext(engine, {
            query: testCase.query,
            selectors: [selectedSnapshots[0]!],
            max_selectors: 1,
          });

          expect(read.canonical_reads).toHaveLength(1);
          expect(read.canonical_reads[0]!.selector.slug).toBe(testCase.gold_slugs[0]);
          expect(read.canonical_reads[0]!.text).toContain(
            'The qrels gate evaluates candidates by canonical slug instead of raw snippets.',
          );
        }
      }

      const report = evaluateRetrievalQualityQrelsGate({
        fixture_id: fixture.fixture_id,
        thresholds: fixture.thresholds,
        cases: runs,
      });

      expect(report).toEqual({
        fixture_id: 'source-aware-retrieval-quality-qrels',
        status: 'passed',
        thresholds: {
          top1_match_rate: 0.66,
          recall_at_10: 1,
        },
        top1_match_rate: 2 / 3,
        recall_at_10: 1,
        cases: [
          {
            id: 'source-aware-top-hit',
            query: 'source aware retrieval qrels gate',
            status: 'passed',
            gold_slugs: ['systems/source-aware-retrieval'],
            candidate_slugs: [
              'systems/source-aware-retrieval',
              'concepts/queue-routing',
              'systems/runtime-platform',
            ],
            top1_slug: 'systems/source-aware-retrieval',
            top1_match: true,
            recall_at_10: 1,
            missing_gold_slugs: [],
          },
          {
            id: 'queue-routing-top-hit',
            query: 'queue routing worker lane retries',
            status: 'passed',
            gold_slugs: ['concepts/queue-routing'],
            candidate_slugs: [
              'concepts/queue-routing',
              'systems/runtime-platform',
              'systems/source-aware-retrieval',
            ],
            top1_slug: 'concepts/queue-routing',
            top1_match: true,
            recall_at_10: 1,
            missing_gold_slugs: [],
          },
          {
            id: 'queue-routing-recall-only',
            query: 'operational dispatch platform',
            status: 'failed',
            gold_slugs: ['concepts/queue-routing'],
            candidate_slugs: [
              'systems/runtime-platform',
              'concepts/queue-routing',
              'systems/source-aware-retrieval',
            ],
            top1_slug: 'systems/runtime-platform',
            top1_match: false,
            recall_at_10: 1,
            missing_gold_slugs: [],
          },
        ],
        failures: [
          {
            id: 'queue-routing-recall-only',
            query: 'operational dispatch platform',
            top1_slug: 'systems/runtime-platform',
            missing_gold_slugs: [],
            reason_codes: ['top1_miss'],
          },
        ],
      });
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    });
  });

  test('fails the gate when aggregate thresholds are not met', () => {
    const report = evaluateRetrievalQualityQrelsGate({
      fixture_id: fixture.fixture_id,
      thresholds: {
        top1_match_rate: 1,
        recall_at_10: 1,
      },
      cases: [
        {
          id: 'bad-ranking',
          query: 'bad ranking',
          gold_slugs: ['systems/runtime-platform'],
          candidate_slugs: ['concepts/queue-routing'],
        },
      ],
    });

    expect(report.status).toBe('failed');
    expect(report.top1_match_rate).toBe(0);
    expect(report.recall_at_10).toBe(0);
    expect(report.failures).toEqual([
      {
        id: 'bad-ranking',
        query: 'bad ranking',
        top1_slug: 'concepts/queue-routing',
        missing_gold_slugs: ['systems/runtime-platform'],
        reason_codes: ['top1_miss', 'recall_at_10_miss'],
      },
    ]);
  });
});
