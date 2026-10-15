import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { readPhysicalRootReservation, reservePhysicalRootRecord } from '../src/core/persistence/physical-root-record.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-transfer-lock-')));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

for (const reserved of [false, true]) {
  test(reserved ? 'the successor reservation takes precedence over the old host binding' : 'ordinary transfer retains the recorded lock across a brain-home change', async () => {
    const home = join(directory, randomUUID()), root = join(home, 'checkout'), successor = join(home, 'successor');
    mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'example.md'), 'Example content');
    const sourceId = `source-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const host = localHostId();
      const original = await claimWorktree(engine, sourceId, root, host);
      if (!original.coordination_path) throw new Error('Claim did not record a coordination lock');
      cpSync(root, successor, { recursive: true });
      let expected = original.coordination_path;
      if (reserved) {
        const previous = readPhysicalRootReservation(root)!;
        expected = join(home, 'successor.lock');
        reservePhysicalRootRecord(successor, { brainId: previous.brainId, worktreeId: original.worktree_id, hostId: host, coordinationPath: expected });
      }
      const prepared = await prepareWriterTransfer(engine, sourceId, host);
      await withEnv({ GBRAIN_HOME: join(home, 'new-home') }, () => acceptWriterTransfer(engine, sourceId, successor, prepared.owner_epoch, prepared.manifest.digest, host));
      const transferred = await getWorktreeBinding(engine, sourceId, host);
      expect(transferred?.coordination_path).toBe(expected);
      expect(transferred?.local_path).toBe(successor);
      expect(transferred?.state).toBe('active');
      expect(readPhysicalRootReservation(successor)?.coordinationPath).toBe(expected);
    });
  });
}
