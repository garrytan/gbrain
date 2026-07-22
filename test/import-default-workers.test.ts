/**
 * #1207: `gbrain import` without `--workers` used to hardcode workerCount=1,
 * so a large Postgres import paid one serial embedding round-trip per file.
 * runImport now routes the default through the shared autoConcurrency policy
 * (PGLite → 1, >100 files on Postgres → DEFAULT_PARALLEL_WORKERS), while an
 * explicit `--workers N` still wins.
 *
 * The engine here is a minimal postgres-kind stub with no database_url in
 * config — runImport's parallel branch then falls back to serial processing
 * (its PR #490 guard) but the WORKER-COUNT DECISION (the thing #1207 fixes)
 * is still observable via the "Using N parallel workers" log line. Per-file
 * imports fail against the stub engine and are swallowed by runImport's
 * per-file catch; that's fine — this test pins the policy, not the import.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { runImport } from '../src/commands/import.ts';

const fakePostgresEngine = {
  kind: 'postgres',
  executeRaw: async () => [],
  logIngest: async () => {},
  setConfig: async () => {},
  getConfig: async () => null,
} as any;

let workspace: string;
let brainDir: string;
let logs: string[];
const realLog = console.log;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gbrain-import-workers-home-'));
  mkdirSync(join(workspace, '.gbrain'), { recursive: true });
  brainDir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-import-workers-brain-')));
  // 101 files: one past AUTO_CONCURRENCY_FILE_THRESHOLD (100).
  for (let i = 0; i < 101; i++) {
    writeFileSync(join(brainDir, `page-${i}.md`), `# Page ${i}\n\nbody ${i}\n`);
  }
  logs = [];
  console.log = (msg?: unknown) => logs.push(String(msg));
});

afterEach(() => {
  console.log = realLog;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(brainDir, { recursive: true, force: true });
});

describe('import default worker count (#1207)', () => {
  test('no --workers flag → autoConcurrency picks 4 for >100 files on Postgres', async () => {
    await withEnv({ GBRAIN_HOME: join(workspace, '.gbrain'), GBRAIN_SOURCE: undefined }, async () => {
      await runImport(fakePostgresEngine, [brainDir, '--no-embed'], { sourceId: 'default' });
    });
    expect(logs.some(l => l.includes('Using 4 parallel workers'))).toBe(true);
  });

  test('explicit --workers 2 still wins over the auto policy', async () => {
    await withEnv({ GBRAIN_HOME: join(workspace, '.gbrain'), GBRAIN_SOURCE: undefined }, async () => {
      await runImport(fakePostgresEngine, [brainDir, '--no-embed', '--workers', '2'], { sourceId: 'default' });
    });
    expect(logs.some(l => l.includes('Using 2 parallel workers'))).toBe(true);
    expect(logs.some(l => l.includes('Using 4 parallel workers'))).toBe(false);
  });
});
