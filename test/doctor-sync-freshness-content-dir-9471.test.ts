/**
 * #9471: doctor's sync_freshness must not ask for a sync that `sync` refuses.
 * A source registered inside the gbrain content directory has no content receipt,
 * yet sync refuses it as sync_not_applicable, so doctor must not fail it as never synced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { syncContentDirectory } from '../src/core/sync-applicability.ts';

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
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-content-dir-'));
});

describe('sync_freshness on a content-directory source without a receipt (#9471)', () => {
  test('is not failed when sync refuses the same source', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const dir = join(home, '.gbrain', 'content', 'brain-example', 'hr-example');
    mkdirSync(dir, { recursive: true });
    await engine.executeRaw("DELETE FROM sources WHERE id<>'default'");
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('hr-example','HR',$1,'{\"federated\":false}'::jsonb)", [dir]);
    expect(await syncContentDirectory(engine, { sourceId: 'hr-example' })).not.toBeNull();
    const result = await checkSyncFreshness(engine, { localOnly: true });
    expect(result.message).not.toContain("Source 'hr-example'");
    expect(result.status).not.toBe('fail');
  }));
});
