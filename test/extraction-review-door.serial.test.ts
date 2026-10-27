/**
 * GBRA-215 L2: extraction_review promote, reject and distinct write through the page door on PGLite, on a
 * repository-backed source (Git commit first) and on a repo-less one (the database is the record), under
 * the source's publication guard. Postgres runs the same scenarios in
 * test/e2e/extraction-review-door-postgres.test.ts.
 *
 * .serial: real git subprocesses against tmp repos and a GBRAIN_HOME swap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { publicationGuardId, withPublicationGuard } from '../src/core/persistence/publication-guard.ts';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import {
  distinctScenario, promoteScenario, racedDecisionsScenario, rejectScenario, reviewCtx, reviewDoorFixture, seedStub,
  type ReviewDoorFixture, type ReviewStorage,
} from './helpers/review-door-scenarios.ts';

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
  describe(`extraction_review through the page door (${storage === 'git' ? 'repository-backed' : 'repo-less'} source)`, () => {
    test('promote flips status to verified through the door', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await promoteScenario(engine, fx);
    }, 30_000);
    test('reject soft-deletes through the door', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await rejectScenario(engine, fx);
    }, 30_000);
    test('distinct records distinct_from and silences the pair', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await distinctScenario(engine, fx);
    }, 30_000);
    test('a raced promote and reject land exactly one decision', async () => {
      fx = await reviewDoorFixture(engine, storage);
      await racedDecisionsScenario(engine, fx);
    }, 30_000);
  });
}

describe('publication guard', () => {
  test('a review decision waits for the guard and runs once it is released', async () => {
    fx = await reviewDoorFixture(engine, 'database');
    const slug = 'people/guarded-example';
    await seedStub(engine, slug, 'Guarded Example');
    const held = (await tryAcquireDbLock(engine, publicationGuardId('default'), 1))!;
    let released = 0;
    const decision = operationsByName.extraction_review!.handler(reviewCtx(engine), { action: 'promote', slugs: [slug] });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect((await engine.getPage(slug))!.frontmatter.status).toBe('unverified');
    released = performance.now();
    await held.release();
    const out = await decision as { results: Array<{ status: string }> };
    expect(performance.now()).toBeGreaterThanOrEqual(released);
    expect(out.results[0]!.status).toBe('promoted');
  }, 30_000);

  test('a guard held past the wait refuses with lock_busy and writes nothing', async () => {
    const held = (await tryAcquireDbLock(engine, publicationGuardId('default'), 1))!;
    let ran = false;
    try {
      const err = await withPublicationGuard(engine, 'default', async () => { ran = true; }, 250).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('lock_busy');
      expect((err as OperationError).fix?.argv).toEqual(['gbrain', 'status', '--section', 'locks', '--json']);
      expect(ran).toBe(false);
    } finally { await held.release(); }
  });

  test('guards are per source: another source decides while one is held', async () => {
    const held = (await tryAcquireDbLock(engine, publicationGuardId('source-a'), 1))!;
    try {
      expect(await withPublicationGuard(engine, 'default', async () => 'ran', 250)).toBe('ran');
    } finally { await held.release(); }
  });
});

describe('extraction_review distinct refusals', () => {
  test('a remote caller is told the exact owner command, of included', async () => {
    const err = await operationsByName.extraction_review!.handler(reviewCtx(engine, { remote: true }),
      { action: 'distinct', slugs: ['companies/acmi-example'], of: 'companies/acme-example' }).then(() => null, (e: unknown) => e) as OperationError;
    expect(err.code).toBe('permission_denied');
    expect(err.fix?.actor).not.toBe('agent');
    expect(err.fix?.user_message).toBeTruthy();
    expect(err.fix?.argv).toEqual(['gbrain', 'extraction-review', 'distinct', '--slugs', 'companies/acmi-example', '--of', 'companies/acme-example']);
  });

  test('distinct without of is invalid_params and writes nothing', async () => {
    const err = await operationsByName.extraction_review!.handler(reviewCtx(engine), { action: 'distinct', slugs: ['companies/acmi-example'] })
      .then(() => null, (e: unknown) => e) as OperationError;
    expect(err.code).toBe('invalid_params');
    expect(err.fix?.argv).toEqual(['gbrain', 'extraction-pending', '--include', 'possible_duplicates']);
  });
});
