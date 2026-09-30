/**
 * add_timeline_entry date mistakes are caller errors, not server failures.
 *
 * Authoring gate:
 * 1. Protects the public MCP error code. Malformed dates, out-of-range
 *    components, and nonexistent calendar days return `invalid_params` with
 *    the existing message. Dispatch must not serialize them as
 *    `internal_error`.
 * 2. Reverting the three `OperationError` throws in `src/core/ops/timeline.ts`
 *    back to plain `Error` makes these envelope assertions fail. The date
 *    checks, messages, dry-run short-circuit, and slug fences stay put.
 * 3. `test/timeline-write-through.test.ts` and
 *    `test/source-boundary-mutation-errors.test.ts` do not assert these
 *    invalid-date envelopes. They cover write-through and source isolation.
 * 4. No new production seam. Calls go through `dispatchToolCall`, the path
 *    both MCP transports share. Dispatch already preserves
 *    `OperationError.toJSON()`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall as dispatchToolCallImpl } from '../src/mcp/dispatch.ts';

const SOURCE = 'default';
const OPTS = { remote: true, sourceId: SOURCE } as const;
const BODY = 'Synthetic note body for timeline date classification.';
const REJECTED_SLUG = 'notes/timeline-date-rejected';
const BASELINE_SUMMARY = 'Seeded baseline.';
const BASELINE_TIMELINE = `## Timeline\n\n- **2020-01-15** | manual — ${BASELINE_SUMMARY}`;

const RANGE = 'year 1900-2199, month 1-12, day 1-31';

/** The three reported branches, then the rest of each rejected category. */
const REJECTED: Array<{ date: string; message: string }> = [
  { date: '2026/02/01', message: 'Invalid date format "2026/02/01" (expected YYYY-MM-DD)' },
  { date: '1800-01-01', message: `Invalid date "1800-01-01" (${RANGE})` },
  { date: '2026-02-30', message: 'Invalid calendar date "2026-02-30"' },
  { date: '2200-01-01', message: `Invalid date "2200-01-01" (${RANGE})` },
  { date: '2026-13-01', message: `Invalid date "2026-13-01" (${RANGE})` },
  { date: '2026-00-15', message: `Invalid date "2026-00-15" (${RANGE})` },
  { date: '2026-01-32', message: `Invalid date "2026-01-32" (${RANGE})` },
  { date: '2026-04-00', message: `Invalid date "2026-04-00" (${RANGE})` },
  { date: '2026-02-29', message: 'Invalid calendar date "2026-02-29"' },
];

const ACCEPTED = ['2026-02-28', '2024-02-29', '1900-01-01', '2199-12-31'];

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-timeline-dates-'));

async function dispatchToolCall(...args: Parameters<typeof dispatchToolCallImpl>) {
  return withEnv({
    GBRAIN_HOME: home,
    DATABASE_URL: undefined,
    GBRAIN_DATABASE_URL: undefined,
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    VOYAGE_API_KEY: undefined,
    GBRAIN_EMBEDDING_MODEL: undefined,
  }, async () => {
    try { return await dispatchToolCallImpl(...args); }
    finally { await disposePersistenceConsumer(args[0]); }
  });
}

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function calendarDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

async function seedNote(slug: string, timeline = ''): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: 'Timeline date fixture',
    compiled_truth: BODY,
    timeline,
  }, { sourceId: SOURCE });
}

async function pageState(slug: string) {
  const page = await engine.getPage(slug, { sourceId: SOURCE });
  const entries = await engine.getTimeline(slug, { sourceId: SOURCE });
  return {
    compiled_truth: page?.compiled_truth ?? null,
    timeline: page?.timeline ?? null,
    entries: entries.map(entry => ({
      date: calendarDay(entry.date),
      source: entry.source,
      summary: entry.summary,
      detail: entry.detail ?? '',
    })),
  };
}

let rejectedBaseline: Awaited<ReturnType<typeof pageState>>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_disabled: true,
  }));
  await seedNote(REJECTED_SLUG, BASELINE_TIMELINE);
  await engine.addTimelineEntry(REJECTED_SLUG, {
    date: '2020-01-15',
    source: 'manual',
    summary: BASELINE_SUMMARY,
  }, { sourceId: SOURCE });
  rejectedBaseline = await pageState(REJECTED_SLUG);
  for (const date of ACCEPTED) {
    await seedNote(`notes/timeline-date-${date}`);
  }
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 30_000);

describe('add_timeline_entry rejects invalid dates as invalid_params', () => {
  test.each(REJECTED)('$date keeps the existing message and writes nothing', async ({ date, message }) => {
    const result = await dispatchToolCall(engine, 'add_timeline_entry', {
      slug: REJECTED_SLUG,
      date,
      summary: `Rejected ${date}`,
    }, OPTS);

    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({ error: 'invalid_params', message });
    expect(await pageState(REJECTED_SLUG)).toEqual(rejectedBaseline);
  });
});

describe('add_timeline_entry still accepts real calendar dates', () => {
  test.each(ACCEPTED)('%s persists through dispatch', async (date) => {
    const slug = `notes/timeline-date-${date}`;
    const summary = `Recorded ${date}`;
    const before = await pageState(slug);
    expect(before.entries).toEqual([]);
    expect(before.compiled_truth).toBe(BODY);

    const result = await dispatchToolCall(engine, 'add_timeline_entry', {
      slug,
      date,
      summary,
    }, OPTS);

    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      status: 'ok',
      state: 'committed',
      entry: { date, source: 'manual', summary },
    });
    const after = await pageState(slug);
    expect(after.compiled_truth).toBe(BODY);
    expect(after.timeline).toContain(`**${date}**`);
    expect(after.timeline).toContain(summary);
    expect(after.entries).toEqual([{ date, source: 'manual', summary, detail: '' }]);
  });
});
