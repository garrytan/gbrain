/**
 * list_pages gains `effective_after` / `effective_before`, so a caller can ask
 * when a thing HAPPENS rather than when its page last CHANGED.
 *
 * The filter layer has had both since v0.46.25.0 (055ac6c75) — declared on `PageFilters`,
 * implemented in postgres-engine and pglite-engine, with an index on
 * `COALESCE(effective_date, updated_at)` put there for exactly this — but no
 * operation exposed them. `updated_after` was surfaced on this tool and its
 * two siblings were not, so every MCP and CLI caller could ask what had been
 * edited recently and could not ask what was on next week.
 *
 * The cost of that gap was measured, not guessed: on one brain, finding the
 * meetings for the coming week took roughly 130 page scans and 90 calls,
 * because the only way through was to list pages and open each one to find
 * out when it was about.
 *
 * These filters only ever NARROW a set the caller could already list — source
 * scope, the private-page predicate and the remote row cap are evaluated
 * independently and still apply — so they open no new read surface.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const op = operations.find((o) => o.name === 'list_pages')!;

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY);
const iso = (n: number) => day(n).toISOString();

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: console as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

type Row = { slug: string; effective_date?: Date | string | null };

async function rows(params: Record<string, unknown>): Promise<Row[]> {
  const res = (await op.handler(ctxOf(), params)) as { pages: Row[] } | Row[];
  return Array.isArray(res) ? res : res.pages;
}
async function slugs(params: Record<string, unknown>): Promise<string[]> {
  return (await rows(params)).map((p) => p.slug).sort();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, offset] of [
    ['meetings/standup-next-week', 3],
    ['meetings/review-next-week', 5],
    // The SAME meeting again, from a second calendar source, under a title
    // that disagrees. Pinned here because a window over a corpus holding
    // each meeting twice must return it twice — see the test.
    ['meetings/standup-nextweek-other-lane', 3],
    ['meetings/last-month', -30],
    ['daily/today', 0],
  ] as const) {
    await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: `# ${slug}`,
      effective_date: day(offset),
      effective_date_source: 'event_date',
    } as never);
  }
  // No effective_date at all. Every page has an updated_at, so this is the
  // page that separates "when it happens" from "when it changed".
  await engine.putPage('notes/undated', {
    type: 'note',
    title: 'undated',
    compiled_truth: '# undated',
  } as never);
  // 141 migrations on a cold PGLite runs a little over the 5s default, which
  // makes the suite fail as a hook timeout instead of on its assertions.
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('list_pages effective_after / effective_before', () => {
  test('the coming week comes back in one call', async () => {
    expect(await slugs({ effective_after: iso(1), effective_before: iso(7), limit: 100 }))
      .toEqual([
        'meetings/review-next-week',
        'meetings/standup-next-week',
        'meetings/standup-nextweek-other-lane',
      ]);
  });

  test('a period entirely in the future returns its pages, not an empty result', async () => {
    // The failure this pins: the chronicle reads return empty for future
    // dates, which is why #530 could not simply use them.
    const found = await rows({ effective_after: iso(1), effective_before: iso(7), limit: 100 });
    expect(found.length).toBeGreaterThan(0);
  });

  test('an empty period is an empty list, not a failure', async () => {
    // Distinguishable from a read that failed: a value comes back, nothing
    // throws. A caller can tell "nothing on" from "could not look".
    let threw = false;
    let found: Row[] = [];
    try {
      found = await rows({ effective_after: iso(300), effective_before: iso(307), limit: 100 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(found).toEqual([]);
  });

  test('a thing the corpus holds twice comes back twice', async () => {
    // Two calendar sources can carry the same meeting under disagreeing
    // titles. Collapsing them HERE would hide an ingestion fault behind a
    // read tool, so the window reports the corpus as it is.
    const found = await slugs({ effective_after: iso(2), effective_before: iso(4), limit: 100 });
    expect(found).toEqual([
      'meetings/standup-next-week',
      'meetings/standup-nextweek-other-lane',
    ]);
  });

  test('each row says which day it falls on', async () => {
    // Without this a coming-week answer is a list of titles with no way to
    // tell Monday from Friday, which does not answer the question asked.
    const found = await rows({ effective_after: iso(1), effective_before: iso(7), limit: 100 });
    for (const r of found) expect(r.effective_date).toBeTruthy();
  });

  test('a page with no effective date never matches a window', async () => {
    const found = await slugs({ effective_after: iso(-3650), effective_before: iso(3650), limit: 100 });
    expect(found).not.toContain('notes/undated');
  });

  test('each bound works alone', async () => {
    expect(await slugs({ effective_after: iso(1), limit: 100 }))
      .toEqual([
        'meetings/review-next-week',
        'meetings/standup-next-week',
        'meetings/standup-nextweek-other-lane',
      ]);
    expect(await slugs({ effective_before: iso(-1), limit: 100 }))
      .toEqual(['meetings/last-month']);
  });

  test('asking by last change is unaffected', async () => {
    // Every page above was written moments ago, so updated_after must still
    // see all six — including the undated one a window can never return.
    const byChange = await slugs({ updated_after: iso(-1), limit: 100 });
    expect(byChange).toContain('notes/undated');
    expect(byChange).toContain('meetings/last-month');
    expect(byChange.length).toBe(6);
  });

  test('it composes with the other filters rather than replacing them', async () => {
    const windowed = await slugs({ effective_after: iso(1), effective_before: iso(7), limit: 100 });
    const narrowed = await slugs({
      effective_after: iso(1), effective_before: iso(7), updated_after: iso(1), limit: 100,
    });
    // Nothing was updated in the future, so the two filters intersect to empty
    // — proof the window did not override updated_after.
    expect(windowed.length).toBe(3);
    expect(narrowed).toEqual([]);
  });
});
