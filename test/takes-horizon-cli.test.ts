/**
 * W7: `gbrain takes horizon` (trusted local; thin clients refuse it, see
 * test/thin-client-routing.test.ts). scan previews by default and writes only
 * with --apply; set and clear address a take by page slug and row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTakes } from '../src/commands/takes.ts';
import { readTakeHorizons } from '../src/core/takes-horizon.ts';

let engine: PGLiteEngine;
const ids: Record<string, number> = {};

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

async function take(slug: string, claim: string, since: string): Promise<number> {
  await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `${slug} test page.` });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim, kind: 'bet', holder: 'world', weight: 0.7, since_date: since }]);
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1', [page!.id]);
  return Number(row!.id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  ids.acme = await take('companies/acme-example', 'Acme-example will reach $5M ARR by the end of 2024', '2023-02-01');
  ids.cobalt = await take('companies/cobalt-example', 'Cobalt-example has the strongest team in its market', '2023-03-01');
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('gbrain takes horizon', () => {
  test('scan previews without writing, then --apply writes', async () => {
    const preview = JSON.parse(await capture(() => runTakes(engine, ['horizon', 'scan', '--json'])));
    expect(preview).toMatchObject({ applied: false, written: 0, unparsed: 1 });
    expect(preview.proposed).toEqual([expect.objectContaining({ take_id: ids.acme, horizon_date: '2024-12-31', basis: 'stated', phrase: 'by the end of 2024' })]);
    expect((await readTakeHorizons(engine)).size).toBe(0);
    const text = await capture(() => runTakes(engine, ['horizon', 'scan']));
    expect(text).toContain('1 stated horizon(s) to write');
    expect(text).toContain('gbrain takes horizon scan --apply');
    const applied = JSON.parse(await capture(() => runTakes(engine, ['horizon', 'scan', '--apply', '--json'])));
    expect(applied).toMatchObject({ applied: true, written: 1 });
    expect((await readTakeHorizons(engine)).get(ids.acme!)).toMatchObject({ horizon_date: '2024-12-31', basis: 'stated' });
  });

  test('set and clear address a take by slug and row', async () => {
    await capture(() => runTakes(engine, ['horizon', 'set', 'companies/cobalt-example', '--row', '1', '--date', '2025-06-30']));
    expect((await readTakeHorizons(engine)).get(ids.cobalt!)).toMatchObject({ horizon_date: '2025-06-30', basis: 'owner', current: true });
    const out = await capture(() => runTakes(engine, ['horizon', 'clear', 'companies/cobalt-example', '--row', '1']));
    expect(out).toContain('Cleared the horizon of companies/cobalt-example#1');
    expect((await readTakeHorizons(engine)).has(ids.cobalt!)).toBe(false);
  });

  test('refuses a missing take, a malformed date and an unknown subcommand', async () => {
    expect(await exitOf(() => runTakes(engine, ['horizon', 'set', 'companies/none-example', '--row', '1', '--date', '2025-06-30']))).toMatchObject({ code: 1, stderr: expect.stringContaining('No take companies/none-example#1') });
    expect(await exitOf(() => runTakes(engine, ['horizon', 'set', 'companies/cobalt-example', '--row', '1', '--date', '2025-13-01']))).toMatchObject({ code: 1, stderr: expect.stringContaining('YYYY-MM-DD') });
    expect(await exitOf(() => runTakes(engine, ['horizon', 'set', 'companies/cobalt-example', '--date', '2025-06-30']))).toMatchObject({ code: 1, stderr: expect.stringContaining('--row') });
    expect(await exitOf(() => runTakes(engine, ['horizon', 'bogus']))).toMatchObject({ code: 1, stderr: expect.stringContaining('Usage: gbrain takes horizon') });
  });
});
