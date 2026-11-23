/**
 * `gbrain takes list <slug>` and `gbrain takes revisit <slug>` reach the takes and the file of a page stored under an
 * older spelling of its name (capitals, or decomposed accents) when the caller types that spelling.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: `takes list <stored spelling> --json` returns that page's takes, as the `takes_list` operation does;
 *     `takes revisit <stored spelling>` opens the file the stored spelling names.
 *  2. Regression: both commands ran `normalizeSlug` on the typed slug and looked only at the normal form, so a page stored
 *     with capitals or decomposed accents answered "No takes" / "Page not found" by the very name it is stored under.
 *  3. Existing coverage: test/takes-horizon-cli.test.ts covers `takes horizon` by a stored spelling, not list or revisit.
 *  4. Seam: none. A real PGLite engine and the CLI command; revisit gets a temp brain repo and `EDITOR=true`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTakes } from '../src/commands/takes.ts';

let engine: PGLiteEngine;

async function capture(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}

/** A page with one take, stored under `stored` the way an older writer left it. */
async function storeWithTake(stored: string, claim: string): Promise<void> {
  const seed = `companies/seed-${Math.random().toString(36).slice(2, 8)}`;
  await engine.putPage(seed, { type: 'company', title: claim, compiled_truth: 'Body.' });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [stored, seed]);
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [stored]);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim, kind: 'bet', holder: 'world', weight: 0.7, since_date: '2025-01-01' }]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('takes list by a stored spelling', () => {
  test('a page stored with capitals lists its take by that spelling', async () => {
    await storeWithTake('Companies/Acme-Example', 'Capital claim');
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', 'Companies/Acme-Example', '--json'])));
    expect(json.map((t: { claim: string }) => t.claim)).toEqual(['Capital claim']);
  });

  test('a page stored with a decomposed accent lists its take by that spelling', async () => {
    await storeWithTake('companies/cafe\u0301-example', 'Decomposed claim');
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', 'companies/cafe\u0301-example', '--json'])));
    expect(json.map((t: { claim: string }) => t.claim)).toEqual(['Decomposed claim']);
  });
});

describe('takes revisit by a stored spelling', () => {
  test('opens the file the stored capitalised spelling names', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-revisit-'));
    const repo = join(home, 'brain');
    mkdirSync(join(repo, 'Companies'), { recursive: true });
    const file = join(repo, 'Companies', 'Revisit-Example.md');
    writeFileSync(file, '---\ntitle: Revisit\n---\nBody.\n');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', sync: { repo_path: repo } }));
    const env = { GBRAIN_HOME: process.env.GBRAIN_HOME, EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL };
    process.env.GBRAIN_HOME = home; process.env.EDITOR = 'true'; delete process.env.VISUAL;
    const exit = process.exit;
    let exitCode: number | undefined;
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`exit ${code}`); };
    (process.stderr as { write: unknown }).write = (s: string) => { stderr.push(String(s)); return true; };
    try {
      await runTakes(engine, ['revisit', 'Companies/Revisit-Example']).catch(() => {});
    } finally {
      (process as { exit: unknown }).exit = exit;
      (process.stderr as { write: unknown }).write = write;
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const opened = { exitCode: exitCode ?? 0, notFound: stderr.some(s => s.includes('Page not found')), marked: readFileSync(file, 'utf8').includes('<!-- gbrain:revisit -->') };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, notFound: false, marked: true });
  });
});
