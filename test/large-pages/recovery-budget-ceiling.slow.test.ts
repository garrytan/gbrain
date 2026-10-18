/**
 * Delete and restore of a file-backed segmented page the old 256 MiB worktree recovery budget refused (Wave B PR 2,
 * fix lane M, item 4).
 *
 * 1. Protects: with the recovery budget at its default, a 200 MiB page on Postgres and a page at the 128 MiB PGLite
 *    ceiling delete and restore on a source backed by files, the restored file byte-identical (size and SHA-256). A
 *    restore reserves the file twice (its staging file and the file), over 256 MiB for both pages; with
 *    `persistence.limits.worktree_recovery_bytes` configured to that old default the restore refuses with
 *    `request_too_large` before touching anything (the page stays deleted, no file or staging appears, nothing stays
 *    reserved). With `pages.segmented_storage` turned off after the page is stored, the default still holds it (it
 *    follows the largest stored segmented page), so it deletes and restores byte for byte again.
 * 2. Fails when: the default budget stays 256 MiB (the restore refuses), follows the switch alone (the restore after
 *    off refuses), or a configured budget is overridden.
 * 3. Existing coverage: segmented-delete-restore-file.slow.test.ts deletes and restores 27 and 90 MiB pages, within the
 *    old budget; recovery-budget-default.test.ts pins the default's arithmetic.
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { SEGMENTED_PAGE_CEILING_BYTES } from '../../src/core/page-body/limits.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';
import { fileSha, writeCanonicalPage } from '../helpers/large-page-file.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-ceiling-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const MiB = 1024 * 1024;
const OLD_DEFAULT = 256 * MiB;

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

interface Fixture { sourceId: string; root: string; ctx: OperationContext }

async function managedSource(engine: BrainEngine): Promise<Fixture> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const root = join(home, `src-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `rb-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
  return { sourceId, root, ctx };
}

const revisionOf = async (engine: BrainEngine, f: Fixture, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true }))!.revision;

/** A write this large can outlast the reply wait: the same call (same request_id) is repeated until it settles. */
async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending' || attempt >= 3600) throw error; await Bun.sleep(1000); }
  }
}

async function submit(engine: BrainEngine, f: Fixture, operation: 'delete_page' | 'restore_page', slug: string, extra: Record<string, unknown> = {}) {
  const params = { slug, expected_revision: await revisionOf(engine, f, slug), request_id: randomUUID(), ...extra };
  return settled(() => submitPageMutation(f.ctx, { operation, params }) as Promise<Record<string, any>>);
}

const deletedAt = async (engine: BrainEngine, f: Fixture, slug: string) => (await engine.executeRaw<{ deleted: boolean }>(
  'SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, slug]))[0]?.deleted;
const stagingLeft = (f: Fixture) => readdirSync(join(f.root, 'notes')).filter(name => name.includes('.tmp.'));
const reserved = async (engine: BrainEngine) => (await engine.executeRaw<{ bytes: string }>('SELECT recovery_bytes::text AS bytes FROM persistence_counters'))
  .reduce((sum, row) => sum + Number(row.bytes), 0);
/**
 * The reply is sent once the write commits; its recovery record (and reservation) is cleared after that, once the
 * publication has removed its staged prior file (coordinator.ts, clearResolvedRecovery). Wait for that release point.
 */
const recoveryCleared = (engine: BrainEngine, f: Fixture) => waitFor(async () => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.sourceId]))[0]!.n === 0,
{ timeoutMs: 30_000, label: 'the purge cleared its recovery record' });

/**
 * A canonical page file of exactly `fileBytes` bytes: the helper's conversation, then one filler paragraph that
 * brings it to the size (a body at the PGLite ceiling whose file, read twice, is over 256 MiB).
 */
function pageOfSize(file: string, fileBytes: number, seed: number): { sha: string; size: number } {
  const written = writeCanonicalPage(file, fileBytes - 256 * 1024, seed).size;
  const fill = fileBytes - written - 2;
  appendFileSync(file, `\n${'filler '.repeat(Math.ceil(fill / 7)).slice(0, fill - 1)}z\n`);
  return { sha: fileSha(file), size: statSync(file).size };
}

async function roundTrip(engine: BrainEngine): Promise<void> {
  const f = await managedSource(engine);
  const slug = `notes/ceiling-${engine.kind}`;
  const file = join(f.root, `${slug}.md`);
  const fileBytes = engine.kind === 'postgres' ? 200 * MiB : SEGMENTED_PAGE_CEILING_BYTES.pglite;
  try {
    const original = pageOfSize(file, fileBytes, 301);
    expect(original.size).toBe(fileBytes);
    // A restore reserves the file twice plus 4 KiB (coordinator.ts pageRecoveryRecord).
    expect(2 * original.size + 4096).toBeGreaterThan(OLD_DEFAULT);
    expect(await settled(() => importManagedFile(engine, file, `${slug}.md`, { sourceId: f.sourceId, noEmbed: true }))).toMatchObject({ status: 'imported' });
    expect(await submit(engine, f, 'delete_page', slug)).toMatchObject({ status: 'soft_deleted', noop: false });
    expect(existsSync(file)).toBe(false);

    // The old default, configured: the restore is refused before anything is touched.
    await engine.setConfig('persistence.limits.worktree_recovery_bytes', String(OLD_DEFAULT));
    const refused = await submit(engine, f, 'restore_page', slug).catch((error: Error & { code?: string }) => ({ refused: error.code }));
    expect(refused).toEqual({ refused: 'request_too_large' });
    expect(await deletedAt(engine, f, slug)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(stagingLeft(f)).toEqual([]);
    expect(await reserved(engine)).toBe(0);

    // The default: the restore fits and writes the file back byte for byte.
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.worktree_recovery_bytes'");
    const restored = await submit(engine, f, 'restore_page', slug).catch((error: Error & { code?: string }) => ({ refused: error.code }));
    expect(restored).toMatchObject({ status: 'restored', noop: false });
    expect(await deletedAt(engine, f, slug)).toBe(false);
    expect(statSync(file).size).toBe(original.size);
    expect(fileSha(file)).toBe(original.sha);
    expect(stagingLeft(f)).toEqual([]);

    // Switched off after the page was stored: the default budget still follows the stored page, so it deletes and
    // restores byte for byte (the default used to follow the switch alone and refuse the restore).
    await engine.setConfig('pages.segmented_storage', 'off');
    expect(await submit(engine, f, 'delete_page', slug)).toMatchObject({ status: 'soft_deleted', noop: false });
    const afterOff = await submit(engine, f, 'restore_page', slug).catch((error: Error & { code?: string }) => ({ refused: error.code, message: error.message }));
    expect(afterOff).toMatchObject({ status: 'restored', noop: false });
    expect(statSync(file).size).toBe(original.size);
    expect(fileSha(file)).toBe(original.sha);
    expect(stagingLeft(f)).toEqual([]);
    await engine.setConfig('pages.segmented_storage', 'on');

    expect(await submit(engine, f, 'delete_page', slug, { purge: true })).toMatchObject({ status: 'purged' });
    expect(existsSync(file)).toBe(false);
    await recoveryCleared(engine, f);
    expect(await reserved(engine)).toBe(0);
  } finally {
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.worktree_recovery_bytes'");
    await disposePersistenceConsumer(engine);
    rmSync(f.root, { recursive: true, force: true });
  }
}

for (const kind of testBackends()) describe(`recovery budget at the page ceiling (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

  test('a page the old 256 MiB recovery budget could not restore deletes and restores byte for byte', async () => withEnv(env, () => roundTrip(engine)), 3_600_000);
});
