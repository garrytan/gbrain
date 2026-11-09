import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gbrainPath } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { externalRecoveryChanged, readExternalRecovery } from '../src/core/backup/external-recovery.ts';
import { withEnv } from './helpers/with-env.ts';

test.skipIf(process.getuid === undefined)('external recovery requires an actual restore, a current brain and an owner-only receipt', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-proof-'));
  const brain = '10000000-0000-4000-8000-000000000001';
  const incarnation = '10000000-0000-4000-8000-000000000002';
  const snapshot = '2026-01-02T00:00:00Z';
  const verified = '2026-01-02T01:00:00Z';
  const now = Date.parse(verified);
  const engine = {
    kind: 'postgres',
    executeRaw: async () => [{ brain_id: brain, source_incarnation: incarnation }],
  } as unknown as BrainEngine;
  const proof = {
    version: 1, scope: 'postgres_and_canonical_files', source_id: 'default',
    brain_id: brain, source_incarnation: incarnation, remote_commit: 'a'.repeat(40),
    restored_commit: 'a'.repeat(40), snapshot_at: snapshot, restore_verified_at: verified,
    verification: 'remote_cipher_decrypted_restore',
  };
  try {
    await withEnv({ HOME: home, GBRAIN_HOME: home }, async () => {
      const file = gbrainPath('backup', 'external-recovery.json');
      mkdirSync(dirname(file), { recursive: true });
      const write = (value: object) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      write(proof);
      expect(await readExternalRecovery(engine, now)).toEqual({ snapshot_at: snapshot, restore_verified_at: verified });
      expect(await readExternalRecovery(engine, now + 36 * 60 * 60 * 1000)).toBeNull();
      write({ ...proof, verification: 'prepared_dump_restore_and_remote_cipher_readback' });
      expect(await readExternalRecovery(engine, now)).toBeNull();
      write({ ...proof, source_incarnation: brain });
      expect(await readExternalRecovery(engine, now)).toBeNull();
      write(proof);
      chmodSync(file, 0o644);
      expect(externalRecoveryChanged('2999-01-01T00:00:00Z', true)).toBe(true);
      expect(await readExternalRecovery(engine, now)).toBeNull();
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
