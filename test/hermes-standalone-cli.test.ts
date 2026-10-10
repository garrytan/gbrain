/**
 * Standalone Hermes maintenance must treat the CLI parser's default empty
 * selector list as omission, while a real subprocess imports and reads back
 * synthetic sessions in an isolated PGLite brain.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from './helpers/cli-spawn.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-standalone-cli-'));
const home = join(root, 'home');
const sourceId = 'default';
let stateDb: string;

beforeAll(() => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', database_path: join(root, 'brain.pglite'),
  }));
  stateDb = buildHermesFixture(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test('standalone CLI imports default Hermes sessions into isolated PGLite and receipts readback', async () => {
  const result = await runCli([
    'hermes', 'maintain', '--state-db', stateDb, '--source', sourceId, '--json',
  ], { home, timeoutMs: 120_000, env: { GBRAIN_REMOTE_CLIENT_SECRET: undefined } });
  expect(result).toMatchObject({ exitCode: 0 });
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ status: 'ok', source_id: sourceId,
    lock_reap: { reaped: 0, reapedIds: [] },
    ingest: { sessionsSeen: 2, sessionsImported: 2 }, validation: { checked: 2, missing: [] } });
  expect(receipt.ingest.slugsTouched).toHaveLength(2);
  expect(result.stderr).not.toContain('sessionSources must contain at least one source');
}, 150_000);
