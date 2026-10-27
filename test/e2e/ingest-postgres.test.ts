/**
 * GBRA-215 L3 on live Postgres: ingest and ingest_undo on a repository-backed source and on a repo-less one. PGLite runs
 * the same scenarios in test/ingest.serial.test.ts.
 *
 * Gated by DATABASE_URL via hasDatabase(); skips cleanly when unset.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/ingest-postgres.test.ts
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
import { reviewDoorFixture, type ReviewDoorFixture, type ReviewStorage } from '../helpers/review-door-scenarios.ts';
import * as S from '../helpers/ingest-scenarios.ts';

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

async function fixture(storage: ReviewStorage): Promise<ReviewDoorFixture> {
  await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'companies/%' OR slug LIKE 'people/%' OR slug LIKE 'inbox/ingest-%' OR slug LIKE 'ingest/%' OR slug LIKE 'notes/%'");
  await engine.executeRaw("DELETE FROM facts; DELETE FROM op_checkpoints WHERE op LIKE 'ingest-%'");
  await releaseClaim();
  dropPreadmitCache(engine);
  const made = await reviewDoorFixture(engine, storage);
  if (!made.repo) return made;
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [made.repo]);
  await claimWorktree(engine, 'default', made.repo);
  return made;
}

d('ingest and ingest_undo (live Postgres)', () => {
  beforeAll(async () => { engine = await setupDB(); }, 60_000);
  afterAll(async () => { await releaseClaim(); await engine.unsetConfig('sync.repo_path'); await teardownDB(); }, 60_000);
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-ingest-home-'));
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
    test('golden transcript (' + label + ')', async () => { fx = await fixture(storage); await S.goldenScenario(engine, fx); }, 90_000);
    test('undo through the fence (' + label + ')', async () => { fx = await fixture(storage); await S.undoScenario(engine, fx); }, 120_000);
    test('keyless run (' + label + ')', async () => { fx = await fixture(storage); await S.keylessScenario(engine, fx); }, 60_000);
    test('dry run (' + label + ')', async () => { fx = await fixture(storage); await S.dryRunScenario(engine); }, 60_000);
    test('trusted extraction (' + label + ')', async () => { fx = await fixture(storage); await S.trustedScenario(engine); }, 60_000);
    test('budget stop then resume (' + label + ')', async () => { fx = await fixture(storage); await S.budgetResumeScenario(engine); }, 60_000);
    test('kill switch (' + label + ')', async () => { fx = await fixture(storage); await S.killSwitchScenario(engine); }, 60_000);
    test('validation (' + label + ')', async () => { fx = await fixture(storage); await S.validationScenario(engine); }, 60_000);
    test('two-entity claim (' + label + ')', async () => { fx = await fixture(storage); await S.twoEntityScenario(engine); }, 60_000);
    test('reserved report namespace (' + label + ')', async () => { fx = await fixture(storage); await S.namespaceScenario(engine); }, 60_000);
    test('private ingest (' + label + ')', async () => { fx = await fixture(storage); await S.privacyScenario(engine); }, 60_000);
    test('held natural slug (' + label + ')', async () => { fx = await fixture(storage); await S.heldSlugScenario(engine); }, 60_000);
    test('grants (' + label + ')', async () => { fx = await fixture(storage); await S.grantScenario(engine); }, 60_000);
    test('create conflict re-plan (' + label + ')', async () => { fx = await fixture(storage); await S.createConflictScenario(engine); }, 60_000);
    test('undo keeps changed pages (' + label + ')', async () => { fx = await fixture(storage); await S.undoKeepsChangedPagesScenario(engine); }, 90_000);
    test('undo keeps relied-on claims (' + label + ')', async () => { fx = await fixture(storage); await S.undoKeepsReliedOnScenario(engine); }, 90_000);
    test('undo unverifiable (' + label + ')', async () => { fx = await fixture(storage); await S.undoUnverifiableScenario(engine); }, 60_000);
  }
  test('Git target unavailable refuses before writes', async () => { fx = await fixture('git'); await S.storageUnavailableScenario(engine); }, 60_000);
});
