/**
 * W6: `gbrain takes grades`, the review surface for grade_takes verdicts.
 *
 * Protects: the newest cached verdict per take is listed (an older verdict of
 * the same take is not); takes on soft-deleted pages are left out; the
 * --verdict, --min-confidence, --applied/--unapplied and --limit filters;
 * the JSON shape; every judge outside GRADE_TAKES_MEASURED_MODELS is marked
 * "not measured by W6" (the list is empty until the counted run). Fails when: the latest-per-take selection or a filter breaks,
 * or an unmeasured judge stops being marked.
 * Why new: grade_takes cached verdicts no surface could read.
 * Seams: none (PGLite, rows inserted directly into take_grade_cache).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTakes } from '../src/commands/takes.ts';
import { GRADE_TAKES_MEASURED_MODELS, GRADE_TAKES_MEASURED_PROMPT_VERSION, gradeJudgeMeasured } from '../src/core/cycle/grade-takes-measured.ts';

let engine: PGLiteEngine;
const takeIds: Record<string, number> = {};

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

async function pageWithTake(slug: string, claim: string): Promise<number> {
  await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `${slug} test page.` });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim, kind: 'bet', holder: 'alice-example', weight: 0.7, since_date: '2023-02-01' }]);
  const [take] = await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1', [page!.id]);
  return take!.id;
}

async function grade(takeId: number, verdict: string, confidence: number, gradedAt: string, applied = false, judge = 'claude-sonnet-4-6', prompt = 'hybrid-evidence-v1'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO take_grade_cache (take_id, prompt_version, judge_model_id, evidence_signature, graded_at, verdict, confidence, applied)
     VALUES ($1, $8, $2, $3, $4::timestamptz, $5, $6, $7)`,
    [takeId, judge, `sig-${takeId}-${gradedAt}`, gradedAt, verdict, confidence, applied, prompt],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  takeIds.acme = await pageWithTake('companies/acme-example', 'Acme-example will reach $5M ARR by the end of 2024');
  takeIds.bluefin = await pageWithTake('companies/bluefin-example', 'Bluefin-example will open a Berlin office by Q2 2024');
  takeIds.gone = await pageWithTake('companies/gone-example', 'Gone-example will be acquired before 2025');
  await grade(takeIds.acme!, 'unresolvable', 0.4, '2026-01-01T00:00:00Z');
  await grade(takeIds.acme!, 'correct', 0.97, '2026-03-01T00:00:00Z', true, 'gpt-6.1-sol');
  await grade(takeIds.bluefin!, 'unresolvable', 0.5, '2026-01-15T00:00:00Z', false, 'gpt-6.1-sol', 'hybrid-evidence-v2');
  await grade(takeIds.bluefin!, 'incorrect', 0.8, '2026-02-01T00:00:00Z', false, 'openai:gpt-6.1-sol', 'hybrid-evidence-v2');
  await grade(takeIds.gone!, 'correct', 0.99, '2026-02-15T00:00:00Z');
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'companies/gone-example'`);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('gbrain takes grades', () => {
  test('lists the newest verdict per take, newest first, and leaves out deleted pages', async () => {
    const rows = JSON.parse(await capture(() => runTakes(engine, ['grades', '--json'])));
    expect(rows.map((r: { take_id: number; verdict: string }) => [r.take_id, r.verdict])).toEqual([
      [takeIds.acme, 'correct'],
      [takeIds.bluefin, 'incorrect'],
    ]);
    expect(rows[0]).toMatchObject({ page_slug: 'companies/acme-example', row_num: 1, holder: 'alice-example', confidence: expect.closeTo(0.97, 5), applied: true, judge_model_id: 'gpt-6.1-sol', prompt_version: 'hybrid-evidence-v1', judge_measured: false });
  });

  test('filters by verdict, confidence, applied state and limit', async () => {
    const ids = async (...args: string[]) => JSON.parse(await capture(() => runTakes(engine, ['grades', '--json', ...args]))).map((r: { take_id: number }) => r.take_id);
    expect(await ids('--verdict', 'incorrect')).toEqual([takeIds.bluefin]);
    expect(await ids('--min-confidence', '0.95')).toEqual([takeIds.acme]);
    expect(await ids('--applied')).toEqual([takeIds.acme]);
    expect(await ids('--unapplied')).toEqual([takeIds.bluefin]);
    expect(await ids('--limit', '1')).toEqual([takeIds.acme]);
  });

  test('marks a verdict measured only for a measured judge asked with the measured prompt', async () => {
    expect(GRADE_TAKES_MEASURED_MODELS).toEqual(['openai:gpt-6.1-sol']);
    expect(gradeJudgeMeasured('gpt-6.1-sol', GRADE_TAKES_MEASURED_PROMPT_VERSION)).toBe(true);
    expect(gradeJudgeMeasured('openai:gpt-6.1-sol', 'hybrid-evidence-v2')).toBe(true);
    expect(gradeJudgeMeasured('gpt-6.1-sol', 'hybrid-evidence-v1')).toBe(false);
    expect(gradeJudgeMeasured('claude-sonnet-5-5', 'hybrid-evidence-v2')).toBe(false);
    expect(gradeJudgeMeasured('claude-sonnet-4-6', 'hybrid-evidence-v2')).toBe(false);
    const rows = JSON.parse(await capture(() => runTakes(engine, ['grades', '--json'])));
    expect(rows.map((r: { take_id: number; judge_measured: boolean }) => [r.take_id, r.judge_measured])).toEqual([[takeIds.acme, false], [takeIds.bluefin, true]]);
    const out = await capture(() => runTakes(engine, ['grades']));
    expect(out).toContain('companies/acme-example#1 [alice-example] correct @ 0.97 applied  judge gpt-6.1-sol (not measured by W6)');
    expect(out).toContain('companies/bluefin-example#1 [alice-example] incorrect @ 0.80  judge openai:gpt-6.1-sol  2026-02-01');
    expect(out).toContain('Acme-example will reach $5M ARR by the end of 2024  (made 2023-02-01)');
    expect(out).not.toContain('Gone-example');
  });

  test('an empty match says so', async () => {
    expect(await capture(() => runTakes(engine, ['grades', '--verdict', 'partial']))).toBe('No grade_takes verdicts match.');
  });
});
