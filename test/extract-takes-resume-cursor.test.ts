/**
 * Resuming `takes extract --from-pages` with `next_before` / `--before` (#5043).
 *
 * Protects: a page that yields no claims holds no takes, so it stays eligible
 * and, newest first under a LIMIT, is selected again ahead of everything
 * older. Chaining each run's `next_before` into the next run's `--before`
 * must visit every eligible page exactly once, in (updated_at DESC, id DESC)
 * order, keeping equal timestamps apart by id and microsecond differences
 * intact. A budget stop must resume at the page it never classified, and a
 * page whose model call failed is passed by the cursor but retried by a plain
 * run. The cursor round-trips through the CLI's own parser
 * (`parseTakesBeforeCursor`), so what a run prints is what `--before`
 * accepts.
 *
 * Regression it catches: no cursor (each run re-selects the same zero-claim
 * slice), a millisecond-truncated cursor, a missing id tie-break, or a budget
 * stop that reports the unclassified page as finished.
 *
 * Negative control: runs without `--before` keep re-selecting the newest
 * zero-claim page, which is the defect the cursor exists to get past.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { parseTakesBeforeCursor } from '../src/commands/takes.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const NO_CLAIMS = '[]';
const ONE_CLAIM = '[{"claim":"Small teams ship faster","kind":"take","weight":0.6}]';

let engine: PGLiteEngine;
let repo: string;
/** Slugs the classifier saw, in call order. */
let seen: string[] = [];
let answerFor: (slug: string) => string | Error = () => NO_CLAIMS;

async function eligiblePage(slug: string, updatedAt: string): Promise<number> {
  const body = `Notes on ${slug}: a long enough opinion-bearing body to pass the 200-character eligibility floor. `.repeat(3);
  await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, frontmatter: {} });
  writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\n${body}\n`, 'utf-8');
  const [row] = await engine.executeRaw<{ id: number }>(
    `UPDATE pages SET updated_at = $2::text::timestamptz WHERE slug = $1 RETURNING id`, [slug, updatedAt],
  );
  return Number(row!.id);
}

function resumeAfter(nextBefore: string | null) {
  expect(nextBefore).not.toBeNull();
  return parseTakesBeforeCursor(['--from-pages', '--before', nextBefore!])!;
}

async function slugsInSweepOrder(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages ORDER BY updated_at DESC, id DESC`);
  return rows.map((r) => r.slug);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gb-takes-resume-'));
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-ant-test-takes-resume' } });
  __setChatTransportForTests(async (req) => {
    const slug = /<page slug="([^"]+)"/.exec(String(req.messages[0]?.content ?? ''))?.[1] ?? '';
    seen.push(slug);
    const answer = answerFor(slug);
    if (answer instanceof Error) throw answer;
    return {
      text: answer, blocks: [{ type: 'text' as const, text: answer }], stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('sync.repo_path', repo);
  seen = [];
  answerFor = () => NO_CLAIMS;
});

describe('takes extract resume cursor (#5043)', () => {
  test('chaining next_before visits every zero-claim page once, ties by id, microseconds intact, then ends', async () => {
    await eligiblePage('concepts/tie-first', '2030-03-01 10:00:00.000002+00');
    await eligiblePage('concepts/tie-second', '2030-03-01 10:00:00.000002+00');
    await eligiblePage('concepts/one-microsecond-older', '2030-03-01 10:00:00.000001+00');
    await eligiblePage('concepts/last-year', '2029-03-01 10:00:00+00');

    let before: { updatedAt: string; id: number } | undefined;
    const cursors: string[] = [];
    for (let run = 0; run < 8; run++) {
      const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1, ...(before ? { before } : {}) });
      if (result.pages_scanned === 0) {
        expect(result.next_before).toBeNull();
        break;
      }
      expect(result.claims_extracted).toBe(0);
      cursors.push(result.next_before!);
      before = resumeAfter(result.next_before);
    }

    expect(seen).toEqual(await slugsInSweepOrder());
    expect(cursors[2]).toStartWith('2030-03-01 10:00:00.000001');
  });

  test('negative control: without --before the newest zero-claim page is selected again every run', async () => {
    await eligiblePage('concepts/older-with-claims', '2030-01-01 00:00:00+00');
    await eligiblePage('concepts/newest-no-claims', '2030-02-01 00:00:00+00');

    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1 });
    const second = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1 });

    expect(seen).toEqual(['concepts/newest-no-claims', 'concepts/newest-no-claims']);
    expect(second.next_before).toBe(first.next_before);
  });

  test('a budget stop reports the last classified page, so the next run classifies the page it stopped on', async () => {
    const newestId = await eligiblePage('concepts/budget-newest', '2030-05-05 05:05:05.5+00');
    await eligiblePage('concepts/budget-stopped-on', '2030-05-05 05:05:05.4+00');

    const stopped = await extractTakesFromPages(engine, { bootstrapEnabled: true, budgetUsd: 0.015 });
    expect(stopped.budget_exhausted).toBe(true);
    expect(seen).toEqual(['concepts/budget-newest']);
    expect(resumeAfter(stopped.next_before).id).toBe(newestId);

    answerFor = () => ONE_CLAIM;
    const resumed = await extractTakesFromPages(engine, { bootstrapEnabled: true, before: resumeAfter(stopped.next_before) });
    expect(seen).toEqual(['concepts/budget-newest', 'concepts/budget-stopped-on']);
    expect(resumed.claims_extracted).toBe(1);
  });

  test('a budget that stops before the first page reports no resume point', async () => {
    await eligiblePage('concepts/never-classified', '2030-06-06 06:06:06+00');
    const stopped = await extractTakesFromPages(engine, { bootstrapEnabled: true, budgetUsd: 0.0000001 });
    expect(stopped.budget_exhausted).toBe(true);
    expect(stopped.pages_scanned).toBe(1);
    expect(stopped.next_before).toBeNull();
    expect(seen).toEqual([]);
  });

  test('a failed model call is passed by the cursor and retried by a plain run', async () => {
    await eligiblePage('concepts/after-the-outage', '2030-07-01 00:00:00+00');
    const flakyId = await eligiblePage('concepts/hit-the-outage', '2030-07-02 00:00:00+00');
    answerFor = (slug) => slug === 'concepts/hit-the-outage' ? new Error('upstream overloaded') : ONE_CLAIM;

    const failed = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1 });
    expect(failed.skipped.map((s) => s.slug)).toEqual(['concepts/hit-the-outage']);
    expect(resumeAfter(failed.next_before).id).toBe(flakyId);

    await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1, before: resumeAfter(failed.next_before) });
    expect(seen.at(-1)).toBe('concepts/after-the-outage');

    answerFor = () => ONE_CLAIM;
    const retried = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1 });
    expect(seen.at(-1)).toBe('concepts/hit-the-outage');
    expect(retried.claims_extracted).toBe(1);
  });
});
