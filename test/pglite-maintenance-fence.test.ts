import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { backupUnmanagedPglite } from '../src/core/persistence/maintenance.ts';
import { refreshManagedFilesystemRoots } from '../src/core/persistence/filesystem-guard.ts';
import { getPgliteKernelLockPath } from '../src/core/pglite-lock.ts';
import { withEnv } from './helpers/with-env.ts';

let unmanagedEngine: PGLiteEngine;
let managedEngine: PGLiteEngine;
beforeAll(() => { unmanagedEngine = new PGLiteEngine(); managedEngine = new PGLiteEngine(); });
afterAll(async () => { await unmanagedEngine.disconnect(); await managedEngine.disconnect(); });

test('unmanaged reinit refuses a live native owner and holds exclusion through rename', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-lock-')); const path = join(home, 'brain.pglite');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = unmanagedEngine;
    try {
      await engine.connect({ database_path: path });
      await expect(backupUnmanagedPglite(path, `${path}.bak`)).rejects.toMatchObject({ code: 'pglite_busy' });
      expect(existsSync(path)).toBe(true); expect(existsSync(`${path}.bak`)).toBe(false);
    } finally { await engine.disconnect(); }
    await backupUnmanagedPglite(path, `${path}.bak`);
    expect(existsSync(path)).toBe(false); expect(existsSync(`${path}.bak`)).toBe(true);
    expect(existsSync(join(`${path}.bak`, '.gbrain-lock'))).toBe(false);
    expect(existsSync(getPgliteKernelLockPath(path)!)).toBe(true);
  });
  rmSync(home, { recursive: true, force: true });
}, 30_000);

test('managed PGLite datastore refusal survives disconnect and unavailable database bytes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-managed-')); const path = join(home, 'selected-brain.pglite');
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const engine = managedEngine;
      try {
        await engine.connect({ database_path: path }); await engine.initSchema();
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await refreshManagedFilesystemRoots(engine);
      } finally { await engine.disconnect(); }
      expect(existsSync(join(path, '.gbrain-managed'))).toBe(true);
      // A corrupt/offline datastore does not require opening a second engine to
      // determine whether destructive maintenance is forbidden.
      rmSync(path, { recursive: true });
      await expect(backupUnmanagedPglite(path, `${path}.bak`)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
      expect(existsSync(`${path}.bak`)).toBe(false);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
