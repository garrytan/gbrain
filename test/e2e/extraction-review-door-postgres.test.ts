/**
 * GBRA-215 L2 on live Postgres: extraction_review promote, reject and distinct through the page door, on a
 * repository-backed source and on a repo-less one. PGLite runs the same scenarios in
 * test/extraction-review-door.serial.test.ts.
 *
 * Gated by DATABASE_URL via hasDatabase(); skips cleanly when unset.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/extraction-review-door-postgres.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { dropPreadmitCache } from '../../src/core/persistence/preadmit-cache.ts';
import {
  distinctScenario, promoteScenario, racedDecisionsScenario, rejectScenario, reviewDoorFixture,
  type ReviewDoorFixture, type ReviewStorage,
} from '../helpers/review-door-scenarios.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let engine: PostgresEngine;
let fx: ReviewDoorFixture | null = null;
let home: string;
let priorHome: string | undefined;

// setupDB does not truncate the persistence bindings: release the claim so no later test or file inherits it.
// The worktree row stays: the write requests this file journaled still reference it.
const releaseClaim = () => engine.executeRaw(`DELETE FROM persistence_source_bindings WHERE source_id = 'default';
  DELETE FROM persistence_host_bindings h WHERE NOT EXISTS (SELECT 1 FROM persistence_source_bindings s WHERE s.worktree_id = h.worktree_id);
  UPDATE sources SET local_path = NULL WHERE id = 'default'`);

/** On Postgres a repository-backed source writes through its canonical owner, so the git fixture claims the checkout for this host. */
async function fixture(storage: ReviewStorage): Promise<ReviewDoorFixture> {
  await releaseClaim();
  // The raw release bypasses admission, so drop the 30 s pre-admission cache of the source row it changed.
  dropPreadmitCache(engine);
  const made = await reviewDoorFixture(engine, storage);
  if (!made.repo) return made;
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [made.repo]);
  await claimWorktree(engine, 'default', made.repo);
  return made;
}

d('extraction_review through the page door (live Postgres)', () => {
  beforeAll(async () => { engine = await setupDB(); }, 60_000);
  afterAll(async () => { await releaseClaim(); await engine.unsetConfig('sync.repo_path'); await teardownDB(); }, 60_000);
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-review-door-home-'));
    priorHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
  });
  afterEach(async () => {
    await disposePersistenceConsumer(engine);
    fx?.cleanup(); fx = null;
    if (priorHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  });

  for (const storage of ['git', 'database'] as ReviewStorage[]) {
    const label = storage === 'git' ? 'repository-backed' : 'repo-less';
    test(`promote (${label})`, async () => { fx = await fixture(storage); await promoteScenario(engine, fx); }, 30_000);
    test(`reject (${label})`, async () => { fx = await fixture(storage); await rejectScenario(engine, fx); }, 30_000);
    test(`distinct (${label})`, async () => { fx = await fixture(storage); await distinctScenario(engine, fx); }, 30_000);
    test(`raced promote and reject (${label})`, async () => { fx = await fixture(storage); await racedDecisionsScenario(engine, fx); }, 30_000);
  }
});
