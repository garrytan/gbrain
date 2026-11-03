/**
 * GBRA-248 W0b: a re-init from a cold GBRAIN_HOME (no config.json) with no
 * provider key in reach used to write embedding_disabled over a database that
 * already holds vectors, switching an embedded brain to keyword-only. Init now
 * keeps the database's model and width in the file plane and names the key;
 * a fresh keyless install and an explicit --no-embedding are unchanged.
 * doctor's embedding_plane_disagreement names the earlier damage and the
 * enable command for the same model. PGLite (repo-less, the keyless default)
 * and Postgres; subprocess-driven with a hermetic per-run GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readStoredEmbeddingIdentity } from '../src/core/stored-embedding-identity.ts';
import { keptEmbeddingIdentity, keptEmbeddingNotice } from '../src/commands/init-embedding-plane.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const scratch: string[] = [];

async function runCli(args: string[], home: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
    env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    cwd: home, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const watchdog = setTimeout(() => proc.kill('SIGKILL'), 150_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(watchdog); }
}
function coldHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-cold-home-'));
  scratch.push(home);
  return home;
}
const fileConfig = (home: string) => JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')) as Record<string, unknown>;
async function embedOnePage(engine: BrainEngine, dims: number): Promise<void> {
  await engine.putPage('notes/embedded', { type: 'note', title: 'Embedded', compiled_truth: 'A page with a vector.', timeline: '' });
  await engine.upsertChunks('notes/embedded', [{ chunk_index: 0, chunk_text: 'A page with a vector.', chunk_source: 'compiled_truth', embedding: new Float32Array(dims).fill(0.01) }]);
}
function doctorCheck(stdout: string): Record<string, any> {
  return (JSON.parse(stdout).checks as Array<Record<string, any>>).find(c => c.name === 'embedding_plane_disagreement')!;
}

afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

describe('cold-home re-init over an embedded PGLite brain', () => {
  let db: string;
  beforeAll(async () => {
    const owner = coldHome();
    db = join(owner, 'brain.pglite');
    const created = await runCli(['init', '--pglite', '--path', db, '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024', '--skip-embed-check'], owner);
    expect({ code: created.exitCode, stderr: created.stderr }).toMatchObject({ code: 0 });
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: db });
    try {
      // Fixture write outside the coordinator: managed persistence is paused around it and restored.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await embedOnePage(engine, 1024);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    } finally { await engine.disconnect(); }
  }, 240_000);

  test('doctor names a file plane that disables embeddings over the vectors, with the same-model enable', async () => {
    const home = coldHome();
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db, embedding_disabled: true }));
    const doctor = await runCli(['doctor', '--only', 'embedding_plane_disagreement', '--json'], home);
    const check = doctorCheck(doctor.stdout);
    expect(check).toMatchObject({ status: 'warn', details: { model: 'voyage:voyage-4', dimensions: 1024, vector_tables: ['content_chunks'] } });
    expect(check.fix.argv).toEqual(['gbrain', 'init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024', '--path', db]);
  }, 150_000);

  test('a keyless re-init from a cold home keeps the database identity instead of writing embedding_disabled', async () => {
    const home = coldHome();
    const init = await runCli(['init', '--pglite', '--path', db], home);
    expect({ code: init.exitCode, stderr: init.stderr }).toMatchObject({ code: 0 });
    const cfg = fileConfig(home);
    expect(cfg.embedding_disabled).toBeUndefined();
    expect(cfg).toMatchObject({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024 });
    expect(init.stdout).toContain("kept this database's voyage:voyage-4 (1024d)");
    expect(init.stdout).toContain('VOYAGE_API_KEY');
    expect(init.stdout).toContain('gbrain embed --stale');
    const doctor = await runCli(['doctor', '--only', 'embedding_plane_disagreement', '--json'], home);
    expect(doctorCheck(doctor.stdout).status).toBe('ok');
  }, 150_000);

  test('a fresh keyless install and an explicit --no-embedding still write embedding_disabled', async () => {
    const fresh = coldHome();
    const first = await runCli(['init', '--pglite', '--path', join(fresh, 'new.pglite')], fresh);
    expect({ code: first.exitCode, stderr: first.stderr }).toMatchObject({ code: 0 });
    expect(fileConfig(fresh).embedding_disabled).toBe(true);
    expect(first.stdout).toContain('--no-embedding: deferred setup');
    const explicit = coldHome();
    const chosen = await runCli(['init', '--pglite', '--path', db, '--no-embedding'], explicit);
    expect({ code: chosen.exitCode, stderr: chosen.stderr }).toMatchObject({ code: 0 });
    expect(fileConfig(explicit).embedding_disabled).toBe(true);
    expect(fileConfig(explicit).embedding_model).toBeUndefined();
  }, 240_000);

  test('a keyless brain re-initialized from a cold home stays keyless', async () => {
    for (const firstFlags of [[], ['--no-embedding']]) {
      const owner = coldHome();
      const path = join(owner, 'keyless.pglite');
      const first = await runCli(['init', '--pglite', '--path', path, ...firstFlags], owner);
      expect({ code: first.exitCode, stderr: first.stderr }).toMatchObject({ code: 0 });
      const home = coldHome();
      const again = await runCli(['init', '--pglite', '--path', path], home);
      expect({ code: again.exitCode, stderr: again.stderr }).toMatchObject({ code: 0 });
      expect({ flags: firstFlags, disabled: fileConfig(home).embedding_disabled }).toEqual({ flags: firstFlags, disabled: true });
      expect(again.stdout).not.toContain('kept this database');
    }
  }, 300_000);
});

describe('keptEmbeddingIdentity', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('keeps an agreeing identity only over vectors, and keeps nothing (so init disables as before) when it cannot be confirmed', async () => {
    const implicit = { noEmbedding: true, implicitKeyless: true } as never;
    const stored = (await readStoredEmbeddingIdentity(engine))!;
    expect(await keptEmbeddingIdentity(engine, implicit, false)).toBeNull();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await embedOnePage(engine, stored.dimensions);
    expect(await keptEmbeddingIdentity(engine, { noEmbedding: true } as never, false)).toBeNull();
    expect(await keptEmbeddingIdentity(engine, implicit, true)).toBeNull();
    expect(await keptEmbeddingIdentity(engine, implicit, false)).toEqual({ model: stored.model!, dimensions: stored.dimensions });
    expect(keptEmbeddingNotice({ model: stored.model!, dimensions: stored.dimensions })).toContain(`kept this database's ${stored.model} (${stored.dimensions}d)`);
    await engine.setConfig('embedding_dimensions', String(stored.dimensions + 1));
    expect(await keptEmbeddingIdentity(engine, implicit, false)).toBeNull();
    await engine.unsetConfig('embedding_dimensions');
    await engine.unsetConfig('embedding_model');
    expect(await keptEmbeddingIdentity(engine, implicit, false)).toBeNull();
    await engine.setConfig('embedding_disabled', 'true');
    expect(await keptEmbeddingIdentity(engine, implicit, false)).toBeNull();
  }, 120_000);
});

describe('cold-home re-init over an embedded Postgres brain', () => {
  const url = process.env.DATABASE_URL;
  test.skipIf(!url)('a keyless re-init keeps the database identity', async () => {
    const isolated = await isolatedPersistencePostgres(url!);
    try {
      const stored = (await readStoredEmbeddingIdentity(isolated.engine))!;
      await embedOnePage(isolated.engine, stored.dimensions);
      const home = coldHome();
      const init = await runCli(['init', '--url', isolated.databaseUrl, '--non-interactive'], home);
      expect({ code: init.exitCode, stderr: init.stderr }).toMatchObject({ code: 0 });
      const cfg = fileConfig(home);
      expect(cfg.embedding_disabled).toBeUndefined();
      expect(cfg).toMatchObject({ embedding_model: stored.model, embedding_dimensions: stored.dimensions });
      expect(init.stdout).toContain(`kept this database's ${stored.model} (${stored.dimensions}d)`);
    } finally { await isolated.close(); }
  }, 240_000);
});
