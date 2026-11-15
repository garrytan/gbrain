/**
 * An identical retry of a managed folder attach (same request id) replays the first answer.
 *
 * 1. Protects: attaching a folder to an existing source with no local path, then retrying the exact call with the
 *    same request id, succeeds both times; the default-search choice made for the first attempt is reused.
 * 2. Fails when: the retry re-derives federated from the row the first attempt already wrote (it now has a local
 *    path), so the request digest changes and the retry answers idempotency_conflict.
 * 3. No production seam: managedBrain on PGLite and the real addSource.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { managedBrain } from './helpers/managed-brain.ts';
import { addSource } from '../src/core/sources-ops.ts';

test('an identical attach retry with the same request id succeeds', async () => {
  await managedBrain(async ({ engine }) => {
    await addSource(engine, { id: 'att', requestId: randomUUID() });
    await engine.executeRaw("UPDATE sources SET config = config - 'federated' WHERE id = 'att'");
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-attach-retry-'));
    try {
      const rid = randomUUID();
      await addSource(engine, { id: 'att', localPath: dir, force: true, requestId: rid });
      await addSource(engine, { id: 'att', localPath: dir, force: true, requestId: rid });
      const [row] = await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id = 'att'");
      expect(row?.local_path).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}, 120_000);
