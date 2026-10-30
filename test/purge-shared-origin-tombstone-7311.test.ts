/**
 * #7311 / #7305: a soft-deleted page whose canonical file a live page of its source also records (a shared-origin
 * tombstone: what `gbrain delete` of a duplicate-origin twin leaves, receipt `write_through.skipped: shared_origin`).
 * Master refused every purge of it as a shared origin, the 72 h retention purge included, so the cycle purge phase
 * failed every pass (`managed_purge_failed`), the tombstone parked after PURGE_PARK_LIMIT failures and global
 * maintenance never stamped.
 *
 * Protects: the retention purge (the cycle purge phase, `gbrain pages purge-deleted`) removes such a tombstone
 * database-only, like an `origin_twin` page: the page row and its facts go, the file and the surviving page (its row,
 * facts and later fact inserts) are untouched, no content or fact tombstone is written and the phase reports ok; a
 * tombstone parked by the old refusal is purged by `--retry-parked`; an owner `--purge` of the tombstone still refuses
 * and names the retention purge instead of a soft delete; the census is revalidated under publication [#6517 R8]: a
 * survivor that stopped recording the file defers the purge and the next run takes the normal path, which removes
 * the file the tombstone now owns alone; an unmanaged brain's bulk purge removes only the tombstone row.
 *
 * PGLite always; Postgres through test/e2e/purge-shared-origin-tombstone-7311-postgres.test.ts. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { runCycle } from '../src/core/cycle.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { purgeDeletedPagesCoordinated, purgePhaseStatus } from '../src/core/persistence/purge-deleted.ts';
import { PURGE_PARK_LIMIT, readPurgeParks, recordPurgeFailure } from '../src/core/persistence/purge-parks.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const FILE = 'notes/x-example.md', SURVIVOR = 'notes/x-example', TWIN = 'notes/x-example-copy';
const BODY = 'A synthetic observation about acme-example, recorded once.';
const BYTES = `---\ntype: note\ntitle: X Example\n---\n\n${BODY}\n`;
const SURVIVOR_FACT = 'acme-example is a synthetic company', TWIN_FACT = 'acme-example ships a synthetic widget';
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, FILE), BYTES); commit(root, 'notes');
};
const CONSENT_ENV = { GBRAIN_CONSENT: undefined };

/** A fixture write as legacy data left it: managed persistence off around the statement. */
async function raw<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<Record<string, unknown>>(
  `SELECT id, slug, deleted_at, source_path, source_uri, content_hash, compiled_truth, knowledge_revision::text AS revision, database_only_reason
   FROM pages WHERE source_id='default' AND slug=$1`, [slug]))[0];
const count = async (engine: BrainEngine, table: string) => Number((await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE source_id='default'`))[0]!.n);
const facts = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ fact: string }>(
  "SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id", [slug])).map(row => row.fact);
const insertFact = (engine: BrainEngine, slug: string, fact: string) => engine.executeRaw(
  "INSERT INTO facts(source_id, fact, entity_slug, visibility, source, source_markdown_slug) VALUES ('default', $1, 'companies/acme-example', 'world', 'test', $2)", [fact, slug]);
const ageTombstones = (engine: BrainEngine) => raw(engine, () => engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '73 hours' WHERE source_id='default' AND deleted_at IS NOT NULL"));
async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

/**
 * The first sync imports FILE into SURVIVOR; a duplicate-origin twin TWIN (same content, recording the same file, as a
 * sync before #6948 left it) holds a fact of its own, and SURVIVOR holds one too. `gbrain delete TWIN` keeps the file
 * (`shared_origin`), leaving a tombstone that still records it.
 */
async function sharedTombstone(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await dropOriginIndex(engine);
  await raw(engine, async () => {
    await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path)
      SELECT source_id, $2, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path FROM pages WHERE source_id='default' AND slug=$1`, [SURVIVOR, TWIN]);
    await insertFact(engine, TWIN, TWIN_FACT);
    await insertFact(engine, SURVIVOR, SURVIVOR_FACT);
  });
  const deleted = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: TWIN, expected_revision: (await pageRow(engine, TWIN))!.revision, request_id: randomUUID() } });
  expect(deleted).toMatchObject({ status: 'soft_deleted', write_through: { written: false, skipped: 'shared_origin' } });
  expect((await pageRow(engine, TWIN))!.source_path).toBe(FILE);
}

const snapshotBefore = async (engine: BrainEngine) => ({ survivor: await pageRow(engine, SURVIVOR), purges: await count(engine, 'page_purges'), factPurges: await count(engine, 'fact_purges') });
/** The survivor, its file and its facts are untouched, nothing was tombstoned, and a later fact insert for it is not refused. */
async function expectSurvivorIntact(engine: BrainEngine, root: string, before: Awaited<ReturnType<typeof snapshotBefore>>, managed = true): Promise<void> {
  expect(await pageRow(engine, TWIN)).toBeUndefined();
  if (managed) expect(await facts(engine, TWIN)).toEqual([]);
  expect(await pageRow(engine, SURVIVOR)).toEqual(before.survivor);
  expect(readFileSync(join(root, FILE), 'utf8')).toBe(BYTES);
  expect(await facts(engine, SURVIVOR)).toEqual([SURVIVOR_FACT]);
  expect(await count(engine, 'page_purges')).toBe(before.purges);
  expect(await count(engine, 'fact_purges')).toBe(before.factPurges);
  await (managed ? raw(engine, () => insertFact(engine, SURVIVOR, TWIN_FACT)) : insertFact(engine, SURVIVOR, TWIN_FACT));
  expect(await facts(engine, SURVIVOR)).toEqual([SURVIVOR_FACT, TWIN_FACT]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7311 #7305 ${backend}: the retention purge of a shared-origin tombstone`, () => {
    test('the cycle purge phase removes it database-only and reports ok; the survivor, its file and its facts stay', () => managedBrain(async ({ engine, ctx, root }) => {
      await sharedTombstone(engine, ctx);
      await ageTombstones(engine);
      const before = await snapshotBefore(engine);
      const phase = (await withEnv(CONSENT_ENV, () => runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: 'default' }))).phases.find(p => p.phase === 'purge')!;
      expect({ status: phase.status, blocked: phase.details.purged_pages_blocked, slugs: phase.details.purged_page_slugs }).toEqual({ status: 'ok', blocked: [], slugs: [TWIN] });
      await expectSurvivorIntact(engine, root, before);
      // The next full sync finds the file unchanged under the survivor: no hold, no deletion, no new page.
      await performManagedSync(engine, { ...OPTS, full: true });
      expect((await pageRow(engine, SURVIVOR))!.deleted_at).toBeNull();
      expect(await pageRow(engine, TWIN)).toBeUndefined();
      expect(((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).map(hold => hold.code)).toEqual([]);
      expect(readFileSync(join(root, FILE), 'utf8')).toBe(BYTES);
    }, { setup, databaseUrl }), 300_000);

    test('a tombstone the old refusal parked is purged by --retry-parked', () => managedBrain(async ({ engine, ctx, root }) => {
      await sharedTombstone(engine, ctx);
      await ageTombstones(engine);
      const [row] = await engine.executeRaw<{ deleted_us: string }>(
        "SELECT floor(extract(epoch FROM deleted_at)*1000000)::bigint::text AS deleted_us FROM pages WHERE source_id='default' AND slug=$1", [TWIN]);
      for (let i = 0; i < PURGE_PARK_LIMIT; i++) await recordPurgeFailure(engine, { source_id: 'default', slug: TWIN, deleted_us: row!.deleted_us, code: 'source_changed',
        reason: "The page's canonical file is shared with another live page, so a purge (which tombstones its content source-wide) was refused" });
      const before = await snapshotBefore(engine);
      const automatic = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect({ count: automatic.count, parked: automatic.parked, status: purgePhaseStatus(automatic) }).toEqual({ count: 0, parked: 1, status: 'warn' });
      const retried = await purgeDeletedPagesCoordinated(engine, 72, { retryParked: true });
      expect({ count: retried.count, slugs: retried.slugs, blocked: retried.blocked, error: retried.error, status: purgePhaseStatus(retried) })
        .toEqual({ count: 1, slugs: [TWIN], blocked: [], error: undefined, status: 'ok' });
      expect((await readPurgeParks(engine)).size).toBe(0);
      await expectSurvivorIntact(engine, root, before);
    }, { setup, databaseUrl }), 300_000);

    test('an owner --purge of the tombstone refuses, names the retention purge and changes nothing', () => managedBrain(async ({ engine, ctx, root }) => {
      await sharedTombstone(engine, ctx);
      const before = { twin: await pageRow(engine, TWIN), ...await snapshotBefore(engine) };
      const error = await refusal(async () => submitPageMutation(ctx, { operation: 'delete_page',
        params: { slug: TWIN, purge: true, expected_revision: (await pageRow(engine, TWIN))!.revision, request_id: randomUUID() } }));
      expect(error.code).toBe('source_changed');
      expect(error.message).toContain('shared with another live page');
      expect(error.message).not.toContain('Soft-delete it instead');
      expect(error.message).toContain('already soft-deleted');
      expect(error.message).toContain('gbrain pages purge-deleted --older-than 72h --yes');
      expect(await pageRow(engine, TWIN)).toEqual(before.twin);
      expect(await pageRow(engine, SURVIVOR)).toEqual(before.survivor);
      expect(await count(engine, 'page_purges')).toBe(before.purges);
      expect(readFileSync(join(root, FILE), 'utf8')).toBe(BYTES);
    }, { setup, databaseUrl }), 300_000);

    test('[#6517 R8] a survivor that stops recording the file during preparation defers the purge; the next run removes the file the tombstone owns alone', () => managedBrain(async ({ engine, ctx, root }) => {
      await sharedTombstone(engine, ctx);
      await ageTombstones(engine);
      let disturbed = false;
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'delete_page' || disturbed) return;
        disturbed = true;
        await raw(engine, () => engine.executeRaw("UPDATE pages SET source_path='notes/elsewhere-example.md' WHERE source_id='default' AND slug=$1", [SURVIVOR]));
      });
      let first: Awaited<ReturnType<typeof purgeDeletedPagesCoordinated>>;
      try { first = await purgeDeletedPagesCoordinated(engine, 72); } finally { installFaultHook(undefined); }
      expect(disturbed).toBe(true);
      expect({ count: first.count, deferred: first.deferred, failed: first.failed, error: first.error, codes: first.blocked.map(b => b.code) })
        .toEqual({ count: 0, deferred: 1, failed: 0, error: undefined, codes: ['revision_conflict'] });
      expect(first.blocked[0]!.reason).toContain('shared canonical file changed');
      expect((await pageRow(engine, TWIN))!.source_path).toBe(FILE);
      expect(readFileSync(join(root, FILE), 'utf8')).toBe(BYTES);
      // The tombstone is the file's only claimant now: the normal purge path compares and removes the file, never leaving it behind.
      const second = await purgeDeletedPagesCoordinated(engine, 72);
      expect({ count: second.count, blocked: second.blocked, error: second.error }).toEqual({ count: 1, blocked: [], error: undefined });
      expect(await pageRow(engine, TWIN)).toBeUndefined();
      expect(existsSync(join(root, FILE))).toBe(false);
    }, { setup, databaseUrl }), 300_000);
  });

  describe(`#7311 ${backend}: an unmanaged brain's bulk purge of a shared-origin tombstone`, () => {
    test('removes only the tombstone row; the survivor, its file and its facts stay', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-7311-'));
      try {
        await withEnv({ DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
          try {
            setup({ root });
            await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
            await dropOriginIndex(engine);
            for (const slug of [SURVIVOR, TWIN]) {
              await engine.putPage(slug, { type: 'note', title: 'X Example', compiled_truth: BODY, timeline: '', frontmatter: {}, content_hash: 'x-example' }, { sourceId: 'default' });
              await engine.executeRaw("UPDATE pages SET source_path=$2 WHERE source_id='default' AND slug=$1", [slug, FILE]);
            }
            await insertFact(engine, TWIN, TWIN_FACT);
            await insertFact(engine, SURVIVOR, SURVIVOR_FACT);
            await engine.softDeletePage(TWIN, { sourceId: 'default' });
            await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '73 hours' WHERE source_id='default' AND slug=$1", [TWIN]);
            const before = await snapshotBefore(engine);
            const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
            expect({ count: result.count, slugs: result.slugs, blocked: result.blocked, status: purgePhaseStatus(result) }).toEqual({ count: 1, slugs: [TWIN], blocked: [], status: 'ok' });
            await expectSurvivorIntact(engine, root, before, false);
          } finally { await close(); }
        });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, 300_000);
  });
}
