/**
 * #7246: `gbrain orphans --json` printed every orphan in one document (about
 * 27 MB on a brain with hundreds of thousands of pages). It now prints the
 * totals first, then one bounded page of rows with `complete` and a
 * `next_cursor` / `next_command`; `--all` keeps every row, and a listing
 * that fits in one page keeps the unpaged shape. The remote find_orphans op
 * pages by the same cursor and stays capped.
 *
 * Authoring gate: protects the CLI and MCP output-size contract; fails if the
 * CLI drops the default limit or the cursor skips or repeats rows; existing
 * orphans tests cover the data function and offset paging only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runOrphans } from '../src/commands/orphans.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

async function orphansJson(args: string[]) {
  return JSON.parse(await captureStdout(() => runOrphans(engine, ['--json', ...args])));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 90; i++) {
    await engine.putPage(`people/p-${String(i).padStart(3, '0')}`, { type: 'person', title: `P ${i}`, compiled_truth: 'Body.' });
  }
  for (let i = 0; i < 60; i++) {
    await engine.putPage(`companies/c-${String(i).padStart(3, '0')}`, { type: 'company', title: `C ${i}`, compiled_truth: 'Body.' });
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('gbrain orphans bounded output (#7246)', () => {
  test('--json prints the totals first and one default page of 100 rows with a next cursor', async () => {
    const out = await orphansJson([]);
    expect(out.total_orphans).toBe(150);
    expect(out.orphans).toHaveLength(100);
    expect(out.returned).toBe(100);
    expect(out.limit).toBe(100);
    expect(out.complete).toBe(false);
    expect(typeof out.next_cursor).toBe('string');
    expect(out.next_command).toEqual(['gbrain', 'orphans', '--json', '--cursor', out.next_cursor]);
    expect(out.by_domain).toEqual({ people: 90, companies: 60 });
    const keys = Object.keys(out);
    expect(keys[keys.length - 1]).toBe('orphans');
    expect(keys.indexOf('total_orphans')).toBeLessThan(keys.indexOf('orphans'));
  });

  test('following next_cursor returns every remaining orphan once, then complete', async () => {
    const first = await orphansJson(['--limit', '60']);
    const second = await orphansJson(['--limit', '60', '--cursor', first.next_cursor]);
    const third = await orphansJson(['--limit', '60', '--cursor', second.next_cursor]);
    expect([first.returned, second.returned, third.returned]).toEqual([60, 60, 30]);
    expect(third.complete).toBe(true);
    expect(third.next_cursor).toBeNull();
    expect(third.next_command).toBeNull();
    const slugs = [...first.orphans, ...second.orphans, ...third.orphans].map((o: { slug: string }) => o.slug);
    expect(new Set(slugs).size).toBe(150);
  });

  test('--all, and a listing that fits in one page, print the unpaged shape with every orphan', async () => {
    const all = await orphansJson(['--all']);
    expect(all.orphans).toHaveLength(150);
    expect(all.total_orphans).toBe(150);
    expect(Object.keys(all)).not.toContain('next_cursor');
    const fits = await orphansJson(['--limit', '150']);
    expect(fits).toEqual(all);
  });

  test('a cursor from a different filter set is refused', async () => {
    const first = await orphansJson(['--limit', '10']);
    await expect(runOrphans(engine, ['--json', '--mode', 'inbound', '--cursor', first.next_cursor])).rejects.toThrow('different listing');
    await expect(runOrphans(engine, ['--json', '--all', '--limit', '5'])).rejects.toThrow('--all lists every row');
  });

  test('text output is bounded and names the next-page command', async () => {
    const text = await captureStdout(() => runOrphans(engine, ['--limit', '5']));
    expect(text).toContain('150 orphans out of');
    expect(text.split('\n').filter(line => line.startsWith('  ')).length).toBe(5);
    expect(text).toContain('Showing 5 of 150 orphans. Next page: gbrain orphans --limit 5 --cursor ');
  });

  test('find_orphans pages by cursor and reports complete', async () => {
    const op = operations.find(o => o.name === 'find_orphans')!;
    const ctx = { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true } as never;
    const first = await op.handler(ctx, { limit: 100 }) as { orphans: unknown[]; complete: boolean; next_cursor: string | null };
    expect(first.orphans).toHaveLength(100);
    expect(first.complete).toBe(false);
    const rest = await op.handler(ctx, { limit: 100, cursor: first.next_cursor }) as { orphans: unknown[]; complete: boolean; next_cursor: string | null };
    expect(rest.orphans).toHaveLength(50);
    expect(rest.complete).toBe(true);
    expect(rest.next_cursor).toBeNull();
    await expect(op.handler(ctx, { limit: 1001 })).rejects.toThrow('limit must be');
  });
});
