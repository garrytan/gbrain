import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type OperationContext, operationsByName } from '../src/core/operations.ts';
import {
  ANTICIPATION_PACK_CONFIG_KEY,
  type AnticipationProbe,
  buildAnticipationPack,
} from '../src/core/services/anticipation-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

let tempDir: string;
let engine: SQLiteEngine;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mbrain-anticipation-'));
  engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(tempDir, 'brain.db') });
  await engine.initSchema();
});

afterEach(async () => {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

// The recurring-trace window uses an exclusive upper bound (created_at < until),
// so a deterministic "now" strictly after the seeded trace timestamps is used.
function futureNow(): string {
  return new Date(Date.now() + 1000).toISOString();
}

function stubProbe(selectorCount = 1): AnticipationProbe {
  return async (_engine, input) => ({
    read_plan: {
      selected_selector_snapshots: Array.from({ length: selectorCount }, (_, index) => ({
        kind: 'page' as const,
        scope_id: 'workspace:default',
        slug: `probe/${input.query.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`,
        content_hash: `hash-${index}`,
      })),
    },
    required_reads: [],
  });
}

async function seedWatchedQuestion(question: string): Promise<void> {
  await engine.upsertWatchedQuestion({
    scope_id: 'workspace:default',
    question,
    enabled: true,
  });
}

async function seedActiveTaskWithDecision(): Promise<void> {
  await engine.createTaskThread({
    id: 'task-1',
    scope: 'work',
    title: 'Harden retrieval ranking',
    status: 'active',
  });
  await engine.recordTaskDecision({
    id: 'decision-1',
    task_id: 'task-1',
    summary: 'use RRF fusion',
    rationale: 'deterministic rank merging',
  });
  await engine.createTaskThread({
    id: 'task-2',
    scope: 'work',
    title: 'Completed migration cleanup',
    status: 'completed',
  });
}

async function seedRecurringTraces(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await engine.putRetrievalTrace({
      id: `trace-recurring-${index}`,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: ['page:workspace:default:systems/retrieval-pipeline'],
      outcome: 'retrieve_context selected canonical read candidates',
    });
  }
  await engine.putRetrievalTrace({
    id: 'trace-single',
    scope: 'work',
    route: ['retrieve_context'],
    source_refs: ['page:workspace:default:systems/only-once'],
    outcome: 'retrieve_context selected canonical read candidates',
  });
}

describe('buildAnticipationPack', () => {
  test('ranks watched questions above active-task queries above recurring trace queries', async () => {
    await seedWatchedQuestion('How does governed writeback work?');
    await seedActiveTaskWithDecision();
    await seedRecurringTraces();

    const pack = await buildAnticipationPack(engine, {
      now: futureNow(),
      dependencies: { probe: stubProbe() },
    });

    expect(pack.entries.map((entry) => entry.source)).toEqual([
      'watched_question',
      'task',
      'recurring_query',
    ]);
    expect(pack.entries[0]).toMatchObject({
      question: 'How does governed writeback work?',
      source: 'watched_question',
    });
    expect(pack.entries[1]?.question).toBe('Harden retrieval ranking use RRF fusion');
    expect(pack.entries[2]?.question).toBe('retrieval pipeline');
    // Completed task and single-occurrence trace slug must not produce entries.
    expect(pack.entries.some((entry) => entry.question.includes('Completed migration'))).toBe(false);
    expect(pack.entries.some((entry) => entry.question.includes('only once'))).toBe(false);
    // Every entry is probe-backed.
    for (const entry of pack.entries) {
      expect(entry.read_plan_selectors.length).toBeGreaterThan(0);
      expect(entry.read_plan_selectors[0]?.slug).toStartWith('probe/');
      expect(entry.token_estimate).toBeGreaterThan(0);
    }
  });

  test('dedupes normalized duplicate questions keeping the highest-priority source', async () => {
    await seedWatchedQuestion('retrieval   PIPELINE');
    await seedRecurringTraces();

    const pack = await buildAnticipationPack(engine, {
      now: futureNow(),
      dependencies: { probe: stubProbe() },
    });

    const normalized = pack.entries.map((entry) => entry.question.toLowerCase().replace(/\s+/g, ' ').trim());
    expect(normalized.filter((question) => question === 'retrieval pipeline')).toHaveLength(1);
    expect(pack.entries.find((entry) => entry.question.toLowerCase().includes('pipeline'))?.source)
      .toBe('watched_question');
  });

  test('bounds entries to the limit and selector snapshots per entry', async () => {
    await seedWatchedQuestion('First watched question?');
    await seedActiveTaskWithDecision();
    await seedRecurringTraces();

    const pack = await buildAnticipationPack(engine, {
      now: futureNow(),
      limit: 2,
      dependencies: { probe: stubProbe(8) },
    });

    expect(pack.entries).toHaveLength(2);
    for (const entry of pack.entries) {
      expect(entry.read_plan_selectors).toHaveLength(5);
      expect(entry.token_estimate).toBe(5 * 400);
    }
  });

  test('is deterministic for identical inputs', async () => {
    await seedWatchedQuestion('How does governed writeback work?');
    await seedActiveTaskWithDecision();
    await seedRecurringTraces();

    const now = futureNow();
    const first = await buildAnticipationPack(engine, { now, dependencies: { probe: stubProbe() } });
    const second = await buildAnticipationPack(engine, { now, dependencies: { probe: stubProbe() } });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.generated_at).toBe(now);
  });

  test('records probe failures without failing the whole pack', async () => {
    await seedWatchedQuestion('How does governed writeback work?');
    await seedActiveTaskWithDecision();

    const failingProbe: AnticipationProbe = async (_engine, input) => {
      if (input.query.includes('governed writeback')) {
        throw new Error('probe backend unavailable');
      }
      return stubProbe()(engine, input);
    };

    const pack = await buildAnticipationPack(engine, {
      now: futureNow(),
      dependencies: { probe: failingProbe },
    });

    expect(pack.probe_failures).toEqual([
      {
        question: 'How does governed writeback work?',
        source: 'watched_question',
        reason: 'probe backend unavailable',
      },
    ]);
    expect(pack.entries.map((entry) => entry.source)).toEqual(['task']);
  });

  test('builds an empty pack when the engine lacks the optional signal stores', async () => {
    const pack = await buildAnticipationPack({} as never, {
      now: '2026-07-06T00:00:00.000Z',
      dependencies: { probe: stubProbe() },
    });

    expect(pack).toEqual({
      generated_at: '2026-07-06T00:00:00.000Z',
      entries: [],
      candidate_question_count: 0,
      probe_failures: [],
    });
  });
});

describe('get_anticipation_pack operation', () => {
  function operationContext(): OperationContext {
    return {
      engine,
      config: { engine: 'sqlite' } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
    };
  }

  test('is registered as an admin-tier read-only operation', () => {
    const operation = operationsByName.get_anticipation_pack;
    expect(operation).toBeDefined();
    expect(operation?.tier).toBe('admin');
    expect(operation?.mutating).not.toBe(true);
  });

  test('returns status empty when no pack has been persisted', async () => {
    const result = await operationsByName.get_anticipation_pack!.handler(operationContext(), {});
    expect(result).toEqual({ status: 'empty' });
  });

  test('returns the persisted pack', async () => {
    await seedWatchedQuestion('How does governed writeback work?');
    const pack = await buildAnticipationPack(engine, {
      now: futureNow(),
      dependencies: { probe: stubProbe() },
    });
    await engine.setConfig(ANTICIPATION_PACK_CONFIG_KEY, JSON.stringify(pack));

    const result = await operationsByName.get_anticipation_pack!.handler(operationContext(), {});
    expect(result).toEqual(JSON.parse(JSON.stringify(pack)));
  });

  test('fails honestly when the persisted pack is corrupt', async () => {
    await engine.setConfig(ANTICIPATION_PACK_CONFIG_KEY, 'not-json{');
    await expect(operationsByName.get_anticipation_pack!.handler(operationContext(), {}))
      .rejects.toThrow(/not valid JSON/);
  });
});
