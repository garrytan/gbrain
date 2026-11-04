/**
 * GBRA-215 L3: ingest and ingest_undo on PGLite, on a repository-backed source (Git first) and on a repo-less one
 * (the database is the record). Postgres runs the same scenarios in test/e2e/ingest-postgres.test.ts.
 *
 * .serial: real git subprocesses against tmp repos and a GBRAIN_HOME swap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { reviewDoorFixture, type ReviewDoorFixture, type ReviewStorage } from './helpers/review-door-scenarios.ts';
import * as S from './helpers/ingest-scenarios.ts';

let engine: PGLiteEngine;
let fx: ReviewDoorFixture | null = null;
let home: string;
let priorHome: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
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
  describe('ingest (' + (storage === 'git' ? 'repository-backed' : 'repo-less') + ' source)', () => {
    test('golden transcript: proposed company with its fact, acronym flagged, tail claim saved, repeat and status read-only', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.goldenScenario(engine, fx);
    }, 60_000);
    test('undo previews, refuses a stale hash, strikes through the fence, survives an edit, repeats as a no-op; re-ingest saves again', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.undoScenario(engine, fx);
    }, 90_000);
    test('keyless run proposes candidate names and skips facts', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.keylessScenario(engine, fx);
    }, 60_000);
    test('a soft-deleted page at the natural slug stays deleted and restorable; the name is filed beside it', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.deletedPageScenario(engine);
    }, 60_000);
    test('a blocked window is billed: its spend is booked on the attempt', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.failedWindowSpendScenario(engine);
    }, 60_000);
    test('dry run makes no provider call and writes nothing', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.dryRunScenario(engine);
    }, 60_000);
    test('trusted extraction creates real pages only for model-typed names, owner only', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.trustedScenario(engine);
    }, 60_000);
    test('budget stop then explicit resume, without replaying finished windows', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.budgetResumeScenario(engine);
    }, 60_000);
    test('kill switch flipped mid-run stops before the next window', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.killSwitchScenario(engine);
    }, 60_000);
    test('invalid input and options are refused before any write', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.validationScenario(engine);
    }, 60_000);
    test('a claim naming two entities lands on both, first mention first, with one mentions edge', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.twoEntityScenario(engine);
    }, 60_000);
    test('report pages are reserved for the attempt that owns them', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.namespaceScenario(engine);
    }, 60_000);
    test('a private ingest derives only private pages and claims, unreadable remotely', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.privacyScenario(engine);
    }, 60_000);
    test('a document asking for visibility: private is refused unless the ingest is private (master private-request hold)', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.privateRequestScenario(engine);
    }, 60_000);
    test('a report read later hides a page that now names readers the caller does not meet', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.reportReadersScenario(engine);
    }, 60_000);
    test('ingest pages carry the trust tier the door gives the caller', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.trustTierScenario(engine);
    }, 60_000);
    test('a natural slug held by an unreadable page takes the hash-tagged slug, proposed', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.heldSlugScenario(engine);
    }, 60_000);
    test('grants: refused before any provider call without the child capabilities; bound prefixes skip outside_grant', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.grantScenario(engine);
    }, 60_000);
    test('a slug created by another writer after planning is planned again once', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.createConflictScenario(engine);
    }, 60_000);
    test('undo keeps promoted and edited pages', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.undoKeepsChangedPagesScenario(engine);
    }, 90_000);
    test('undo keeps a claim another attempt relies on, with its pages', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.undoKeepsReliedOnScenario(engine);
    }, 90_000);
    test('undo refuses ingest_undo_unverifiable without the attempt journal', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.undoUnverifiableScenario(engine);
    }, 60_000);
    test('an ambiguous name attaches to neither namesake, and its claim is written nowhere', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.ambiguousNamesakeScenario(engine);
    }, 60_000);
    test('a run left pending by a page write resumes and writes the claims it held back', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.pendingPageResumeScenario(engine);
    }, 90_000);
    test('a failed commit resumed keeps its ownership evidence, so undo retracts everything the attempt created', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.failedCommitResumeUndoScenario(engine);
    }, 90_000);
    test('undo keeps a replaced source document and a page edited after its re-check', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await S.undoKeepsReplacedSourceScenario(engine);
    }, 90_000);
  });
}

test('a repository-backed source whose Git target is unavailable refuses before writes', async () => {
  fx = await reviewDoorFixture(engine, 'git');
  await S.storageUnavailableScenario(engine);
}, 60_000);
