/**
 * #10476: a put_pages status poll (request_id, no pages) that finds no batch under the caller's principal cannot tell a
 * refused batch from one another writer principal submitted, so its reply must not tell the caller to resubmit: a
 * resend under a new principal can admit the pages a second time. It keeps the not_found code (no existence leak).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const putPages = operations.find(op => op.name === 'put_pages')!;
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine?.disconnect(); });

describe('put_pages status miss (#10476)', () => {
  test('an unseen batch id says the outcome is unknown and never advises resubmitting', async () => {
    const ctx = { engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} },
      dryRun: false, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const err = await putPages.handler(ctx, { request_id: randomUUID() }).then(() => null, (e: unknown) => e) as { code?: string; message?: string; suggestion?: string } | null;
    expect(err?.code).toBe('not_found');
    const text = `${err?.message ?? ''} ${err?.suggestion ?? ''}`;
    expect(text).not.toMatch(/resubmit/i);
    expect(text).toContain('outcome is unknown');
    expect(text).toContain('before resending');
  });
});
