import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'notes/purge-fence-held';
const CONTENT = `---\ntitle: Purge fence hold\ntype: note\n---\nPage content.\n`;
let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-purge-'));
const deletePage = operations.find(op => op.name === 'delete_page')!;
const ctx = (): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); });

describe('page purge and fence holds', () => {
  test('removes a no_proof fence hold for the purged owner only', async () => {
    await withEnv({ GBRAIN_HOME: home }, () => importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default' }));
    for (const slug of [SLUG, 'notes/other-page']) {
      await engine.executeRaw(`INSERT INTO derived_generations
        (source_id,kind,owner_key,state,operation_id,item_set_hash,held_reason)
        VALUES ('default','fact_fence',$1,'held','test','empty','no_proof')`, [`page:${slug}`]);
    }
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
    await withEnv({ GBRAIN_HOME: home }, () => deletePage.handler(ctx(), { slug: SLUG, purge: true,
      request_id: randomUUID(), expected_revision: snapshot!.revision }));
    const rows = await engine.executeRaw<{ owner_key: string; held_reason: string }>(`SELECT owner_key,held_reason FROM derived_generations
      WHERE source_id='default' AND state='held' ORDER BY owner_key`);
    expect(rows).toEqual([{ owner_key: 'page:notes/other-page', held_reason: 'no_proof' }]);
  }, 60_000);
});
