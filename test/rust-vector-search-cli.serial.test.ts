/**
 * `gbrain search --match hybrid` on a Rust-engine brain finds a page through its vector arm.
 *
 * One page is imported with an embedding through the real CLI entry (`src/cli.ts`, one child process per command),
 * on a Rust brain and on a PGLite brain. The embedding provider is a local OpenAI-compatible mock (no network, no
 * key): a text that names the westerly wind, and the query word "zephyr", get the same unit vector; every other text
 * gets an orthogonal one. "zephyr" appears in no page, so only the vector arm can find the westerly page; a keyword
 * fallback returns nothing for it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: hybrid search on a Rust brain, end to end: import with embeddings, the query embedding, searchVector,
 *    the cosine re-score (cosinesByChunkIds) and fusion, with no capability refusal on the way.
 * 2. Fails when: the Rust engine refuses searchVector or cosinesByChunkIds (hybrid then answers from keywords only and
 *    misses the page, or logs the refusal), or ranks the vector hit differently from PGLite.
 * 3. Existing coverage: test/engine-parity/search.test.ts and search-reads.test.ts compare searchVector and
 *    cosinesByChunkIds in process; test/rust-cli-parity.serial.test.ts runs the CLI on a brain with no embeddings.
 *    Nothing runs a hybrid CLI search with vectors on a Rust brain.
 * 4. Seams: the embedding provider is a local mock server (LLAMA_SERVER_BASE_URL). It needs the addon
 *    `bun run rust:build` writes; it skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an
 *    error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  || (TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '');
const HAVE_ADDON = !!ADDON && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

// The Rust store keeps 1536-dimension vectors, the default embedding width.
const DIMS = 1536;
type Backend = 'pglite' | 'rust';
interface Run { exitCode: number; stdout: string; stderr: string }

/** The westerly page and the query word share axis 0; everything else lies on axis 1. */
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[/westerly|zephyr/i.test(text) ? 0 : 1] = 1;
  return v;
}

let root = '';
let notes = '';
let server: ReturnType<typeof Bun.serve> | undefined;

function env(backend: Backend): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
  }
  const home = join(root, backend);
  return {
    ...out,
    HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    LLAMA_SERVER_BASE_URL: `http://127.0.0.1:${server!.port}/v1`,
    ...(backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(backend: Backend, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(backend), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function makeBrain(backend: Backend): void {
  const home = join(root, backend);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: backend,
    database_path: join(home, 'db'),
    embedding_model: 'llama-server:test-model',
    embedding_dimensions: DIMS,
  }));
}

/** The imported, embedded brain's hybrid search for "zephyr". */
async function zephyr(backend: Backend): Promise<{ run: Run; slugs: string[]; rows: unknown[] }> {
  const imported = await cli(backend, ['import', notes, '--json']);
  if (imported.exitCode !== 0) throw new Error(`${backend} import failed (${imported.exitCode}): ${imported.stdout}\n${imported.stderr}`);
  const run = await cli(backend, ['search', 'zephyr', '--match', 'hybrid', '--json']);
  let hits: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(run.stdout) as unknown;
    hits = (Array.isArray(parsed) ? parsed : ((parsed as { results?: unknown[] }).results ?? [])) as typeof hits;
  } catch { /* the expectations below report the raw output */ }
  const round = (n: unknown) => (typeof n === 'number' ? Math.round(n * 1e6) / 1e6 : n);
  const rows = hits.map((r) => ({ slug: r.slug, chunk_text: r.chunk_text, score: round(r.score), cosine: round(r.cosine), evidence: r.evidence }));
  return { run, slugs: hits.map((r) => String(r.slug ?? '')), rows };
}

describe.skipIf(!HAVE_ADDON)('hybrid CLI search on a Rust brain reads the vector arm', () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith('/embeddings')) {
          const body = await req.json() as { input: string | string[] };
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          return Response.json({
            data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text) })),
            usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
          });
        }
        return Response.json({ data: [{ id: 'test-model' }] });
      },
    });
    root = mkdtempSync(join(tmpdir(), 'gb-rust-vector-cli-'));
    notes = join(root, 'notes');
    mkdirSync(join(notes, 'notes'), { recursive: true });
    writeFileSync(join(notes, 'notes', 'westerly.md'),
      '---\ntype: note\ntitle: Morning wind\n---\n\nA westerly breeze crossed the valley at dawn and bent the long grass.\n');
    writeFileSync(join(notes, 'notes', 'ledger.md'),
      '---\ntype: note\ntitle: Quarterly ledger\n---\n\nThe quarterly ledger lists totals, invoices and payments.\n');
    makeBrain('pglite');
    makeBrain('rust');
  });

  afterAll(() => {
    server?.stop(true);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('the westerly page comes back first on both engines, with no capability refusal on Rust', async () => {
    const [pglite, rust] = await Promise.all([zephyr('pglite'), zephyr('rust')]);
    const report = (r: { run: Run }) => `exit ${r.run.exitCode}\n${r.run.stdout}\n${r.run.stderr}`;
    expect(pglite.run.exitCode, report(pglite)).toBe(0);
    expect(pglite.slugs[0], report(pglite)).toBe('notes/westerly');
    expect(rust.run.exitCode, report(rust)).toBe(0);
    // Other members of this line still refuse raw_sql (last-retrieved write-back, the notifier); only the vector path
    // is under test here.
    expect(rust.run.stderr, report(rust)).not.toMatch(/vector_search|searchVector|cosinesByChunkIds/);
    expect(rust.rows, report(rust)).toEqual(pglite.rows);
  }, 480_000);
});
