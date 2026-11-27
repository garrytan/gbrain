/**
 * A Postgres brain can start an engine swap: the source gate, the recovery checkpoint and the authority switch
 * (docs/guides/engine-swap.md#checkpoint, #checkpoint_unavailable, #brain_in_use).
 *
 * Authoring gate (docs/TESTING.md): (1) protects a Postgres brain's way back: the run takes a pg_dump checkpoint under
 * the gbrain home (0600, hashed, its table list checked with pg_restore --list), refuses `checkpoint_unavailable`
 * before any write when pg_dump is missing, older than the server or the disk is short, counts other gbrain sessions as
 * `brain_in_use`, and switches and restores the config's database_url without ever writing it into the run record.
 * (2) Fails when a Postgres brain is still refused as PGLite-only, when a checkpoint lands outside the gbrain home or is
 * readable by others, when a short disk or a missing/old pg_dump is not refused with the space or version named, when
 * a dump that lost a table verifies, when another gbrain session is missed, or when the run record or --status output
 * holds the database URL. (3) The PGLite run tests (test/engine-swap-run.serial.test.ts) never reach any of this.
 * (4) Real Postgres (DATABASE_URL-gated) and the real pg_dump/pg_restore; only the tool's version or the free space is
 * injected for the refusal cases.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  postgresCheckpointUnavailable, postgresSessionsInUse, SYSTEM_PG_TOOLS, verifyPostgresCheckpoint, writePostgresCheckpoint,
  type PgTools,
} from '../src/core/engine-swap/pg-checkpoint.ts';
import { restoreAuthority, switchAuthority } from '../src/core/engine-swap/route.ts';
import { swapSourceKind } from '../src/core/engine-swap/source.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const URL_ = process.env.DATABASE_URL;
const d = URL_ ? describe : describe.skip;

describe('the swap source gate', () => {
  test('a Postgres brain is a swap source; a Rust brain is not', () => {
    expect(swapSourceKind({ engine: 'pglite', database_path: '/b.pglite' } as never)).toBe('pglite');
    expect(swapSourceKind({ engine: 'postgres', database_url: 'postgresql://u@h/db' } as never)).toBe('postgres');
    expect(swapSourceKind({ database_url: 'postgresql://u@h/db' } as never)).toBe('postgres');
    expect(swapSourceKind({ engine: 'rust', database_path: '/store' } as never)).toBe('rust');
  });
});

d('a Postgres swap source', () => {
  let engine: BrainEngine;
  let url: string;
  let close: () => Promise<void>;
  const homes: string[] = [];
  beforeAll(async () => {
    const iso = await isolatedPersistencePostgres(URL_!);
    engine = iso.engine; url = iso.databaseUrl; close = iso.close;
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('swap-src', 'swap-src') ON CONFLICT DO NOTHING`);
  }, 120_000);
  afterAll(async () => { await close(); });
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
  const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'gbrain-swap-pg-')); homes.push(h); return h; };

  test('the checkpoint is a pg_dump under the gbrain home, 0600, hashed, listing every table', async () => {
    const h = home();
    const path = join(h, '.gbrain', 'engine-swap', 'postgres-test', 'checkpoint-run.dump');
    const c = await writePostgresCheckpoint(engine, path, { url, home: h });
    expect(c.format).toBe('pg_dump_custom');
    expect(c.path).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(c.tables)).toContain('pages');
    expect(Object.keys(c.tables)).toContain('sources');
    await verifyPostgresCheckpoint(c, { list: true });
    // The file holds the brain's data, never the connection string pg_dump was given.
    expect(readFileSync(path).includes(Buffer.from(url))).toBe(false);
  }, 120_000);

  test('a checkpoint path outside the gbrain home is refused', async () => {
    const h = home();
    await expect(writePostgresCheckpoint(engine, join(tmpdir(), `outside-${Date.now()}.dump`), { url, home: h })).rejects.toThrow(/gbrain home/);
  });

  test('a dump that lost a table, or changed after it was written, does not verify', async () => {
    const h = home();
    const c = await writePostgresCheckpoint(engine, join(h, '.gbrain', 'engine-swap', 'k', 'checkpoint-a.dump'), { url, home: h });
    await expect(verifyPostgresCheckpoint({ ...c, tables: { ...c.tables, not_a_table: 0 } }, { list: true })).rejects.toThrow(/missing 1 table/);
    writeFileSync(c.path, Buffer.concat([readFileSync(c.path), Buffer.from('x')]));
    await expect(verifyPostgresCheckpoint(c)).rejects.toThrow(/changed size|hash/);
  }, 120_000);

  test('pg_dump missing, older than the server, or a short disk: checkpoint_unavailable names what is needed, nothing written', async () => {
    const h = home();
    const dir = join(h, '.gbrain', 'engine-swap', 'k');
    const missing: PgTools = { ...SYSTEM_PG_TOOLS, version: async () => null };
    const old: PgTools = { ...SYSTEM_PG_TOOLS, version: async () => 9 };
    for (const [tools, re] of [[missing, /pg_dump is not installed/], [old, /pg_dump 9 is older than the server/]] as const) {
      const e = await postgresCheckpointUnavailable(engine, dir, { tools, home: h });
      expect(e?.code).toBe('engine_swap_refused');
      expect((e as unknown as { reason: string }).reason).toBe('checkpoint_unavailable');
      expect(String(e?.message)).toMatch(re);
    }
    const short = await postgresCheckpointUnavailable(engine, dir, { home: h, freeBytes: () => 1024 });
    expect(String(short?.message)).toMatch(/needs about [0-9.]+ [KMG]B free/);
    expect(existsSync(dir)).toBe(false);
    expect(await postgresCheckpointUnavailable(engine, dir, { home: h })).toBeNull();
  }, 60_000);

  test('another gbrain session on the database counts as in use; this process does not', async () => {
    expect(await postgresSessionsInUse(engine)).toBe(0);
    const other = postgres(url, { max: 1, connection: { application_name: 'gbrain cli:424242:abcdef01' } });
    try {
      await other`SELECT 1`;
      expect(await postgresSessionsInUse(engine)).toBe(1);
    } finally {
      await other.end();
    }
  }, 60_000);

  test('the switch moves database_url out of the config and back, and never into the run record', async () => {
    const h = home();
    mkdirSync(join(h, '.gbrain'), { recursive: true });
    const cfg = join(h, '.gbrain', 'config.json');
    writeFileSync(cfg, JSON.stringify({ engine: 'postgres', database_url: url }));
    await withEnv({ GBRAIN_HOME: h, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const previous = switchAuthority(join(h, 'store'), { runDir: join(h, '.gbrain', 'engine-swap', 'k'), runId: 'r1' });
      expect(JSON.stringify(previous)).not.toContain(url);
      expect(previous).toEqual({ engine: 'postgres', database_path: '', database_url_saved: true });
      const after = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(after.engine).toBe('rust');
      expect(after.database_url).toBeUndefined();
      restoreAuthority(previous, { runDir: join(h, '.gbrain', 'engine-swap', 'k'), runId: 'r1' });
      const back = JSON.parse(readFileSync(cfg, 'utf8'));
      expect(back.engine).toBe('postgres');
      expect(back.database_url).toBe(url);
    });
  });
});
