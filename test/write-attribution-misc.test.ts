/**
 * Foundations 2 (Lane C) attribution for the remaining unmanaged writers: the
 * captured-facts and extractor-facts repairs, the calibration wave undo, the
 * legacy sync soft delete (`softDeleteSyncPages`), capture ingest tombstones,
 * extraction review promote and reject, and the conversation fact index's
 * derived fact writes (`writeDerivedFacts`) run in maintenanceTransaction.
 * Pages they advance name the local maintenance principal; rows they change
 * keep their creator and move their last writer.
 *
 * Protects the remaining writer families in docs/architecture/system-of-record.md.
 * Fails if any of those writers runs outside maintenanceTransaction. Runs on
 * PGLite, and on Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { undoWave } from '../src/core/calibration/undo-wave.ts';
import { softDeleteSyncPages } from '../src/core/company-brain/profile.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import { writeDerivedFacts } from '../src/core/persistence/derived-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { CREATOR_ACTOR, asCreator, revisionActor, rowActors, unmanagedBrain, type Actor, type UnmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-misc-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

const actors = (rows: Array<{ id: number; created: Actor; last: Actor }>) => rows.map(({ created, last }) => ({ created, last }));
const ctx = (brain: UnmanagedBrain): OperationContext => ({ engine: brain.engine, config: { engine: brain.engine.kind } as never,
  logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: brain.sourceId });
async function creatorPage(brain: UnmanagedBrain, slug: string, frontmatter: Record<string, unknown> = {}) {
  return asCreator(brain.engine, tx => tx.putPage(slug, { type: 'note', title: slug, compiled_truth: 'A page body.', frontmatter }, { sourceId: brain.sourceId }));
}
const deletedRevisionActor = async (brain: UnmanagedBrain, slug: string) => (await brain.engine.executeRaw<Actor>(
  `SELECT revision_write_request_id::text AS request, revision_principal_kind AS kind, revision_principal_id AS id
     FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL`, [brain.sourceId, slug]))[0];
async function repair(engine: BrainEngine, kind: string, args: string[]) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, [kind, ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')).results[0] as { apply_command: string; outcomes?: Record<string, number> };
}
const expectHash = (preview: { apply_command: string }) => preview.apply_command.match(/--expect ([0-9a-f]+)/)![1];

describe('remaining unmanaged writers', () => {
  test('gbrain repair captured-facts --apply expires a database-only self-capture row, keeping its creator', async () => {
    const claude = join(scratch, 'claude');
    mkdirSync(join(claude, 'projects', '-tmp-gbrain-claude-cli-cwd-4242'), { recursive: true });
    writeFileSync(join(claude, 'projects', '-tmp-gbrain-claude-cli-cwd-4242', 'sess-self.jsonl'), '{}\n');
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await asCreator(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session)
        VALUES ($1, 'people/alice-example', 'Alice Example drinks oat milk', 'fact', 'private', 'hook:writeback', 'sess-self')`, [brain.sourceId]));
      await withEnv({ CLAUDE_CONFIG_DIR: claude }, async () => {
        const preview = await repair(engine, 'captured-facts', ['--source', brain.sourceId]);
        expect((await repair(engine, 'captured-facts', ['--source', brain.sourceId, '--apply', '--expect', expectHash(preview)])).outcomes).toEqual({ expired: 1 });
      });
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId]))).toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }, 120_000);

  test('gbrain repair extractor-facts --apply restores an expired extractor fact, keeping its creator', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await creatorPage(brain, 'conversations/example-call');
      await asCreator(engine, tx => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, row_num, source_markdown_slug, expired_at)
        VALUES ($1, 'people/alice-example', 'Alice sends the deck', 'commitment', 'private', 'cli:extract-conversation-facts:sess', 'sess', NULL, 'conversations/example-call', now())`,
      [brain.sourceId]));
      const preview = await repair(engine, 'extractor-facts', ['--source', brain.sourceId, '--include-ambiguous']);
      expect((await repair(engine, 'extractor-facts', ['--source', brain.sourceId, '--include-ambiguous', '--apply', '--expect', expectHash(preview)])).outcomes)
        .toEqual({ restored: 1 });
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId]))).toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }, 120_000);

  test('a calibration wave undo keeps the take creator and moves its last writer', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const page = await creatorPage(brain, 'people/kai-example');
      const wave = `wave-${brain.sourceId}`;
      await asCreator(engine, async tx => {
        await tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Ships on time', kind: 'bet', holder: 'world', weight: 0.7 }]);
        await tx.executeRaw(`UPDATE takes SET resolved_at=now(), resolved_quality='correct', resolved_outcome=true, resolved_by='gbrain:grade_takes' WHERE page_id=$1`, [page.id]);
      });
      const [take] = await engine.executeRaw<{ id: number }>('SELECT id::int AS id FROM takes WHERE page_id=$1', [page.id]);
      await engine.executeRaw(`INSERT INTO take_grade_cache (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence, applied, wave_version)
        VALUES ($1, 'v1', 'test:judge', 'sig', 'correct', 0.99, true, $2)`, [take.id, wave]);
      expect((await undoWave(engine, { waveVersion: wave })).resolutions_reverted).toBe(1);
      expect(actors(await rowActors(engine, 'takes', 'page_id=$1', [page.id]))).toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }, 120_000);

  test('the legacy sync soft delete, a capture tombstone and an extraction review advance their pages under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await creatorPage(brain, 'notes/sync-removed-example');
      expect(await softDeleteSyncPages(engine, ['notes/sync-removed-example'], { sourceId: brain.sourceId })).toEqual(['notes/sync-removed-example']);
      expect(await deletedRevisionActor(brain, 'notes/sync-removed-example')).toEqual(brain.maintenance);

      await creatorPage(brain, 'captures/tombstoned-example');
      const ingest = makeIngestCaptureHandler(engine);
      const result = await ingest({ data: { event: { source_id: brain.sourceId, source_kind: 'webhook', source_uri: 'test://tombstone', received_at: new Date().toISOString(),
        content_type: 'text/markdown', content: 'deleted', content_hash: createHash('sha256').update('deleted').digest('hex'), kind: 'tombstone', untrusted_payload: false, slug: 'captures/tombstoned-example' } } } as never);
      expect(result.status).toBe('deleted');
      expect(await deletedRevisionActor(brain, 'captures/tombstoned-example')).toEqual(brain.maintenance);

      const unverified = { provenance: 'auto-extracted', status: 'unverified' };
      await creatorPage(brain, 'people/promoted-example', unverified);
      await creatorPage(brain, 'people/rejected-example', unverified);
      const review = operationsByName['extraction_review']!;
      await review.handler(ctx(brain), { action: 'promote', slugs: ['people/promoted-example'] });
      await review.handler(ctx(brain), { action: 'reject', slugs: ['people/rejected-example'] });
      expect(await revisionActor(engine, brain.sourceId, 'people/promoted-example')).toEqual(brain.maintenance);
      expect(await deletedRevisionActor(brain, 'people/rejected-example')).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('the conversation fact index writes derived facts under the maintenance principal on an unmanaged brain', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await creatorPage(brain, 'conversations/derived-example');
      const inserted = await writeDerivedFacts(engine, brain.sourceId, 'conversations/derived-example', db => db.insertFacts([{ fact: 'Bob books the venue',
        kind: 'commitment', entity_slug: 'people/bob-example', visibility: 'private', source: 'cli:extract-conversation-facts:sess', row_num: 1,
        source_markdown_slug: 'conversations/derived-example' } as never], { source_id: brain.sourceId }));
      expect(inserted.inserted).toBe(1);
      expect(actors(await rowActors(engine, 'facts', 'source_id=$1', [brain.sourceId]))).toEqual([{ created: brain.maintenance, last: brain.maintenance }]);
    }
  }, 120_000);
});
