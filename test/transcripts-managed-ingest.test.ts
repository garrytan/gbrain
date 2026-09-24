/**
 * transcripts ingest on a writer-claimed (managed) brain — pins #5235.
 *
 * On a managed brain the legacy writer refuses direct content imports, so the
 * importer must submit each rendered page through the persistence coordinator
 * (`submitPageMutation` / `put_page`). Covers the managed path end-to-end on a
 * PGLite engine whose persistence_brain single record is marked enabled
 * (writer-claimed), the same condition `--dry-run` hides (dry-run is green,
 * the real write aborts).
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 * Isolation: no process.env mutation; uses withEnv only where explicitly safe.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await stopPersistenceConsumer(engine);
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-managed-ingest-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('transcripts ingest commits pages through the coordinator on a writer-claimed brain', async () => {
  // Writer-claimed (managed) brain: the single persistence_brain record turned on.
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

  const stateDb = buildHermesFixture(tmp);
  const sourceId = 'default';
  const context: OperationContext = {
    engine,
    config: { engine: engine.kind, embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId,
  };

  const r = await runTranscriptsIngest(engine, {
    paths: [stateDb],
    sourceId,
    userPatternsPath: '/nonexistent-patterns.txt',
    context,
  });

  expect(r.erroredFiles).toBe(0);
  // The fixture builds two importable sessions; both must land on a managed brain.
  expect(r.pages.imported).toBeGreaterThan(0);
  expect(r.sessionsErrored).toBe(0);

  const pages = await engine.executeRaw<{ slug: string }>(
    "SELECT p.slug FROM pages p WHERE p.type='conversation'",
  );
  expect(pages.length).toBe(r.pages.imported);
});