import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

test('same-engine disk reconnect resumes managed writes and retained request replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-persistence-reconnect-'));
  try { await withEnv({ GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    const config = { engine: 'pglite' as const, database_path: join(root, 'database') };
    const ctx = { engine, config, sourceId: 'default', remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    let residentHooks = 0;
    const registerStop = engine.registerBeforeDisconnect.bind(engine);
    engine.registerBeforeDisconnect = stop => {
      residentHooks++;
      const unregister = registerStop(stop);
      return () => { residentHooks--; unregister(); };
    };
    try {
      await engine.connect(config); await engine.initSchema();
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true });
      const params = { request_id: randomUUID(), slug: 'reconnect-example', content: '---\ntype: note\ntitle: Reconnect example\n---\nOriginal content' };
      const first = await submitPageMutation(ctx, { operation: 'put_page', params });
      expect(first.state).toBe('committed');
      for (let attempt = 0; attempt < 2; attempt++) {
        await engine.reconnect();
        expect(persistenceConsumerStatus(engine)).toMatchObject({ state: 'open', accepting: true });
        const replay = await submitPageMutation(ctx, { operation: 'put_page', params });
        expect(replay).toMatchObject({ request_id: first.request_id, revision: first.revision, state: 'committed' });
        const next = await submitPageMutation(ctx, { operation: 'put_page', params: {
          request_id: randomUUID(), slug: `after-reconnect-${attempt}`, content: `Content after reconnect ${attempt}`,
        } });
        expect(next.state).toBe('committed');
        expect(residentHooks).toBe(1);
        expect((await engine.getPage(`after-reconnect-${attempt}`, { sourceId: 'default' }))?.compiled_truth).toContain(`Content after reconnect ${attempt}`);
      }
      const [count] = await engine.executeRaw<{ count: number }>('SELECT count(*)::integer AS count FROM persistence_requests');
      expect(count.count).toBe(3);
      await disposePersistenceConsumer(engine);
      expect(residentHooks).toBe(0);
      await engine.reconnect();
      expect(persistenceConsumerStatus(engine).state).toBe('not_running');
    } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  }); } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
