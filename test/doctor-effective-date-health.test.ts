/**
 * doctor `effective_date_health` check — key-existence vs. parseable-value
 * regression test.
 *
 * The check used to flag any `effective_date_source = 'fallback'` row whose
 * frontmatter merely HAD an `event_date`/`date`/`published` key (JSONB `?`
 * operator), even when the value was an empty string or otherwise
 * unparseable. That over-reported: `gbrain reindex-frontmatter --dry-run`
 * (which runs the real `computeEffectiveDate` precedence chain) would find
 * nothing to fix for those rows, so the doctor warning never went away no
 * matter how many times reindex-frontmatter ran.
 *
 * The fix re-runs `computeEffectiveDate` (the same function
 * `backfillEffectiveDate` / `gbrain reindex-frontmatter` uses) with
 * `filename: null` over the candidate rows in JS, so doctor only flags rows
 * where a fresh parse finds a date attributable to the FRONTMATTER
 * specifically — independent of whether a filename-derived date would win
 * the full precedence chain for daily/meetings-prefixed slugs.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';

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

async function insertFallbackPage(opts: {
  slug: string;
  frontmatter: Record<string, unknown>;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, frontmatter, effective_date, effective_date_source)
     VALUES ('default', $1, 'note', $1, $2::text::jsonb, now(), 'fallback')`,
    [opts.slug, JSON.stringify(opts.frontmatter)],
  );
}

async function getEffectiveDateHealth() {
  const checks = await buildChecks(engine, []);
  const check = checks.find(c => c.name === 'effective_date_health');
  expect(check).toBeDefined();
  return check!;
}

describe('doctor effective_date_health — parseable-value check (not just key-existence)', () => {
  test('clean brain (no pages) reports ok', async () => {
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('ok');
  });

  test('fallback row with an EMPTY string date value is NOT flagged', async () => {
    await insertFallbackPage({ slug: 'wiki/empty-date', frontmatter: { date: '' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('fell back to updated_at despite parseable');
  });

  test('fallback row with an UNPARSEABLE date value is NOT flagged', async () => {
    await insertFallbackPage({ slug: 'wiki/garbage-date', frontmatter: { date: 'not-a-real-date' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('ok');
  });

  test('fallback row with a genuinely PARSEABLE date value IS still flagged (true positive preserved)', async () => {
    await insertFallbackPage({ slug: 'wiki/real-date', frontmatter: { date: '2024-03-15' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 fell back to updated_at despite parseable frontmatter date');
  });

  test('mix of empty/garbage/real fallback rows counts only the real one', async () => {
    await insertFallbackPage({ slug: 'wiki/empty', frontmatter: { date: '' } });
    await insertFallbackPage({ slug: 'wiki/garbage', frontmatter: { published: 'soon' } });
    await insertFallbackPage({ slug: 'wiki/real', frontmatter: { event_date: '2023-11-01' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 fell back to updated_at despite parseable frontmatter date');
  });

  test('fallback row with NO date-ish keys at all is not flagged (predicate short-circuits)', async () => {
    await insertFallbackPage({ slug: 'wiki/no-date-keys', frontmatter: { title: 'no dates here' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('ok');
  });

  // Codex review (self-multi-model) caught this: computeEffectiveDate() also
  // resolves a FILENAME-derived date. A row whose frontmatter date is empty
  // but whose slug basename starts with YYYY-MM-DD would recompute to
  // source='filename' — a genuinely non-fallback source, but NOT a
  // "frontmatter date". Must not be counted under this check's specific
  // "despite parseable frontmatter date" message.
  test('fallback row with empty frontmatter date but a date-prefixed slug is NOT flagged (filename date != frontmatter date)', async () => {
    await insertFallbackPage({ slug: 'daily/2024-03-15-standup', frontmatter: { date: '' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('fell back to updated_at despite parseable');
  });

  // Second Codex review round caught the inverse of the case above: for
  // daily/meetings-prefixed slugs, computeEffectiveDate's filename-first
  // precedence means a genuinely parseable frontmatter date can be SHADOWED
  // by an also-valid filename date — the full precedence chain resolves to
  // source='filename', not 'date'. Checking only the winning source (as the
  // first fix did) would silently undercount: reindex-frontmatter DOES still
  // act on this row (it has a real date to move away from 'fallback'), so
  // doctor must still flag it. filename:null in the implementation sidesteps
  // this by testing frontmatter parseability independent of slug prefix.
  test('fallback row under daily/ WITH a real frontmatter date IS flagged even though a filename date would also resolve (frontmatter checked independent of filename precedence)', async () => {
    await insertFallbackPage({ slug: 'daily/2024-03-15-standup', frontmatter: { date: '2024-04-01' } });
    const check = await getEffectiveDateHealth();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 fell back to updated_at despite parseable frontmatter date');
  });
});
