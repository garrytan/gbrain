/**
 * W7: `gbrain takes journal` and `gbrain takes scorecard --group-by`
 * (trusted local; thin clients refuse both, see
 * test/thin-client-routing.test.ts). The journal lists every prediction
 * with its state and keeps the unresolved denominator in its totals; the
 * grouped scorecard adds per-holder or per-source rows to the plain card.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTakes } from '../src/commands/takes.ts';
import { scanStatedHorizons } from '../src/core/takes-horizon.ts';

let engine: PGLiteEngine;

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

async function exitOf(fn: () => Promise<void>): Promise<{ code: number | undefined; stderr: string }> {
  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw Object.assign(new Error('EXIT'), { exitCode: code }); }) as typeof process.exit;
  try { await fn(); return { code: undefined, stderr }; }
  catch (e) { if ((e as Error).message === 'EXIT') return { code: (e as { exitCode?: number }).exitCode, stderr }; throw e; }
  finally { process.exit = origExit; process.stderr.write = origErr; }
}

async function take(slug: string, claim: string, holder: string, since: string, resolved?: 'correct' | 'incorrect'): Promise<void> {
  await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `${slug} test page.` });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim, kind: 'bet', holder, weight: 0.7, since_date: since }]);
  if (resolved) {
    await engine.executeRaw(`UPDATE takes SET resolved_at = '2025-03-01T00:00:00Z', resolved_quality = $2, resolved_outcome = $3, resolved_by = 'owner' WHERE page_id = $1`,
      [page!.id, resolved, resolved === 'correct']);
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await take('companies/acme-example', 'Acme-example will reach $5M ARR by the end of 2024', 'alice-example', '2023-02', 'correct');
  await take('companies/bluefin-example', 'Bluefin-example will open a Berlin office by Q2 2025', 'bob-example', '2023-06');
  await take('companies/cobalt-example', 'Cobalt-example will list by the end of 2099', 'alice-example', '2024-01');
  await take('companies/dune-example', 'Dune-example has the strongest team in its market', 'bob-example', '2024-02', 'incorrect');
  await scanStatedHorizons(engine, { apply: true });
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('gbrain takes journal', () => {
  test('--json lists every prediction with its state; totals keep the unresolved denominator', async () => {
    const j = JSON.parse(await capture(() => runTakes(engine, ['journal', '--json'])));
    expect(j.totals).toEqual({ predictions: 4, resolved: 2, unresolved: 2, open: 1, overdue: 1, undated: 0, certified_prediction_times: 0 });
    expect(Object.fromEntries(j.entries.map((e: { page_slug: string; state: string }) => [e.page_slug, e.state]))).toEqual({
      'companies/acme-example': 'resolved', 'companies/bluefin-example': 'overdue', 'companies/cobalt-example': 'open', 'companies/dune-example': 'resolved' });
    expect(j.entries[0].prediction).toEqual({ at: '2023-02', basis: 'since_date', certified: false });
  });

  test('filters by holder, page prefix and state, and caps with --limit', async () => {
    const bob = JSON.parse(await capture(() => runTakes(engine, ['journal', '--holder', 'bob-example', '--json'])));
    expect(bob.entries.map((e: { page_slug: string }) => e.page_slug)).toEqual(['companies/bluefin-example', 'companies/dune-example']);
    const about = JSON.parse(await capture(() => runTakes(engine, ['journal', '--about', 'companies/cobalt', '--json'])));
    expect(about.entries.map((e: { page_slug: string }) => e.page_slug)).toEqual(['companies/cobalt-example']);
    const overdue = JSON.parse(await capture(() => runTakes(engine, ['journal', '--state', 'overdue', '--limit', '5', '--json'])));
    expect([overdue.entries.length, overdue.totals.predictions]).toEqual([1, 4]);
  });

  test('the text form labels uncertified prediction times, prints the denominator and the newest cached grade', async () => {
    await engine.executeRaw(`INSERT INTO take_grade_cache (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence)
      SELECT id, 'hybrid-evidence-v2', 'openai:some-unmeasured-model', 'sig', 'incorrect', 0.97 FROM takes WHERE claim LIKE 'Bluefin-example%'`);
    const text = await capture(() => runTakes(engine, ['journal']));
    expect(text).toContain('grade incorrect @ 0.97 (judge not measured)');
    expect(text).toContain('4 predictions: 2 resolved, 2 unresolved (1 overdue, 1 open, 0 undated)');
    expect(text).toContain('[overdue]');
    expect(text).toContain('2023-06 (since_date, uncertified)');
    expect(text).toContain('Bluefin-example will open a Berlin office by Q2 2025');
  });

  test('refuses an unknown state and a bad limit', async () => {
    expect(await exitOf(() => runTakes(engine, ['journal', '--state', 'late']))).toMatchObject({ code: 1, stderr: expect.stringContaining('Usage: gbrain takes journal') });
    expect(await exitOf(() => runTakes(engine, ['journal', '--limit', '0']))).toMatchObject({ code: 1, stderr: expect.stringContaining('--limit') });
  });
});

describe('gbrain takes scorecard --group-by', () => {
  test('--json keeps the plain card and adds groups and journal totals', async () => {
    const plain = JSON.parse(await capture(() => runTakes(engine, ['scorecard', '--json'])));
    const grouped = JSON.parse(await capture(() => runTakes(engine, ['scorecard', '--group-by', 'holder', '--min-n', '1', '--json'])));
    expect({ ...grouped, groups: undefined, journal: undefined, mcp_resolved: undefined }).toEqual({ ...plain, groups: undefined, journal: undefined, mcp_resolved: undefined });
    expect(grouped.groups.map((g: { key: string; n: number; low_n: boolean }) => [g.key, g.n, g.low_n])).toEqual([['alice-example', 1, false], ['bob-example', 1, false]]);
    expect(grouped.journal).toMatchObject({ predictions: 4, unresolved: 2 });
  });

  test('the text form prints one row per group and flags low_n', async () => {
    const text = await capture(() => runTakes(engine, ['scorecard', '--group-by', 'holder']));
    expect(text).toContain('By holder');
    expect(text).toMatch(/alice-example\s+n=1/);
    expect(text).toContain('low_n');
  });

  test('refuses an unknown grouping', async () => {
    expect(await exitOf(() => runTakes(engine, ['scorecard', '--group-by', 'domain']))).toMatchObject({ code: 1, stderr: expect.stringContaining('--group-by holder|source') });
  });
});
