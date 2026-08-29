/**
 * #2079 — `gbrain takes list` used to parse "list" as a PAGE SLUG: cmdList
 * looked up a page named "list" and printed "No takes on list." even when the
 * brain held many takes — reading exactly like an empty takes table, so
 * agents concluded there were no takes and moved on.
 *
 * Fix: `list` is a real subcommand (CLI parity with the takes_list op).
 * Bare `takes <slug>` still lists per-page.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTakes } from '../src/commands/takes.ts';

let engine: PGLiteEngine;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('companies/acme-example', {
    type: 'company',
    title: 'Acme Example',
    compiled_truth: 'Acme Example is a test company.',
  });
  const [row] = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = 'companies/acme-example'`,
  );
  await engine.addTakesBatch([{
    page_id: row.id,
    row_num: 1,
    claim: 'Acme will ship the widget by Q3.',
    kind: 'bet',
    holder: 'self',
    weight: 0.7,
  }]);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('gbrain takes list (#2079)', () => {
  test('`takes list` lists all takes instead of slug-ifying "list"', async () => {
    const out = await captureStdout(() => runTakes(engine, ['list']));
    expect(out).not.toContain('No takes on list.');
    expect(out).toContain('Acme will ship the widget by Q3.');
    expect(out).toContain('companies/acme-example');
  });

  test('`takes list --json` returns the full take rows', async () => {
    const out = await captureStdout(() => runTakes(engine, ['list', '--json']));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].claim).toContain('Acme will ship');
  });

  test('per-page form still works: `takes <slug>`', async () => {
    const out = await captureStdout(() => runTakes(engine, ['companies/acme-example']));
    expect(out).toContain('# Takes on companies/acme-example');
    expect(out).toContain('Acme will ship the widget by Q3.');
  });
});

describe('gbrain takes list --limit/--offset (#4629)', () => {
  // Runs after the #2079 block (which asserts a single-row brain), so the
  // extra rows are seeded here, not in the file-level beforeAll.
  beforeAll(async () => {
    const [row] = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'companies/acme-example'`,
    );
    await engine.addTakesBatch([
      { page_id: row.id, row_num: 2, claim: 'Weight ninety take.', kind: 'take', holder: 'self', weight: 0.9 },
      { page_id: row.id, row_num: 3, claim: 'Weight fifty take.', kind: 'take', holder: 'self', weight: 0.5 },
      { page_id: row.id, row_num: 4, claim: 'Weight thirty take.', kind: 'take', holder: 'self', weight: 0.3 },
    ]);
  });

  test('`takes list --limit N` caps the row count', async () => {
    const out = await captureStdout(() =>
      runTakes(engine, ['list', '--json', '--sort', 'weight', '--limit', '2']));
    const parsed = JSON.parse(out) as Array<{ claim: string }>;
    expect(parsed.length).toBe(2);
    // weight DESC: 0.9 then 0.7 (the #2079 seed row)
    expect(parsed[0]!.claim).toBe('Weight ninety take.');
    expect(parsed[1]!.claim).toContain('Acme will ship');
  });

  test('`takes list --offset N` skips rows (pages with --limit)', async () => {
    const out = await captureStdout(() =>
      runTakes(engine, ['list', '--json', '--sort', 'weight', '--limit', '2', '--offset', '2']));
    const parsed = JSON.parse(out) as Array<{ claim: string }>;
    expect(parsed.length).toBe(2);
    expect(parsed[0]!.claim).toBe('Weight fifty take.');
    expect(parsed[1]!.claim).toBe('Weight thirty take.');
  });

  test('`takes list --offset N` without --limit uses the engine default limit', async () => {
    const out = await captureStdout(() =>
      runTakes(engine, ['list', '--json', '--sort', 'weight', '--offset', '1']));
    const parsed = JSON.parse(out) as Array<{ claim: string }>;
    expect(parsed.length).toBe(3);
    expect(parsed[0]!.claim).toContain('Acme will ship');
  });

  test('bare `takes list` is unchanged: no limit/offset applied', async () => {
    const out = await captureStdout(() => runTakes(engine, ['list', '--json']));
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed.length).toBe(4);
  });
});

describe('gbrain takes list — invalid --limit/--offset exit 1 (#4629 negative paths)', () => {
  /**
   * Drive runTakes with process.exit stubbed (the real one returns `never`,
   * so the stub throws to stop cmdList before it reaches engine.listTakes)
   * and console.error captured. Pattern from test/commands-search.test.ts.
   */
  async function runExpectingExit(args: string[]): Promise<{ exitCode: number; stderr: string }> {
    let exitCode = 0;
    const errLines: string[] = [];
    const originalExit = process.exit;
    const originalErr = console.error;
    (process.exit as unknown as (code?: number) => void) = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error('exit-' + code);
    }) as never;
    console.error = (...a: unknown[]) => { errLines.push(a.join(' ')); };
    try {
      await runTakes(engine, args);
    } catch { /* the exit stub throws by design */ } finally {
      process.exit = originalExit;
      console.error = originalErr;
    }
    return { exitCode, stderr: errLines.join('\n') };
  }

  test('`--limit 0` is rejected: positive-integer message + exit 1', async () => {
    const { exitCode, stderr } = await runExpectingExit(['list', '--limit', '0']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --limit "0". Expected a positive integer.');
  });

  test('`--limit abc` is rejected: positive-integer message + exit 1', async () => {
    const { exitCode, stderr } = await runExpectingExit(['list', '--limit', 'abc']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --limit "abc". Expected a positive integer.');
  });

  test('`--limit 12abc` is rejected — parseInt truncation must not slip trailing garbage through', async () => {
    // Pre-guard, parseInt('12abc') === 12 silently ran the query with a
    // truncated limit. The /^\d+$/ pre-check rejects it with the SAME copy.
    const { exitCode, stderr } = await runExpectingExit(['list', '--limit', '12abc']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --limit "12abc". Expected a positive integer.');
  });

  test('`--offset -1` is rejected: non-negative message + exit 1', async () => {
    const { exitCode, stderr } = await runExpectingExit(['list', '--offset', '-1']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --offset "-1". Expected a non-negative integer.');
  });

  test('`--offset 3xyz` is rejected — same full-string discipline as --limit', async () => {
    const { exitCode, stderr } = await runExpectingExit(['list', '--offset', '3xyz']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --offset "3xyz". Expected a non-negative integer.');
  });

  test('valid boundary values still pass: --limit 1 and --offset 0', async () => {
    // Guard-rail for the new pre-check: it must not reject legitimate input.
    const out = await captureStdout(() =>
      runTakes(engine, ['list', '--json', '--sort', 'weight', '--limit', '1', '--offset', '0']));
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed.length).toBe(1);
  });
});
