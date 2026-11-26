import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const putPages = operations.find(op => op.name === 'put_pages')!;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

describe('put_pages status miss', () => {
  test('does not advise resubmitting when the batch cannot be seen', async () => {
    const ctx = {
      engine, config: { engine: 'pglite', embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default',
    } as unknown as OperationContext;
    const error = await putPages.handler(ctx, { request_id: randomUUID() }).then(() => null, (e: unknown) => e) as any;
    expect(error?.code).toBe('not_found');
    const text = `${error?.message ?? ''} ${error?.suggestion ?? ''}`;
    expect(text).not.toContain('resubmit its pages');
    expect(text).toContain('original outcome');
  });
});
