/**
 * A closed day whose write the coordinator accepted asynchronously: confirming the committed pending receipt
 * also opens the day's archive_open_day hold in that same run. Synthetic session only.
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

test('confirming a committed pending receipt releases the open-day hold in the same run', async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
  const conv = conversation('openclaw', 'synthetic-pending-hold', [['user', '2026-11-10T08:59:00.000Z', 'Synthetic hello.']]);
  const readers = [staticReader('openclaw', [conv])];
  const budget = () => engine.executeRaw<{ state: string; reason: string | null }>(
    "SELECT b.state, b.reason FROM pages p JOIN page_embedding_budget b ON b.page_id = p.id WHERE p.source_id = 'conversations' AND p.frontmatter ? 'transcript_archive'");
  await runTranscriptArchive(engine, { mode: 'run', now: new Date('2026-11-10T09:00:00Z'), readers });
  expect((await budget())[0]).toMatchObject({ state: 'held', reason: 'archive_open_day' });

  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  await withEnv({ GBRAIN_HOME: dir }, () => registerLocalWriter(engine, 'cli'));
  const consumer = startPersistenceConsumer(engine, { engine: 'pglite' }) as unknown as { doTick(): Promise<void>; wake(now: boolean): void };
  consumer.doTick = async () => {};
  const next = new Date('2026-11-11T09:00:00Z');
  const run = (deadlineAtMs?: number) => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_WRITE_WAIT_MS: undefined },
    () => runTranscriptArchive(engine, {
      mode: 'run', now: next, readers, makeContext: source => makeContext(engine, { source, dry_run: false }),
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    }));
  const closed = await run(Date.now() + 1500);
  expect(closed.accepted).toBeGreaterThan(0);
  delete (consumer as { doTick?: unknown }).doTick;
  consumer.wake(true);
  await waitFor(async () => {
    const r = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE state <> 'committed'");
    return Number(r[0]!.n) === 0;
  }, { timeoutMs: 30_000 });

  await run();
  expect((await budget())[0]).toMatchObject({ state: 'open' });
}, 120_000);
