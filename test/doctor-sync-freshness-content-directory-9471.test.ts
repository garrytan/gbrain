/**
 * #9471: a second source registered on a plain folder inside gbrain's own content directory (beside the default
 * source's root) is one sync refuses with `sync_not_applicable`: gbrain owns that directory, there are no Git commits
 * to sync, and the refusal names `gbrain import` instead. `gbrain sources add` writes no content-setup record for it
 * (only `gbrain init` does, for the root it creates), so doctor's writer-owned exemption never covered it and
 * sync_freshness failed it with "no successful sync recorded; run gbrain sync --source <id>" - a command that refuses
 * that source. Doctor now asks the same question sync and the automatic sync schedulers ask, so the source is counted
 * as one where sync does not apply and no sync is recommended for it. A plain folder outside the content directory is
 * still judged, because sync imports it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { assertSyncApplicable } from '../src/core/sync-applicability.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-content-dir-9471-'));
});

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

async function addSource(id: string, root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{"federated":false}'::jsonb)`, [id, root]);
}

async function syncRefusal(id: string): Promise<string | null> {
  return assertSyncApplicable(engine, { sourceId: id }).then(() => null, (error: unknown) => error instanceof OperationError ? error.code : String(error));
}

describe('#9471 a source inside gbrain\'s content directory', () => {
  test('sync refuses it, and doctor neither fails it nor recommends that sync, locally or for a remote caller', () => inHome(async () => {
    await addSource('hr-example', join(home, '.gbrain', 'content', 'brain-example', 'hr-example'));
    expect(await syncRefusal('hr-example')).toBe('sync_not_applicable');
    for (const localOnly of [true, false]) {
      const check = await checkSyncFreshness(engine, { localOnly, sourceIds: ['hr-example'] });
      expect(check.status).toBe('ok');
      expect(check.message).not.toContain('gbrain sync');
      expect(check.message).toContain('gbrain import <dir> --source hr-example');
      expect(check.fix).toBeUndefined();
      expect(check.details).toMatchObject({ stale_count: 0, content_directory_count: 1 });
    }
  }));

  test('a plain folder outside the content directory is still judged, and sync applies to it', () => inHome(async () => {
    await addSource('notes-example', join(home, 'notes-example'));
    expect(await syncRefusal('notes-example')).toBeNull();
    const check = await checkSyncFreshness(engine, { localOnly: true, sourceIds: ['notes-example'] });
    expect(check.status).toBe('fail');
    expect(check.message).toContain('gbrain sync --source notes-example');
    expect(check.details).toMatchObject({ stale_count: 1 });
  }));
});
