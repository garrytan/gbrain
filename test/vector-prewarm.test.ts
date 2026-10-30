/**
 * Opt-in vector index prewarm (GBRA-156, core/vector-prewarm.ts): the fit check
 * decides on shared_buffers alone, a refusal reads nothing (no pg_prewarm call,
 * no transaction), a missing extension refuses with its own code, PGLite is
 * refused without a single statement, and the CLI wires it under
 * `gbrain embeddings prewarm`. The real-Postgres path is
 * test/e2e/vector-prewarm-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREWARM_SHARED_BUFFERS_SHARE, prewarmFits, runVectorPrewarm } from '../src/core/vector-prewarm.ts';
import { mergeServeVectorPrewarm } from '../src/core/published-config.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const GB = 1024 ** 3;

interface Fake { engine: BrainEngine; statements: string[]; transactions: () => number }

function fake(o: { kind?: 'postgres' | 'pglite'; indexes?: Array<[string, number]>; sharedBuffers?: number; ecs?: number | null; ext?: string | null; available?: boolean }): Fake {
  const statements: string[] = [];
  let transactions = 0;
  const indexes = o.indexes ?? [['idx_chunks_embedding', 11 * GB], ['idx_chunks_embedding_image', 16384]];
  const engine = {
    kind: o.kind ?? 'postgres',
    async executeRaw(sql: string, params?: unknown[]) {
      statements.push(sql);
      if (sql.includes('pg_relation_size')) return indexes.map(([index, bytes]) => ({ index, table: 'content_chunks', bytes: String(bytes) }));
      if (sql.includes("current_setting('shared_buffers')")) return [{ shared_buffers: String(o.sharedBuffers ?? 8 * GB), effective_cache_size: o.ecs === null ? null : String(o.ecs ?? 24 * GB), extension_version: o.ext === undefined ? '1.2' : o.ext, extension_available: o.available ?? true }];
      if (sql.startsWith('SET LOCAL')) return [];
      if (sql.includes('pg_prewarm(')) return [{ blocks: String(indexes.find(([name]) => name === params?.[0])![1] / 8192) }];
      throw new Error('unexpected statement: ' + sql);
    },
    async transaction<T>(fn: (e: BrainEngine) => Promise<T>) { transactions++; return fn(engine as unknown as BrainEngine); },
  };
  return { engine: engine as unknown as BrainEngine, statements, transactions: () => transactions };
}

const prewarmCalls = (f: Fake) => f.statements.filter(s => s.includes('pg_prewarm('));
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return (e as { canonicalCode?: string }).canonicalCode; } };

describe('prewarm fit check', () => {
  test('shared_buffers decides, at half of it', () => {
    expect(PREWARM_SHARED_BUFFERS_SHARE).toBe(0.5);
    expect(prewarmFits(11 * GB, 8 * GB)).toEqual({ fits: false, budget_bytes: 4 * GB });
    expect(prewarmFits(11 * GB, 26 * GB)).toEqual({ fits: true, budget_bytes: 13 * GB });
    expect(prewarmFits(4 * GB, 8 * GB).fits).toBe(true);
    expect(prewarmFits(4 * GB + 1, 8 * GB).fits).toBe(false);
  });

  test('an index that does not fit is refused before any page is read, whatever effective_cache_size says', async () => {
    const f = fake({ sharedBuffers: 8 * GB, ecs: 64 * GB });
    expect(await codeOf(runVectorPrewarm(f.engine))).toBe('vector_prewarm_wont_fit');
    expect(prewarmCalls(f)).toEqual([]);
    expect(f.transactions()).toBe(0);
    expect(f.statements).toHaveLength(2);
  });

  test('the refusal carries the agent-operator contract: why, a host_admin fix naming the needed size, a read-only verify', async () => {
    const f = fake({ sharedBuffers: 8 * GB });
    let error: unknown;
    try { await runVectorPrewarm(f.engine); } catch (e) { error = e; }
    const env = JSON.parse(renderCliError(error, { json: true, command: 'embeddings', tty: false }).stdout!);
    expect(env.code).toBe('vector_prewarm_wont_fit');
    expect(env.class).toBe('host_only');
    expect(env.message).toContain('nothing was read');
    expect(env.why).toContain('effective_cache_size');
    expect(env.fix.next).toBe('tell_user_to_run');
    expect(env.fix.argv).toEqual(['psql', '-c', "ALTER SYSTEM SET shared_buffers = '22529MB'"]);
    expect(env.fix.verify.argv).toEqual(['gbrain', 'embeddings', 'prewarm', '--dry-run', '--json']);
  });

  test('a missing pg_prewarm extension is refused with its own code and reads nothing', async () => {
    const f = fake({ sharedBuffers: 32 * GB, ext: null });
    expect(await codeOf(runVectorPrewarm(f.engine))).toBe('vector_prewarm_extension_missing');
    expect(prewarmCalls(f)).toEqual([]);
    const g = fake({ sharedBuffers: 32 * GB, ext: null, available: false });
    let error: unknown;
    try { await runVectorPrewarm(g.engine); } catch (e) { error = e; }
    expect((error as Error).message).toContain('does not ship');
  });

  test('a fitting index is prewarmed into shared_buffers, largest first, each without a statement timeout', async () => {
    const f = fake({ sharedBuffers: 26 * GB });
    const r = await runVectorPrewarm(f.engine);
    expect(r.fits).toBe(true);
    expect(r.decided_by).toBe('shared_buffers');
    expect(r.mode).toBe('buffer');
    expect(r.loaded.map(l => [l.index, l.blocks])).toEqual([['idx_chunks_embedding', 11 * GB / 8192], ['idx_chunks_embedding_image', 2]]);
    expect(prewarmCalls(f).every(s => s.includes("'buffer'"))).toBe(true);
    expect(f.transactions()).toBe(2);
    expect(f.statements.filter(s => s === 'SET LOCAL statement_timeout = 0')).toHaveLength(2);
  });

  test('a dry run reports the fit and reads nothing, even before the extension exists', async () => {
    const f = fake({ sharedBuffers: 26 * GB, ext: null });
    const r = await runVectorPrewarm(f.engine, { dryRun: true });
    expect(r).toMatchObject({ dry_run: true, fits: true, loaded: [], extension_version: null, effective_cache_size_bytes: 24 * GB });
    expect(prewarmCalls(f)).toEqual([]);
  });

  test('PGLite is refused without a statement', async () => {
    const f = fake({ kind: 'pglite' });
    expect(await codeOf(runVectorPrewarm(f.engine))).toBe('vector_prewarm_unsupported_engine');
    expect(f.statements).toEqual([]);
  });
});

describe('serve.vector_prewarm config merge', () => {
  test('off unless the snapshot says so', () => {
    expect(mergeServeVectorPrewarm({ engine: 'postgres' }, null).serve_vector_prewarm).toBeUndefined();
    expect(mergeServeVectorPrewarm({ engine: 'postgres' }, {}).serve_vector_prewarm).toBeUndefined();
    expect(mergeServeVectorPrewarm({ engine: 'postgres' }, { 'serve.vector_prewarm': ' true ' }).serve_vector_prewarm).toBe(true);
    expect(mergeServeVectorPrewarm({ engine: 'postgres' }, { 'serve.vector_prewarm': 'off' }).serve_vector_prewarm).toBe(false);
  });
});

describe('gbrain embeddings prewarm (CLI)', () => {
  async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-prewarm-cli-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
      const p = Bun.spawn(['bun', '--no-env-file', 'src/cli.ts', 'embeddings', ...args], { cwd: process.cwd(), env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return { code, stdout };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('a PGLite brain is refused with the unsupported-engine code', async () => {
    const r = await cli(['prewarm', '--json']);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout).code).toBe('vector_prewarm_unsupported_engine');
  }, 60_000);

  test('an unknown option is refused', async () => {
    const r = await cli(['prewarm', '--bogus', '--json']);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout).code).toBe('unknown_flag');
  }, 60_000);
});
