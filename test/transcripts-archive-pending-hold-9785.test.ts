/**
 * #9785: a day archived while still open is written with the archive_open_day embedding hold. Once the day closes, its
 * closing write goes through the write coordinator; when the coordinator accepts it but publishes it later, the ledger
 * keeps a pending receipt. The next run confirms that the receipt committed, and must open the day's hold in that same
 * run, as it does for a day it finds unchanged, instead of leaving it held until a second reconciliation. Synthetic
 * sessions only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { makeContext } from '../src/cli/main.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gb-archive-pending-hold-'));
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const budget = () => engine.executeRaw<{ state: string; reason: string | null }>(
  `SELECT b.state, b.reason FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
    WHERE p.source_id = 'conversations' AND p.slug LIKE 'conversations/codex/2026-11-10/%'`);

test('confirming a committed pending receipt for a closed day opens its open-day hold in the same run', async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
  const readers = [staticReader('codex', [conversation('codex', 'rollout-pending-hold', [['user', '2026-11-10T08:59:00.000Z', 'synthetic question']])])];

  await runTranscriptArchive(engine, { mode: 'run', now: new Date('2026-11-10T09:00:00Z'), readers });
  expect(await budget()).toEqual([{ state: 'held', reason: 'archive_open_day' }]);

  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  await withEnv({ GBRAIN_HOME: dir }, () => registerLocalWriter(engine, 'cli'));
  const run = (deadlineAtMs?: number) => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_WRITE_WAIT_MS: undefined },
    () => runTranscriptArchive(engine, {
      mode: 'run', now: new Date('2026-11-11T09:00:00Z'), readers,
      makeContext: source => makeContext(engine, { source, dry_run: false }), ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    }));

  const consumer = startPersistenceConsumer(engine, { engine: 'pglite' }) as unknown as { doTick(): Promise<void>; wake(now: boolean): void };
  consumer.doTick = async () => {};
  let closing;
  try { closing = await run(Date.now() + 1_500); } finally {
    delete (consumer as { doTick?: unknown }).doTick;
    consumer.wake(true);
  }
  expect(closing.accepted).toBeGreaterThanOrEqual(1);
  await waitFor(async () => (await engine.executeRaw<{ n: number }>(
    "SELECT count(*)::int AS n FROM persistence_requests WHERE operation = 'put_page' AND state <> 'committed'"))[0]!.n === 0,
  { timeoutMs: 30_000, label: 'the accepted closing write publishes' });
  expect(await budget()).toEqual([{ state: 'held', reason: 'archive_open_day' }]);

  const confirm = await run();
  expect(confirm.errors).toEqual([]);
  expect(await budget()).toEqual([{ state: 'open', reason: null }]);
}, 240_000);
