/**
 * `gbrain export` on a Rust-engine brain writes the same file tree, byte for byte, as on a PGLite brain.
 *
 * Two corpora, each written into a PGLite brain and a Rust brain, then exported through the real CLI entry
 * (`src/cli.ts export --dir`, one child process per brain); the two trees must hold the same files with the same bytes.
 *  - The census corpus: test/fixtures/rust-cli-parity-brain (the 20 pages of the executeRaw census,
 *    docs/research/rust-cli-executeraw-map.md), written with `import --no-embed`.
 *  - The withdrawal corpus: a page readable by one member only, a page with a facts fence one of whose rows is
 *    withdrawn (the export strikes it through), a page with raw data (its `.raw/<slug>.json` file), tagged pages, and
 *    a page stored in segments. The plain pages are imported through the CLI; the rest is written through the same
 *    typed engine members on both engines (putPage, addTag, putRawData, insertFactWithdrawal and the segmented-body
 *    members), because the Rust CLI import refuses a facts-fenced page and a page large enough to be stored in segments.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: the export contract on a Rust brain: which pages are exported, the frontmatter, tags, withdrawal
 *    overlay, raw data and the streamed body of a segmented page, end to end through the CLI.
 * 2. Fails when: the Rust brain refuses the export (a member it does not serve) or writes any file differently from
 *    PGLite: a missing or extra file, or other bytes.
 * 3. Existing coverage: test/export-snapshot.test.ts and test/export*.test.ts run the export on PGLite and Postgres
 *    only; the engine parity suite compares single members, never the whole export.
 * 4. Seams: none in the export. The withdrawal corpus is written in process through typed members on both engines (no
 *    SQL). It needs the addon `bun run rust:build` writes; it skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes
 *    a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { publishSegmentedPage, segmentText } from './helpers/page-body-fixtures.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const CENSUS = join(ROOT, 'test', 'fixtures', 'rust-cli-parity-brain');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Backend = 'pglite' | 'rust';
interface Brain { backend: Backend; home: string; db: string }
interface Run { exitCode: number; stdout: string; stderr: string }

let root = '';

function childEnv(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
  }
  return {
    ...out, HOME: brain.home, GBRAIN_HOME: brain.home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0', TZ: 'UTC', ...(brain.backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function makeBrain(backend: Backend, name: string): Brain {
  const home = join(root, name, backend, 'home');
  const db = join(root, name, backend, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, database_path: db }));
  return { backend, home, db };
}

/** Every file under `dir`, by relative path, with its bytes. */
function tree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path));
    }
  };
  walk(dir);
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function expectOk(run: Run, what: string): void {
  if (run.exitCode !== 0) throw new Error(`${what} exited ${run.exitCode}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
}

/** Export both brains and compare the trees, file for file, byte for byte. Returns the file list. */
async function exportBoth(pglite: Brain, rust: Brain, name: string): Promise<string[]> {
  const out = { pglite: join(root, name, 'out-pglite'), rust: join(root, name, 'out-rust') };
  expectOk(await cli(pglite, ['export', '--dir', out.pglite]), `PGLite export of ${name}`);
  expectOk(await cli(rust, ['export', '--dir', out.rust]), `Rust export of ${name}`);
  const want = tree(out.pglite);
  const got = tree(out.rust);
  expect([...got.keys()]).toEqual([...want.keys()]);
  for (const [path, bytes] of want) {
    const rustBytes = got.get(path);
    if (!rustBytes || !rustBytes.equals(bytes)) expect({ path, text: rustBytes?.toString('utf8') }).toEqual({ path, text: bytes.toString('utf8') });
  }
  return [...want.keys()];
}

// ---- the withdrawal corpus --------------------------------------------------------------------------------------

const PLAIN = {
  'notes/plain.md': '---\ntype: note\ntitle: Plain note\ntags: [misc]\n---\n\n# Plain note\n\nA plain page with one tag.\n',
  'private/secret-plan.md': '---\ntype: note\ntitle: Secret plan\nreadable_by: [alice-example]\n---\n\n# Secret plan\n\nOnly alice-example may read this page.\n',
};

const FACTS = renderFactsTable([
  { rowNum: 1, claim: 'Alice lives in Springfield', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', active: true, context: '' },
  { rowNum: 2, claim: 'Alice founded a-company', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true, context: '' },
  { rowNum: 3, claim: 'Alice   LIKES tea', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'low', active: true, context: '' },
]);

/** A segment of the segmented page: `lines` numbered lines. */
function segmentLines(from: number, lines: number): string {
  let text = '';
  for (let i = from; i < from + lines; i++) text += `Line ${i}: the quick brown fox jumps over the lazy dog, entry ${i} of the segmented log.\n`;
  return text;
}

/** The pages the Rust CLI import refuses, written through typed members (the same calls on both engines). */
async function writeMemberPages(engine: BrainEngine): Promise<void> {
  await engine.putPage('people/alice-example', {
    type: 'person', title: 'Alice Example', compiled_truth: `# Alice Example\n\nAlice runs a-company.\n\n## Facts\n\n${FACTS}`,
    timeline: '- 2026-01-02: Alice met charlie-example.', frontmatter: { type: 'person', title: 'Alice Example' },
  });
  await engine.addTag('people/alice-example', 'founder');
  await engine.addTag('people/alice-example', 'example');
  await engine.putRawData('people/alice-example', 'crm-example', { name: 'Alice', n: 1 });
  await engine.insertFactWithdrawal('default', 'world', 'Alice   LIKES tea', 'people/alice-example', '2026-01-03T00:00:00.000Z');
  await engine.insertFactWithdrawal('default', 'world', 'A claim on no page', '*', '2026-01-04T00:00:00.000Z');
  await publishSegmentedPage(engine, 'logs/segmented-log', [segmentText(segmentLines(0, 40)), segmentText(segmentLines(40, 25)), segmentText(segmentLines(65, 3))]);
  await engine.addTag('logs/segmented-log', 'log');
}

async function withEngine(brain: Brain, fn: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const engine: BrainEngine = brain.backend === 'rust'
    ? openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } }), databasePath: brain.db })
    : new PGLiteEngine();
  await engine.connect({ engine: brain.backend, database_path: brain.db } as never);
  try { await fn(engine); } finally { await engine.disconnect(); }
}

describe.skipIf(!HAVE_ADDON)('gbrain export on a Rust brain', () => {
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-rust-export-')); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test('the census corpus exports the same file tree as PGLite', async () => {
    const pglite = makeBrain('pglite', 'census');
    const rust = makeBrain('rust', 'census');
    expectOk(await cli(pglite, ['import', CENSUS, '--no-embed']), 'PGLite import');
    expectOk(await cli(rust, ['import', CENSUS, '--no-embed']), 'Rust import');
    const files = await exportBoth(pglite, rust, 'census');
    expect(files.filter(f => f.endsWith('.md')).length).toBe(20);
  }, 240_000);

  test('private pages, withdrawn facts, raw data and a segmented page export the same file tree as PGLite', async () => {
    const corpus = join(root, 'withdrawal-corpus');
    for (const [path, text] of Object.entries(PLAIN)) {
      mkdirSync(join(corpus, path, '..'), { recursive: true });
      writeFileSync(join(corpus, path), text);
    }
    const pglite = makeBrain('pglite', 'withdrawal');
    const rust = makeBrain('rust', 'withdrawal');
    for (const brain of [pglite, rust]) {
      expectOk(await cli(brain, ['import', corpus, '--no-embed']), `${brain.backend} import`);
      await withEngine(brain, writeMemberPages);
    }
    const files = await exportBoth(pglite, rust, 'withdrawal');
    expect(files).toEqual(['.gbrain-export-status', 'logs/segmented-log.md', 'notes/plain.md', 'people/.raw/alice-example.json',
      'people/alice-example.md', 'private/secret-plan.md']);
    const alice = readFileSync(join(root, 'withdrawal', 'out-rust', 'people/alice-example.md'), 'utf8');
    expect(alice).toContain('~~Alice   LIKES tea~~');
    expect(alice).toContain('| 2 | Alice founded a-company |');
    const log = readFileSync(join(root, 'withdrawal', 'out-rust', 'logs/segmented-log.md'), 'utf8');
    expect(log).toContain('Line 67: the quick brown fox');
  }, 240_000);
});
