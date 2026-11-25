/**
 * `gbrain takes list <slug>` and `gbrain takes revisit <slug>` reach the takes and the file of a page stored under an
 * older spelling of its name (capitals, or decomposed accents) when the caller types that spelling.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: `takes list <stored spelling> --json` returns that page's takes, as the `takes_list` operation does;
 *     `takes revisit <stored spelling>` opens the file the stored spelling names.
 *  2. Regression: both commands ran `normalizeSlug` on the typed slug and looked only at the normal form, so a page stored
 *     with capitals or decomposed accents answered "No takes" / "Page not found" by the very name it is stored under.
 *     Also pinned: a deleted page under the typed spelling never hides its live twin, a name in normal form and a list with no
 *     page read as before, two sources holding one slug both list, and revisit opens the file the chosen page records (inside
 *     the source root, never a decoy under the typed name).
 *  3. Existing coverage: test/takes-horizon-cli.test.ts covers `takes horizon` by a stored spelling, not list or revisit.
 *  4. Seam: none. A real PGLite engine and the CLI command; revisit gets a temp brain repo and `EDITOR=true`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTakes } from '../src/commands/takes.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

async function capture(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}

/** A page with one take, stored under `stored` the way an older writer left it. */
async function storeWithTake(stored: string, claim: string, opts: { sourceId?: string; deleted?: boolean; sourcePath?: string } = {}): Promise<void> {
  const sourceId = opts.sourceId ?? 'default';
  if (sourceId !== 'default') await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [sourceId]);
  const seed = `companies/seed-${Math.random().toString(36).slice(2, 8)}`;
  await engine.putPage(seed, { type: 'company', title: claim, compiled_truth: 'Body.' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [stored, seed, sourceId]);
  if (opts.deleted) await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE slug = $1 AND source_id = $2', [stored, sourceId]);
  if (opts.sourcePath) await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE slug = $2 AND source_id = $3', [opts.sourcePath, stored, sourceId]);
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [stored, sourceId]);
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

  test('a deleted page stored under the typed spelling does not hide its live normal-form twin', async () => {
    await storeWithTake('Companies/Twin-Example', 'Deleted claim', { deleted: true });
    await storeWithTake('companies/twin-example', 'Live claim');
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', 'Companies/Twin-Example', '--json'])));
    expect(json.map((t: { claim: string }) => t.claim)).toEqual(['Live claim']);
  });

  test('a name already in normal form lists what it lists today', async () => {
    await storeWithTake('companies/normal-example', 'Normal claim');
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', 'companies/normal-example', '--json'])));
    expect(json.map((t: { claim: string }) => t.claim)).toEqual(['Normal claim']);
  });

  test('a list with no page lists every active take, as the engine does', async () => {
    const expected = JSON.parse(JSON.stringify(await engine.listTakes({ active: true })));
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', '--json'])));
    expect(expected.length).toBeGreaterThan(0);
    expect(json).toEqual(expected);
  });

  test('a normal-form name held by two sources lists both, as today', async () => {
    await storeWithTake('companies/shared-example', 'Default shared claim');
    await storeWithTake('companies/shared-example', 'Other shared claim', { sourceId: 'other-src' });
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', 'companies/shared-example', '--json'])));
    expect(json.map((t: { claim: string }) => t.claim).sort()).toEqual(['Default shared claim', 'Other shared claim']);
  });

  test('a stored spelling held by two sources lists both', async () => {
    await storeWithTake('Companies/Dup-Example', 'Default dup claim');
    await storeWithTake('Companies/Dup-Example', 'Other dup claim', { sourceId: 'other-src' });
    const json = JSON.parse(await capture(() => runTakes(engine, ['list', 'Companies/Dup-Example', '--json'])));
    expect(json.map((t: { claim: string }) => t.claim).sort()).toEqual(['Default dup claim', 'Other dup claim']);
  });

  test('two stored spellings of one name, neither typed, are refused and named', async () => {
    await storeWithTake('Companies/Amb-Example', 'First ambiguous claim');
    await storeWithTake('COMPANIES/amb-example', 'Second ambiguous claim');
    const exit = process.exit;
    const errors: string[] = [];
    const error = console.error;
    let exitCode: number | undefined;
    (process as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`exit ${code}`); };
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      await runTakes(engine, ['list', 'companies/Amb-example', '--json']).catch(() => {});
    } finally {
      (process as { exit: unknown }).exit = exit;
      console.error = error;
    }
    expect({ exitCode, names: errors.join('\n').includes('Companies/Amb-Example') && errors.join('\n').includes('COMPANIES/amb-example') }).toEqual({ exitCode: 1, names: true });
  });
});

/** A temp home with a brain repo configured as `sync.repo_path`. */
function newBrain(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-revisit-'));
  const repo = join(home, 'brain');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', sync: { repo_path: repo } }));
  return { home, repo };
}

function writeMarkdown(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '---\ntitle: Revisit\n---\nBody.\n');
  return file;
}

const marked = (file: string): boolean => readFileSync(file, 'utf8').includes('<!-- gbrain:revisit -->');

/** Runs `takes revisit <typed>` against the brain in `home` with `EDITOR=true`; returns the exit code and what it wrote to stderr. */
async function revisit(typed: string, home: string): Promise<{ exitCode: number; stderr: string }> {
  const exit = process.exit;
  let exitCode = 0;
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; throw new Error(`exit ${code}`); };
  (process.stderr as { write: unknown }).write = (s: string) => { stderr.push(String(s)); return true; };
  try {
    await withEnv({ GBRAIN_HOME: home, EDITOR: 'true', VISUAL: undefined }, () => runTakes(engine, ['revisit', typed]).catch(() => {}));
  } finally {
    (process as { exit: unknown }).exit = exit;
    (process.stderr as { write: unknown }).write = write;
  }
  return { exitCode, stderr: stderr.join('') };
}

describe('takes revisit by a stored spelling', () => {
  test('opens the file the stored capitalised spelling names', async () => {
    await storeWithTake('Companies/Revisit-Example', 'Revisit claim');
    const { home, repo } = newBrain();
    const file = writeMarkdown(join(repo, 'Companies', 'Revisit-Example.md'));
    const result = await revisit('Companies/Revisit-Example', home);
    const opened = { exitCode: result.exitCode, notFound: result.stderr.includes('Page not found'), marked: marked(file) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, notFound: false, marked: true });
  });

  test('a name in normal form opens the file under that name', async () => {
    await storeWithTake('companies/plain-revisit-example', 'Plain claim');
    const { home, repo } = newBrain();
    const file = writeMarkdown(join(repo, 'companies', 'plain-revisit-example.md'));
    const result = await revisit('companies/plain-revisit-example', home);
    const opened = { exitCode: result.exitCode, marked: marked(file) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, marked: true });
  });

  test('opens the page the name selects, never a decoy file under the typed name', async () => {
    await storeWithTake('companies/decoy-example', 'Decoy claim', { sourcePath: 'notes/real-example.md' });
    const { home, repo } = newBrain();
    const real = writeMarkdown(join(repo, 'notes', 'real-example.md'));
    const decoy = writeMarkdown(join(repo, 'Companies', 'Decoy-Example.md'));
    const result = await revisit('Companies/Decoy-Example', home);
    const opened = { exitCode: result.exitCode, real: marked(real), decoy: marked(decoy) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, real: true, decoy: false });
  });

  test('opens the file recorded for a page in a source inside a git checkout', async () => {
    const { home, repo } = newBrain();
    mkdirSync(join(repo, '.git'), { recursive: true });
    const file = writeMarkdown(join(repo, 'public', 'Companies', 'Git-Example.md'));
    await storeWithTake('Companies/Git-Example', 'Git claim', { sourceId: 'git-src', sourcePath: 'public/Companies/Git-Example.md' });
    // A git-synced source records paths from the git root and pins that mode.
    await engine.executeRaw(`UPDATE sources SET local_path = $1, config = jsonb_build_object('slug_root_mode', 'git-root') WHERE id = $2`, [join(repo, 'public'), 'git-src']);
    const result = await revisit('Companies/Git-Example', home);
    const opened = { exitCode: result.exitCode, notFound: result.stderr.includes('Page not found'), marked: marked(file) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, notFound: false, marked: true });
  });

  test('refuses a recorded path that leaves the source root, and leaves that file alone', async () => {
    await storeWithTake('companies/escape-example', 'Escape claim', { sourcePath: '../outside/escape-example.md' });
    const { home } = newBrain();
    const outside = writeMarkdown(join(home, 'outside', 'escape-example.md'));
    const result = await revisit('Companies/Escape-Example', home);
    const opened = { exitCode: result.exitCode, refused: result.stderr.includes('inside the source root'), marked: marked(outside) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 1, refused: true, marked: false });
  });

  test('refuses a recorded path that a symlink carries out of the source root', async () => {
    await storeWithTake('companies/link-example', 'Link claim', { sourcePath: 'link/link-example.md' });
    const { home, repo } = newBrain();
    const outside = writeMarkdown(join(home, 'elsewhere', 'link-example.md'));
    symlinkSync(join(home, 'elsewhere'), join(repo, 'link'));
    const result = await revisit('Companies/Link-Example', home);
    const opened = { exitCode: result.exitCode, refused: result.stderr.includes('inside the source root'), marked: marked(outside) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 1, refused: true, marked: false });
  });

  test('opens a historical page whose recorded path is only the file name, in the brain repo', async () => {
    await storeWithTake('journal/daily-note', 'Daily claim', { sourcePath: 'daily-note.md' });
    const { home, repo } = newBrain();
    const file = writeMarkdown(join(repo, 'journal', 'daily-note.md'));
    const result = await revisit('journal/daily-note', home);
    const opened = { exitCode: result.exitCode, notFound: result.stderr.includes('Page not found'), marked: marked(file) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, notFound: false, marked: true });
  });

  test('opens a page whose recorded file is an .mdx file, in the brain repo', async () => {
    await storeWithTake('notes/mdx-example', 'Mdx claim', { sourcePath: 'notes/mdx-example.mdx' });
    const { home, repo } = newBrain();
    const file = writeMarkdown(join(repo, 'notes', 'mdx-example.mdx'));
    const result = await revisit('notes/mdx-example', home);
    const opened = { exitCode: result.exitCode, notFound: result.stderr.includes('Page not found'), marked: marked(file) };
    rmSync(home, { recursive: true, force: true });
    expect(opened).toEqual({ exitCode: 0, notFound: false, marked: true });
  });

  test.each([
    ['a clone gbrain owns', { managed_clone: true }],
    ['a read-only mirror', { mirror_read_only: true }],
  ])('leaves the checkout of %s unchanged and refuses', async (_label, config) => {
    const slugName = `Clone-Example-${Object.keys(config)[0]!.slice(0, 3)}`;
    const { home } = newBrain();
    const checkout = join(home, 'checkout');
    const file = writeMarkdown(join(checkout, 'Companies', `${slugName}.md`));
    const before = readFileSync(file, 'utf8');
    const id = `ro-src-${Object.keys(config)[0]!.slice(0, 3)}`;
    await storeWithTake(`Companies/${slugName}`, 'Clone claim', { sourceId: id, sourcePath: `Companies/${slugName}.md` });
    await engine.executeRaw('UPDATE sources SET local_path = $1, config = $2::jsonb WHERE id = $3', [checkout, JSON.stringify(config), id]);
    const result = await revisit(`Companies/${slugName}`, home);
    const after = readFileSync(file, 'utf8');
    rmSync(home, { recursive: true, force: true });
    expect({ exitCode: result.exitCode, refused: result.stderr.includes('read-only'), unchanged: after === before }).toEqual({ exitCode: 1, refused: true, unchanged: true });
  });
});
