/** #8886: the unindexed_files phase must not report a complete pass when a source's scan failed. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runUnindexedFilesPhase } from '../src/core/cycle/unindexed-files.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-unindexed-8886-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a source whose scan errors makes the phase report complete: false', () => withEnv(env, async () => {
  const id = 'unidx-broken-8886', root = join(home, id);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'a.md'), '---\ntitle: A\n---\nA synthetic note.\n');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  rmSync(join(root, '.git'), { recursive: true, force: true });
  const phase = await runUnindexedFilesPhase(engine, { dryRun: true });
  const details = phase.details as { complete: boolean; errors: Array<{ source_id: string }> };
  expect(details.errors.map(e => e.source_id)).toContain(id);
  expect(phase.status).toBe('warn');
  expect(details.complete).toBe(false);
}), 120_000);
