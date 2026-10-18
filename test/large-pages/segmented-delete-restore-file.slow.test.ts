/**
 * Delete and restore of a file-backed segmented page over the single-string ceiling, up to the engine's
 * `pages.max_bytes` (Wave B, PR 2 fix lane D).
 *
 * 1. Protects: on a managed source with a claimed worktree, a soft delete of a page over 24 MiB removes its
 *    canonical file and restore_page writes it back byte for byte (the file in gbrain's serialization), at
 *    27 MiB (over the 25 MiB pre-push scan cap) and at 90 MiB (whose base64 recovery record once reserved more
 *    than the 256 MiB worktree recovery budget); a purge then removes page and file. The restore streams the
 *    file from the segments into its staging file and the delete stages the prior file by copy: no file read,
 *    hash, copy or write piece is over one segment (`largeFileWork`), and nothing is left staged.
 * 2. Fails when: restore_page refuses a file over the push-scan cap (`request_too_large`: the file a delete
 *    removed is lost), the restore concatenates the export into one buffer or reads the canonical file whole,
 *    or the delete's recovery reservation does not fit the worktree budget.
 * 3. Existing coverage: segmented-file-drift.test.ts restores a page under the push-scan cap whose file sync
 *    removed; no test deleted and restored a page above it.
 * 4. No production seam: `largeFileWork` is the module's own work counter.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import * as largeFile from '../../src/core/persistence/large-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';
import { fileSha, writeCanonicalPage } from '../helpers/large-page-file.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-delete-restore-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const MiB = 1024 * 1024;
// Imported as a namespace so the probe runs (and fails on the restore) on a tree that predates the counter.
const work = (largeFile as { largeFileWork?: Record<string, number> }).largeFileWork ?? { bytesRead: 0, bytesWritten: 0, bytesCopied: 0, largestPiece: 0 };

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

interface Fixture { sourceId: string; root: string; ctx: OperationContext }

async function managedSource(engine: BrainEngine): Promise<Fixture> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const root = join(home, `src-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `dr-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
  return { sourceId, root, ctx };
}

const revisionOf = async (engine: BrainEngine, f: Fixture, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true }))!.revision;

/** A write over 64 MiB can outlast the reply wait: the same call (same request_id) is repeated until it settles. */
async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; await Bun.sleep(1000); }
  }
}

async function submit(engine: BrainEngine, f: Fixture, operation: 'delete_page' | 'restore_page', slug: string, extra: Record<string, unknown> = {}) {
  const params = { slug, expected_revision: await revisionOf(engine, f, slug), request_id: randomUUID(), ...extra };
  return settled(() => submitPageMutation(f.ctx, { operation, params }) as Promise<Record<string, any>>);
}

async function pageRow(engine: BrainEngine, f: Fixture, slug: string) {
  const [row] = await engine.executeRaw<{ deleted: boolean; body_storage: string; body_bytes: string }>(`SELECT deleted_at IS NOT NULL AS deleted, body_storage,
    body_bytes::text AS body_bytes FROM pages WHERE source_id=$1 AND slug=$2`, [f.sourceId, slug]);
  return row ?? null;
}

/** Staging leftovers (hidden `.<sha>.tmp.<uuid>` siblings) in the source's notes directory. */
const stagingLeft = (f: Fixture) => readdirSync(join(f.root, 'notes')).filter(name => name.includes('.tmp.'));
const resetWork = () => { for (const key of Object.keys(work)) work[key] = 0; };

async function roundTrip(engine: BrainEngine, bodyBytes: number, seed: number): Promise<void> {
  const f = await managedSource(engine);
  const slug = `notes/large-${seed}`;
  const file = join(f.root, `${slug}.md`);
  try {
    const original = writeCanonicalPage(file, bodyBytes, seed);
    expect(await settled(() => importManagedFile(engine, file, `${slug}.md`, { sourceId: f.sourceId, noEmbed: true }))).toMatchObject({ status: 'imported' });
    const imported = (await pageRow(engine, f, slug))!;
    expect(imported.body_storage).toBe('segmented');
    expect(Number(imported.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);

    resetWork();
    expect(await submit(engine, f, 'delete_page', slug)).toMatchObject({ status: 'soft_deleted', noop: false });
    expect(existsSync(file)).toBe(false);
    expect((await pageRow(engine, f, slug))?.deleted).toBe(true);
    expect(stagingLeft(f)).toEqual([]);
    const deleted = { ...work };

    resetWork();
    const restored = await submit(engine, f, 'restore_page', slug).catch((error: Error & { code?: string }) => ({ refused: error.code, message: error.message }));
    expect(restored).toMatchObject({ status: 'restored', noop: false });
    expect((await pageRow(engine, f, slug))?.deleted).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBe(original.size);
    expect(fileSha(file)).toBe(original.sha);
    expect(stagingLeft(f)).toEqual([]);
    // The delete copied the prior file to its recovery stage (removed with the commit), never reading it whole; the
    // restore measured the file once in preparation, then streamed it into its staging file. No piece over a segment.
    expect(deleted.bytesCopied).toBe(original.size);
    expect(work.bytesWritten).toBe(original.size);
    for (const counted of [deleted, work]) {
      expect(counted.largestPiece).toBeGreaterThan(0);
      expect(counted.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }

    // The written file is the page's canonical file: a purge's drift check matches it and removes page and file.
    expect(await submit(engine, f, 'delete_page', slug, { purge: true })).toMatchObject({ status: 'purged' });
    expect(existsSync(file)).toBe(false);
    expect(await pageRow(engine, f, slug)).toBeNull();
    expect(stagingLeft(f)).toEqual([]);
    // The reply is sent once the purge commits; its recovery record and reservation are cleared after that
    // (coordinator.ts, clearResolvedRecovery), so the counters are read at that release point.
    await waitFor(async () => (await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.sourceId]))[0]!.n === 0,
    { timeoutMs: 30_000, label: 'the purge cleared its recovery record' });
    const counters = await engine.executeRaw<{ bytes: string }>('SELECT recovery_bytes::text AS bytes FROM persistence_counters');
    expect(counters.every(row => Number(row.bytes) === 0)).toBe(true);
  } finally {
    await disposePersistenceConsumer(engine);
    rmSync(f.root, { recursive: true, force: true });
  }
}

test('a 27 MiB page (over the push-scan cap) deletes and restores its file byte for byte, streamed', async () => withEnv(env, async () => {
  for (const engine of engines) await roundTrip(engine, 27 * MiB, 101);
}), 1_800_000);

test('a 90 MiB page deletes and restores its file byte for byte, streamed, within the recovery budget', async () => withEnv(env, async () => {
  for (const engine of engines) await roundTrip(engine, 90 * MiB, 201);
}), 3_600_000);
