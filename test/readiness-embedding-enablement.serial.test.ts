/**
 * The A7 embedding-enablement E2E matrix (named in the agent operator wave
 * spec): default path, custom path, mounted brain, legacy dimensions and
 * multiple providers. Each case builds a keyless PGLite brain with imported
 * pages and a DB-only `remember` fact, asks readiness for the enable command
 * (`embeddingEnablement`), runs exactly that argv through the real CLI, and
 * proves the pages and the fact survived and their vectors are queued.
 *
 * Protects: the "turn on embeddings" fix an agent runs verbatim. The recipe it
 * replaced moved the datastore aside and lost every DB-only fact; a fix that
 * targets the wrong datastore (default path for a custom/mounted brain, a
 * width the column cannot hold) fails here.
 *
 * Serial: spawns the CLI and opens PGLite datastores in tmpdirs. No provider
 * is ever called: children run under test/helpers/no-network-preload.ts, keys
 * are fake, and the init-time embed check is skipped.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddingEnablement } from '../src/core/readiness.ts';
import { loadConfigFileOnly } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countStaleFactEmbeddings } from '../src/core/facts/embedding-identity.ts';
import { listRecipes } from '../src/core/ai/recipes/index.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const NO_NET = join(REPO, 'test', 'helpers', 'no-network-preload.ts');
const PROVIDER_ENVS = [...new Set(listRecipes().flatMap(r => r.auth_env?.required ?? []))];
const FACT = 'The launch window opens in March';
const roots: string[] = [];

afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-a7-${label}-`));
  roots.push(dir);
  return dir;
}

async function cli(args: string[], home: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of [...PROVIDER_ENVS, 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_MODEL']) delete env[k];
  Object.assign(env, { HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_INIT_SKIP_EMBED_CHECK: '1', ...extra });
  const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', NO_NET, CLI, ...args], { cwd: REPO, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => { try { proc.kill(9); } catch { /* exited */ } }, 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) console.error(`--- gbrain ${args.join(' ')} (exit ${exitCode}) ---\n${stdout}\n${stderr}`);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(killer);
  }
}

/** A keyless brain at `home` (or `--path`), with two imported pages and one DB-only remembered fact. */
async function seed(home: string, initArgs: string[], extra: Record<string, string> = {}): Promise<void> {
  const notes = join(home, 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'alpha.md'), '# Alpha\n\nAlpha page about rockets and propulsion.\n');
  writeFileSync(join(notes, 'beta.md'), '# Beta\n\nBeta page about gardens and soil.\n');
  expect((await cli(['init', ...initArgs], home, extra)).exitCode).toBe(0);
}

async function fill(home: string, extra: Record<string, string> = {}): Promise<void> {
  expect((await cli(['import', join(home, 'notes'), '--no-embed'], home, extra)).exitCode).toBe(0);
  expect((await cli(['remember', FACT, '--provenance', 'user said in chat'], home, extra)).exitCode).toBe(0);
}

interface BrainState { pages: number; chunks: number; facts: string[]; staleChunks: number; staleFacts: number }

async function inspect(dbPath: string, model: string, dims: number): Promise<BrainState> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  try {
    const [pages] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL');
    const [chunks] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks');
    const facts = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts ORDER BY id');
    return {
      pages: pages.n, chunks: chunks.n, facts: facts.map(f => f.fact),
      staleChunks: await engine.countStaleChunks(),
      staleFacts: (await countStaleFactEmbeddings(engine, model, dims)).count,
    };
  } finally {
    await engine.disconnect();
  }
}

function enablementFor(home: string, keys: Record<string, string>, brainId?: string) {
  const clear: Record<string, string | undefined> = { GBRAIN_HOME: home, HOME: home, GBRAIN_BRAIN_ID: brainId, GBRAIN_MODEL: undefined };
  for (const k of PROVIDER_ENVS) clear[k] = undefined;
  return withEnv({ ...clear, ...keys }, async () => embeddingEnablement(loadConfigFileOnly()!));
}

/** Run the fix exactly as an agent would, then prove pages + facts kept and vectors queued. */
async function enableAndVerify(home: string, dbPath: string, keys: Record<string, string>, brainId?: string) {
  const fix = await enablementFor(home, keys, brainId);
  expect(fix.requires_exclusive).toBe(true);
  expect(fix.consent).toEqual(['credentials', 'paid']);
  expect(fix.actor).toBe('agent');
  expect(fix.argv?.[0]).toBe('gbrain');
  const model = fix.argv![fix.argv!.indexOf('--embedding-model') + 1];
  const dims = Number(fix.argv![fix.argv!.indexOf('--embedding-dimensions') + 1]);
  const before = await inspect(dbPath, model, dims);
  expect(before.pages).toBe(2);
  expect(before.facts).toContain(FACT);
  const run = await cli(fix.argv!.slice(1), home, keys);
  expect(run.exitCode).toBe(0);
  const after = await inspect(dbPath, model, dims);
  expect(after.pages).toBe(before.pages);
  expect(after.facts).toEqual(before.facts);
  expect(after.chunks).toBe(before.chunks);
  expect(after.chunks).toBeGreaterThan(0);
  expect(after.staleChunks).toBe(after.chunks);
  expect(after.staleFacts).toBeGreaterThanOrEqual(1);
  const cfg = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
  expect(cfg.embedding_model).toBe(model);
  expect(cfg.embedding_dimensions).toBe(dims);
  expect(cfg.embedding_disabled).toBeUndefined();
  return { fix, model, dims, cfg };
}

describe('A7 embedding-enablement E2E matrix', () => {
  test('default path', async () => {
    const home = scratch('default');
    await seed(home, ['--pglite', '--no-embedding']);
    await fill(home);
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    const { fix, cfg } = await enableAndVerify(home, dbPath, { VOYAGE_API_KEY: 'test-voyage-key' });
    expect(fix.argv).toEqual(['gbrain', 'init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024', '--path', dbPath]);
    expect(cfg.database_path).toBe(dbPath);
  }, 300_000);

  test('custom path', async () => {
    const home = scratch('custom');
    const dbPath = join(home, 'elsewhere', 'brain.pglite');
    await seed(home, ['--pglite', '--no-embedding', '--path', dbPath]);
    await fill(home);
    const { fix, cfg } = await enableAndVerify(home, dbPath, { VOYAGE_API_KEY: 'test-voyage-key' });
    expect(fix.argv?.slice(-2)).toEqual(['--path', dbPath]);
    expect(cfg.database_path).toBe(dbPath);
  }, 300_000);

  test('mounted brain', async () => {
    const host = scratch('host');
    await seed(host, ['--pglite', '--no-embedding']);
    const mountHome = scratch('mount');
    const mountDb = join(mountHome, 'team.pglite');
    await seed(mountHome, ['--pglite', '--no-embedding', '--path', mountDb]);
    await fill(mountHome);
    const clone = join(mountHome, 'clone');
    mkdirSync(clone, { recursive: true });
    expect((await cli(['mounts', 'add', 'team', '--path', clone, '--engine', 'pglite', '--db-path', mountDb], host)).exitCode).toBe(0);
    const hostDb = join(host, '.gbrain', 'brain.pglite');
    const { fix, cfg } = await enableAndVerify(host, mountDb, { VOYAGE_API_KEY: 'test-voyage-key' }, 'team');
    expect(fix.argv).toEqual(['gbrain', 'embeddings', 'enable', '--brain', 'team', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024']);
    expect(cfg.database_path).toBe(hostDb);
  }, 300_000);

  test('legacy dimensions', async () => {
    const home = scratch('legacy');
    await seed(home, ['--pglite', '--embedding-model', 'openai:text-embedding-3-small'], { OPENAI_API_KEY: 'test-openai-key' });
    const cfgPath = join(home, '.gbrain', 'config.json');
    const legacy = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(legacy.embedding_dimensions).toBe(1536);
    delete legacy.embedding_model;
    legacy.embedding_disabled = true;
    writeFileSync(cfgPath, JSON.stringify(legacy, null, 2));
    await fill(home);
    const { model, dims } = await enableAndVerify(home, join(home, '.gbrain', 'brain.pglite'),
      { VOYAGE_API_KEY: 'test-voyage-key', OPENAI_API_KEY: 'test-openai-key' });
    expect(model).toMatch(/^openai:/);
    expect(dims).toBe(1536);
  }, 300_000);

  test('multiple providers', async () => {
    const home = scratch('multi');
    await seed(home, ['--pglite', '--no-embedding']);
    await fill(home);
    const { model, dims } = await enableAndVerify(home, join(home, '.gbrain', 'brain.pglite'),
      { VOYAGE_API_KEY: 'test-voyage-key', OPENAI_API_KEY: 'test-openai-key', MISTRAL_API_KEY: 'test-mistral-key' });
    expect(model).toBe('voyage:voyage-4');
    expect(dims).toBe(1024);
  }, 300_000);
});
