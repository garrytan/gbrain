/**
 * A new-brain restore gives the restored brain a FRESH brain id, so the restored copy and the original are never the
 * same brain to a shared-skills member or a receipt. One table, three engines:
 *
 * - PGLite: the real restore step (`quarantineSharedSkillRestore`) re-rolls `persistence_brain.brain_id`.
 * - Postgres: the restore tool does not manage a Postgres brain (it keeps pg_dump / pg_restore) and refuses by name,
 *   changing nothing; a restored Postgres database is a new database whose operator re-issues authority.
 * - Rust: the same promise. `restoreQuarantine` writes a new uuid into the `meta:format` record (keeping `rotated_from`)
 *   and rewrites FORMAT by atomic rename (21b-rust); the report and the restore result name the old and the new id, and a
 *   fresh process opens the restored brain under the new one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { quarantineSharedSkillRestore } from '../src/core/shared-skills/restore.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { verifyStoreDir } from '../src/core/rust-engine/store.ts';
import { createBackup, restoreBackup } from '../src/core/backup/rust-snapshot.ts';
import { brainDir, makeHome, seedBrain } from './helpers/rust-backup-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

let temporary: string;
beforeAll(() => { temporary = mkdtempSync(join(tmpdir(), 'gbrain-brain-id-')); });
afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

describe('a new-brain restore makes a fresh brain id', () => {
  test('PGLite: the restore step re-rolls the shared brain identity', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    try {
      await engine.initSchema();
      const memory = join(temporary, 'pglite-memory');
      mkdirSync(memory);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [memory]);
      await claimWorktree(engine, 'default', memory);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      const read = async () => (await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1'))[0]!.brain_id;
      const archived = await read();
      const restored = await engine.transaction(tx => quarantineSharedSkillRestore(tx, 'restore-id'));
      expect(restored).toMatchObject({ mode: 'new_brain', previous_brain_id: archived });
      expect(restored!.brain_id).not.toBe(archived);
      expect(await read()).toBe(restored!.brain_id);
    } finally { await engine.disconnect(); }
  }, 60_000);

  test('Postgres: the restore tool refuses by name and changes nothing; the database dump route is named', async () => {
    // With DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1, the elig-pg container) the step runs inside a real Postgres transaction.
    const engine = new PostgresEngine();
    const url = process.env.DATABASE_URL;
    if (url) await engine.connect({ engine: 'postgres', database_url: url });
    try {
      await expect(url ? engine.transaction(tx => quarantineSharedSkillRestore(tx, 'restore-id')) : quarantineSharedSkillRestore(engine, 'restore-id'))
        .rejects.toMatchObject({ code: 'pglite_required' });
    } finally { if (url) await engine.disconnect(); }
    const root = join(temporary, 'pg-home');
    makeHome(root);
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://user-example@db.example.invalid/brain' }));
    const refusal = await createBackup({ output: join(temporary, 'pg.gbrain-backup'), root }).then(() => null, (error: Error) => error as Error & { reason?: string });
    expect(refusal?.reason).toBe('pglite_required');
    expect(refusal?.message).toContain('pg_dump');
  });

  (HAVE_ADDON ? test : test.skip)('Rust: the restore rotates the store brain id, names both ids, and the closed store carries the new one', async () => {
    const addon: RustAddon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const root = join(temporary, 'rust-home');
    makeHome(root);
    await seedBrain(addon, root);
    const archive = `${root}.gbrain-backup`;
    const created = await createBackup({ output: archive, root, addon });
    const archived = (created.manifest as Record<string, any>).store.brain_id as string;
    const into = join(temporary, 'rust-restored');
    const restored = await restoreBackup({ archive, into, addon });
    const { brain_id } = restored as { brain_id: { archived: string; restored: string }; reconnect_required: string[] };
    expect(brain_id.archived).toBe(archived);
    expect(brain_id.restored).not.toBe(archived);
    const closed = await verifyStoreDir(addon, brainDir(into));
    expect(closed).toMatchObject({ verdict: 'ok', brain_id: brain_id.restored });
    expect((restored as { reconnect_required: string[] }).reconnect_required.join('\n')).toContain(`Brain id changed by this restore: ${archived} (the original) -> ${brain_id.restored}`);
    // The original brain still has its own id.
    expect((await verifyStoreDir(addon, brainDir(root))).brain_id).toBe(archived);
  }, 60_000);
});
