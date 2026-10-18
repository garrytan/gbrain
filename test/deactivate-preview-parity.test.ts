/**
 * #5914 (W14 P1.3 [R9a]): each `deactivate --dry-run` runs the probe of its own
 * real operation on a recreated canonical root. The classic (pre-activation)
 * release publishes nothing, so it holds the native lock and checks only the
 * reservation's worktree id and token: its preview lists no `physical_root`
 * blocker and the real release succeeds; a token mismatch still refuses both.
 * The managed real run takes the strict worktree lock, so its preview lists
 * `physical_root` and the real run refuses with the same blocker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { recreateRoot } from './helpers/recreate-root.ts';

const admin = (engine: BrainEngine, operation: string, params: Record<string, unknown> = {}) =>
  runPersistenceAdministration(engine, operation as never, params) as Promise<Record<string, any>>;
const deactivate = async (engine: BrainEngine, extra: Record<string, unknown> = {}) =>
  admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: await writerAdminState(engine), ...extra });
function corruptToken(root: string) {
  const path = join(root, PHYSICAL_ROOT_MARKER), stamp = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...stamp, token: randomUUID() }), { mode: 0o600 });
}

describe('classic release (pre-activation claim) on a recreated root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-preview-parity-'));
  let engine: BrainEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  async function claimed(run: (f: { root: string; source: string }) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `classic-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(root, 'note.md'), 'Canonical example');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
      await run({ root, source });
    });
  }

  test('preview lists no physical_root blocker and the real release succeeds', () => claimed(async f => {
    recreateRoot(f.root, { keepStamp: true });
    const dry = await admin(engine, 'writer_deactivate', { dry_run: true });
    expect(dry.mode).toBe('classic');
    expect(dry.pre_activation_claims.map((c: { source_id: string }) => c.source_id)).toEqual([f.source]);
    expect(dry.blockers).toEqual([]);
    const released = await deactivate(engine);
    expect(released.pre_activation_claims.map((c: { source_id: string }) => c.source_id)).toEqual([f.source]);
    expect(await getWorktreeBinding(engine, f.source)).toBeNull();
  }));

  test('a token mismatch: the preview lists physical_root and the real release refuses on the same blocker', () => claimed(async f => {
    recreateRoot(f.root, { keepStamp: true });
    corruptToken(f.root);
    const dry = await admin(engine, 'writer_deactivate', { dry_run: true });
    expect(dry.blockers.map((b: { kind: string; source_id?: string }) => [b.kind, b.source_id])).toEqual([['physical_root', f.source]]);
    await expect(deactivate(engine)).rejects.toMatchObject({ code: 'writer_not_quiesced', suggestion: expect.stringContaining(`physical_root ${dry.blockers[0].id}`) });
    expect(await getWorktreeBinding(engine, f.source)).not.toBeNull();
    await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [f.source]);
  }));
});

describe('managed deactivation on a recreated root', () => {
  test('preview lists physical_root and the real run refuses with the same blocker', () => managedBrain(async ({ engine, root }) => {
    recreateRoot(root, { keepStamp: true });
    const dry = await admin(engine, 'writer_deactivate', { dry_run: true });
    expect(dry.mode).toBe('managed');
    const blocker = dry.blockers.find((b: { kind: string }) => b.kind === 'physical_root');
    expect(blocker).toMatchObject({ source_id: 'default' });
    expect(blocker.exit).toContain('--self-transfer');
    expect(blocker.exit).toContain('--confirm-relocated-root');
    await expect(deactivate(engine)).rejects.toMatchObject({ code: 'writer_not_quiesced', suggestion: expect.stringContaining('physical_root') });
    expect((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled).toBe(true);
  }));
});
