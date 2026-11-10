import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

async function statementTimeoutDuring(operation: 'archive' | 'remove'): Promise<string | undefined> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-remove-timeout-'));
  const seen: string[] = [];
  const original = engine.transaction.bind(engine);
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await resetPgliteState(engine); await registerLocalWriter(engine, 'cli');
      const source = 'timeout-source', root = join(home, 'canonical'); mkdirSync(root);
      writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      (engine as { transaction: unknown }).transaction = (fn: (tx: PGLiteEngine) => Promise<unknown>) => original(async tx => {
        const raw = tx.executeRaw.bind(tx);
        (tx as { executeRaw: unknown }).executeRaw = async (sql: string, params?: unknown[]) => {
          const rows = await raw(sql, params);
          if (sql.includes("'statement_timeout'")) seen.push((await raw("SELECT current_setting('statement_timeout') AS value") as { value: string }[])[0].value);
          return rows;
        };
        return fn(tx as PGLiteEngine);
      });
      await runManagedSourceLifecycle(engine, { operation, sourceId: source, confirmDestructive: operation === 'remove', requestId: randomUUID() });
      return seen[0];
    });
  } finally { (engine as { transaction: unknown }).transaction = original; rmSync(home, { recursive: true, force: true }); }
}

test('source remove gets a longer statement bound than the 5s topology default so cascades can finish', async () => {
  expect(await statementTimeoutDuring('archive')).toBe('5s');
  const removeBound = await statementTimeoutDuring('remove');
  expect(removeBound).toBeDefined();
  expect(removeBound).not.toBe('5s');
}, 60_000);
