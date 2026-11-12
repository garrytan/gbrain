/**
 * #5216 follow-up: a revision-bound write that reaches publication while its
 * page still awaits the revision backfill settles as a conflict carrying
 * `revision_backfill_pending` and the resume command, never as an opaque
 * `storage_error` ("Publication failed").
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { PAGE_STATE_SCHEMA_STATEMENTS } from '../src/core/page-state/schema.ts';
import { REVISION_BACKFILL_STATE_KEY } from '../src/core/page-state/revision-backfill-schema.ts';

let engine: PGLiteEngine;
let fixture: string;
const slug = 'notes/backfill-pending';

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  fixture = mkdtempSync(join(tmpdir(), 'gb-backfill-pending-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
});
afterEach(async () => {
  await disposePersistenceConsumer(engine);
  rmSync(fixture, { recursive: true, force: true });
});

describe('revision_backfill_pending at publication', () => {
  test('a write admitted at a revision whose row then awaits the backfill fails as a conflict naming the resume command', () =>
    withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
      const cli = await registerLocalWriter(engine, 'cli');
      const call = (name: string, params: Record<string, unknown>) => withVerifiedLocalRegistration(engine, cli, () => dispatchToolCall(engine, name, params, {
        remote: false, config: { engine: 'pglite' }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
      }));
      const page = (body: string) => `---\ntitle: Backfill pending\ntype: note\n---\n\n${body}\n`;
      expect((await call('put_page', { slug, content: page('First.'), request_id: randomUUID() })).isError).not.toBe(true);
      const read = await call('get_page', { slug, include_content: true });
      const revision = JSON.parse((read.content[0] as { text: string }).text).revision as string;

      // The pre-v150 shape: the column comes back nullable and this row has no revision yet.
      await engine.executeRaw('ALTER TABLE pages DROP COLUMN IF EXISTS knowledge_revision CASCADE');
      for (const statement of PAGE_STATE_SCHEMA_STATEMENTS) await engine.executeRaw(statement);
      await engine.unsetConfig(REVISION_BACKFILL_STATE_KEY);

      const requestId = randomUUID();
      await call('put_page', { slug, content: page('Second.'), expected_revision: revision, request_id: requestId });
      const [row] = await engine.executeRaw<{ state: string; error_code: string | null; error_message: string | null }>(
        'SELECT state, error_code, error_message FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
      expect(row).toMatchObject({ state: 'conflict', error_code: 'revision_backfill_pending' });
      expect(row!.error_message).toContain('gbrain apply-migrations --force-schema');
    }), 60_000);
});
