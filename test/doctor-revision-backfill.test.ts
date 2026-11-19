/**
 * #5216 follow-up: doctor `revision_backfill` and the command that resumes
 * the page revision backfill.
 *
 * Protects: doctor reports ok once `pages.knowledge_revision` is NOT NULL;
 * warns with the pending count and `foresights apply-migrations --force-schema`
 * while pages still wait for their revision; names failed rows by page id,
 * source:slug, attempt and error, and points at the torn-page preview when
 * only rows with spent attempts remain. The backfill completes on a managed
 * brain instead of failing every row on the managed writer guard.
 * Fails when: the check is missing or silent, when it names a command that
 * does not resume the backfill once the schema version is current (`--yes`
 * alone), or when the backfill's revision update is refused with
 * writer_coordinator_required on a managed brain.
 * Why existing coverage misses it: page-revision-backfill-5216.test.ts drives
 * resumePageRevisionBackfill directly on an unmanaged brain; nothing reports
 * the state or runs the printed resume command.
 * Seams: none; real PGLite (and Postgres through the e2e registration), the
 * shared `managedBrain`. The CLI journey is test/doctor-revision-backfill-journey.serial.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revisionBackfillEntry } from '../src/commands/doctor/checks/revision-backfill.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { REVISION_BACKFILL_STATE_KEY, resumePageRevisionBackfill } from '../src/core/page-state/revision-backfill-schema.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUGS = ['notes/rev-a', 'notes/rev-b', 'notes/rev-c'];

/** Pages written before page revisions existed: the column nullable, their revisions NULL. */
async function awaitingRevisions(engine: BrainEngine, slugs: string[]): Promise<void> {
  await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision DROP NOT NULL');
  await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER USER');
  await engine.executeRaw('UPDATE pages SET knowledge_revision = NULL WHERE slug = ANY($1::text[])', [slugs]);
  await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER USER');
}

async function check(engine: BrainEngine): Promise<Check> {
  const [result] = await revisionBackfillEntry.run({ engine } as unknown as DoctorContext) as Check[];
  expect(result.name).toBe('revision_backfill');
  return result;
}

async function unmanagedBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-revision-backfill-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        for (const slug of SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.` }, { sourceId: 'default' });
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: revision_backfill doctor check`, () => {
    test('ok when every page has its revision', async () => {
      await unmanagedBrain(databaseUrl, async engine => {
        const result = await check(engine);
        expect(result).toMatchObject({ status: 'ok', details: { column: 'not_null', pending: 0 } });
        expect(categorizeCheck('revision_backfill')).toBe('meta');
      });
    }, 120_000);

    test('warns with the pending count and the resume command while pages wait for their revision', async () => {
      await unmanagedBrain(databaseUrl, async engine => {
        await awaitingRevisions(engine, SLUGS);
        const result = await check(engine);
        expect(result.status).toBe('warn');
        expect(result.message).toContain('3 page(s) still have no revision');
        expect(result.message).toContain('foresights apply-migrations --force-schema');
        expect(result.fix).toMatchObject({ argv: ['gbrain', 'apply-migrations', '--force-schema'], actor: 'agent',
          verify: { argv: ['gbrain', 'doctor', '--only', 'revision_backfill', '--json'] } });
        expect(result.details).toMatchObject({ column: 'nullable', pending: 3, resumable: 3, failed: [] });

        expect((await resumePageRevisionBackfill(engine, { log: () => {} })).status).toBe('complete');
        expect((await check(engine)).status).toBe('ok');
      });
    }, 120_000);

    test('names failed rows by page; only spent rows left points at the torn-page preview', async () => {
      await unmanagedBrain(databaseUrl, async engine => {
        await awaitingRevisions(engine, SLUGS.slice(0, 2));
        const ids = Object.fromEntries((await engine.executeRaw<{ id: number; slug: string }>(
          'SELECT id, slug FROM pages WHERE slug = ANY($1::text[])', [SLUGS])).map(r => [r.slug, Number(r.id)]));
        const error = 'unexpected chunk number 21 (expected 1) for toast value 141869';
        await engine.setConfig(REVISION_BACKFILL_STATE_KEY, JSON.stringify({ cursor: ids['notes/rev-c'], backfilled: 1, failed: [
          { id: ids['notes/rev-a'], attempts: 1, error }, { id: ids['notes/rev-b'], attempts: 3, error }] }));
        const both = await check(engine);
        expect(both.status).toBe('warn');
        expect(both.message).toContain(`page id ${ids['notes/rev-a']} (default:notes/rev-a, attempt 1 of 3: ${error})`);
        expect(both.message).toContain(`page id ${ids['notes/rev-b']} (default:notes/rev-b, attempt 3 of 3: ${error})`);
        expect(both.message).toContain('1 of them used all 3 attempts');
        expect(both.fix).toMatchObject({ argv: ['gbrain', 'apply-migrations', '--force-schema'] });
        expect(both.details).toMatchObject({ pending: 2, resumable: 1 });

        await engine.executeRaw("UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE slug = 'notes/rev-a'");
        const spent = await check(engine);
        expect(spent.status).toBe('warn');
        expect(spent.message).not.toContain('apply-migrations');
        expect(spent.message).toContain('foresights repair orphan-children');
        expect(spent.fix).toMatchObject({ argv: ['gbrain', 'repair', 'orphan-children'] });
        expect(spent.details).toMatchObject({ pending: 1, resumable: 0, failed: [expect.objectContaining({ slug: 'notes/rev-b', attempts: 3 })] });
      });
    }, 120_000);
  });

  test(`${backend}: managed: the backfill assigns revisions under the writer guard instead of failing every row`, async () => {
    await managedBrain(async ({ engine, ctx }) => {
      for (const slug of SLUGS) {
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: `---\ntype: note\ntitle: ${slug}\n---\nBody of ${slug}.\n`, request_id: randomUUID() } });
      }
      await awaitingRevisions(engine, SLUGS);
      const result = await resumePageRevisionBackfill(engine, { log: () => {} });
      expect(result).toMatchObject({ status: 'complete', failed: [] });
      const rows = await engine.executeRaw<{ r: string | null }>('SELECT knowledge_revision::text AS r FROM pages WHERE slug = ANY($1::text[])', [SLUGS]);
      expect(rows.every(row => /^[0-9a-f-]{36}$/.test(row.r ?? ''))).toBe(true);
      expect((await check(engine)).status).toBe('ok');
    }, { databaseUrl });
  }, 120_000);
}
