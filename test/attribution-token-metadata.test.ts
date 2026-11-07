/**
 * Host-supplied token metadata (folds #8664): a token minted with metadata
 * echoes it on the write-attribution principal; a token without metadata keeps
 * the exact pre-metadata principal shape; oversized metadata is refused at mint.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';

let engine: PGLiteEngine;
const logger = { info() {}, warn() {}, error() {} };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

async function principalOfPageWrittenBy(name: string, metadata?: Record<string, unknown>) {
  const { id } = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], metadata });
  const sourceId = `meta-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Body.' }, { sourceId });
  await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.executeRaw(`UPDATE pages SET revision_write_request_id=$1, revision_principal_kind='legacy_token', revision_principal_id=$2
      WHERE source_id=$3 AND slug='notes/example'`, [randomUUID(), id, sourceId]);
  });
  const ctx = { engine, sourceId, remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true }, logger } as OperationContext;
  const result = await operationsByName.get_write_attribution.handler(ctx, { slug: 'notes/example' }) as Record<string, any>;
  return { id, principal: result.last.principal };
}

describe('access token metadata on write attribution', () => {
  test('a token minted with metadata echoes it on the principal', async () => {
    const metadata = { ai: 'claude', harness: 'claude-code', connection_id: 'conn-1' };
    const { id, principal } = await principalOfPageWrittenBy('host-key', metadata);
    expect(principal).toEqual({ kind: 'legacy_token', id, name: 'host-key', metadata });
  });

  test('a token without metadata keeps the exact principal shape', async () => {
    const { id, principal } = await principalOfPageWrittenBy('plain-key');
    expect(principal).toEqual({ kind: 'legacy_token', id, name: 'plain-key' });
    expect('metadata' in principal).toBe(false);
  });

  test('metadata over 4 KB is refused with invalid_params', async () => {
    await expect(mintLegacyToken(engine, { name: 'big-key', scopes: ['read'], takesHolders: ['world'], metadata: { blob: 'x'.repeat(4096) } }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});
