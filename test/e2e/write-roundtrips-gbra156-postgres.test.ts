/**
 * GBRA-156, Postgres arm: the statements of a page transaction and the connections a one-shot CLI command opens.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { connect, disconnect } from '../../src/core/db.ts';
import { markOneShotCommand } from '../../src/core/persistence/claim-phase.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

type Traced = { sql: string; kind: string; conn: number; t: number };
const traced = (file: string): Traced[] => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Traced)
  .map(record => ({ ...record, sql: record.sql.replace(/\s+/g, ' ').trim() }));

const d = hasDatabase() ? describe : describe.skip;
d('GBRA-156 one-shot write (Postgres)', () => {
  let scratch: string;
  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'gbrain-gbra156-')); });
  afterAll(() => { markOneShotCommand(false); rmSync(scratch, { recursive: true, force: true }); });

  for (const oneShot of [true, false]) test(`the module pool opens ${oneShot ? 'a second connection beside the first for a one-shot command' : 'one connection for any other process'}`, async () => {
    const application = `gbra156-${randomUUID().slice(0, 8)}`;
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('application_name', application);
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    markOneShotCommand(oneShot);
    try {
      await connect({ engine: 'postgres', database_url: url.toString() } as never);
      let open = 0;
      for (let i = 0; i < 40; i++) {
        [{ open }] = await admin<{ open: number }[]>`SELECT count(*)::int AS open FROM pg_stat_activity WHERE application_name=${application}`;
        if (open >= 2) break;
        await Bun.sleep(25);
      }
      expect(open).toBe(oneShot ? 2 : 1);
    } finally {
      markOneShotCommand(false);
      await disconnect();
      await admin.end();
    }
  }, 60_000);

  test('a page transaction that stamps the keyless contextual state and writes chunks reads the embedding write target once', async () => {
    const trace = join(scratch, 'page-transaction.jsonl');
    let window: [number, number] = [0, 0];
    await withEnv({ GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'gbra156-page-tx', GBRAIN_HOME: join(scratch, 'home') }, async () => {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      try {
        await pg.engine.putPage('notes/gbra156', { type: 'note', title: 'GBRA-156', compiled_truth: 'Body text.' }, { sourceId: 'default' });
        await Bun.sleep(50);
        const started = performance.timeOrigin + performance.now();
        await pg.engine.transaction(async tx => {
          await tx.updatePageContextualRetrievalState('notes/gbra156', 'default', 'none', null);
          await tx.upsertChunks('notes/gbra156', [{ chunk_index: 0, chunk_text: 'Body text.', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
        });
        window = [started, performance.timeOrigin + performance.now()];
      } finally {
        await pg.close();
      }
    });
    await Bun.sleep(1300);
    const reads = traced(trace).filter(record => record.t >= window[0] && record.t <= window[1]
      && /^SELECT key, ?value FROM config WHERE key IN \('search_embedding_column'/.test(record.sql));
    expect(reads.map(record => record.sql)).toHaveLength(1);
  }, 120_000);
});
