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
