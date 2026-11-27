/**
 * C16 on Postgres: a schema upgrade runs once under concurrent openers.
 *
 * The database behind the code is the newest Postgres schema-history fixture (test/fixtures/schema-history/postgres), loaded
 * into a scratch database with three pages. Five PostgresEngine instances (each its own pool) connect to it and call
 * `initSchema` at the same time. The schema migration lock lets one of them run the pending migrations; the others wait for
 * it and find nothing pending. The proof of "exactly once" is a control, as in the Rust scenario: one engine upgrades a
 * second copy of the same database alone, and the migrations the runner reports as done (`  [N] ✓ name` on stderr) must be
 * the control's list, each version once, with no opener refused. Every opener then reads the pages written before the
 * upgrade and a page written after it.
 *
 * Every database is a scratch database made from DATABASE_URL (guarded by assertSafeE2eDatabaseUrl) and dropped after. The
 * engines come from `spare` (the parity arm's `unconnectedEngine`, so their calls count toward the case's members), each
 * connected to a scratch database instead of the arm's own; disconnected here before the databases drop.
 */
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { schemaHistorySql, schemaHistoryVersions } from '../helpers/schema-history.ts';

export const C16_PG_OPENERS = 5;

export interface C16PostgresRun {
  /** The schema version the fixture database starts at. */
  from: number;
  /** Migration versions the lone control opener reported as done, in order. */
  solo: number[];
  /** Migration versions the concurrent openers together reported as done, in order. */
  together: number[];
  /** What each concurrent `initSchema` ended with: `ok` or the error's code and message. */
  outcomes: string[];
  /** The `version` config row each opener reads after the upgrade. */
  versions: Array<string | null>;
  /** The three pages written before the upgrade, as each opener reads them. */
  pagesBefore: Array<Array<string | null>>;
  /** A page one opener wrote after the upgrade, as each opener reads it. */
  pageAfter: Array<string | null>;
}

/** The migrations the runner reported as done in `text`: every `[N] ✓ name` line, in order. */
export function migrationsDone(text: string): number[] {
  return [...text.matchAll(/\[(\d+)\] ✓ /g)].map((m) => Number(m[1]));
}

function outcome(r: PromiseSettledResult<void>): string {
  if (r.status === 'fulfilled') return 'ok';
  const e = r.reason as { code?: unknown; message?: unknown };
  return `${String(e?.code ?? 'error')}: ${String(e?.message ?? r.reason)}`;
}

/** Runs `fn` while every stderr write is also kept; returns what `fn` returned and the kept text. */
async function keepingStderr<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const kept: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    kept.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), text: kept.join('') };
  } finally {
    process.stderr.write = write;
  }
}

/** Runs the C16 Postgres scenario against scratch databases made from `databaseUrl`, on engines `spare` hands out. */
export async function runC16Postgres(databaseUrl: string, spare: () => { engine: BrainEngine; config: EngineConfig }): Promise<C16PostgresRun> {
  assertSafeE2eDatabaseUrl(databaseUrl);
  const from = schemaHistoryVersions('postgres').at(-1);
  if (from === undefined) throw new Error('C16 on Postgres needs a schema-history fixture; test/fixtures/schema-history/postgres has none');
  if (from >= LATEST_VERSION) throw new Error(`the newest Postgres schema-history fixture (v${from}) is not behind the code (v${LATEST_VERSION}): C16 has no upgrade to run`);
  const admin = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  const made: string[] = [];
  const engines: BrainEngine[] = [];
  const open = async (url: string) => {
    const { engine, config } = spare();
    engines.push(engine);
    await engine.connect({ ...config, database_url: url, poolSize: 2 } as EngineConfig);
    return engine;
  };
  /** A scratch database at schema version `from`, holding three pages. */
  const behindTheCode = async (): Promise<string> => {
    const name = `gbrain_test_c16_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    made.push(name);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const loader = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await loader.unsafe(schemaHistorySql('postgres', from));
      // The fixture's own pages table, before the code's migrations: the current putPage cannot write to it.
      for (let i = 0; i < 3; i++) {
        await loader.unsafe(`INSERT INTO pages (slug, type, title, compiled_truth) VALUES ($1, 'note', $2, $3)`, [`notes/c16-${i}`, `C16 ${i}`, `kept across the upgrade ${i}`]);
      }
    } finally {
      await loader.end({ timeout: 5 });
    }
    return url.toString();
  };
  const truth = async (e: BrainEngine, slug: string) => (await e.getPage(slug))?.compiled_truth ?? null;
  try {
    const control = await open(await behindTheCode());
    const solo = migrationsDone((await keepingStderr(() => control.initSchema())).text);

    const url = await behindTheCode();
    const openers = await Promise.all(Array.from({ length: C16_PG_OPENERS }, () => open(url)));
    const { value: settled, text } = await keepingStderr(() => Promise.allSettled(openers.map((e) => e.initSchema())));
    const outcomes = settled.map(outcome);
    const versions = await Promise.all(openers.map((e) => e.getConfig('version')));
    const pagesBefore = await Promise.all(openers.map((e) => Promise.all([0, 1, 2].map((i) => truth(e, `notes/c16-${i}`)))));
    await openers[0]!.putPage('notes/c16-after', { type: 'note', title: 'after', compiled_truth: 'written after the upgrade', timeline: '' });
    const pageAfter = await Promise.all(openers.map((e) => truth(e, 'notes/c16-after')));
    return { from, solo, together: migrationsDone(text), outcomes, versions, pagesBefore, pageAfter };
  } finally {
    for (const e of engines) await e.disconnect().catch(() => undefined);
    try {
      for (const name of made) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
}
