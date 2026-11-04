/**
 * #5836 — remember infers a missing entity from one exact mention before
 * admission, and falls back to the unattributed save (with a NO_ENTITY or
 * ENTITY_LINK_FAILED warning) whenever the inferred target would fail any
 * admission check. Inferred links dedup exact text only. PGLite, synthetic
 * names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { formatRememberResult } from '../src/cli/remember-format.ts';

let engine: PGLiteEngine;
const sourceId = 'remember-inference-test';
const context = (overrides: Partial<OperationContext> = {}): OperationContext => ({ engine, remote: false, sourceId,
  config: { engine: 'pglite' }, dryRun: false, logger: { info() {}, warn() {}, error() {} }, ...overrides });
const remember = (params: Record<string, unknown>, ctx = context()) =>
  operationsByName.remember!.handler(ctx, { provenance: 'chat 2026-09-30', ...params }) as Promise<Record<string, any>>;

async function putEntity(slug: string, title: string, type: string, body = `# ${title}`, frontmatter: Record<string, unknown> = {}) {
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
    tx.putPage(slug, { type, title, compiled_truth: body, frontmatter }, { sourceId }), TEST_WRITE_ATTRIBUTION));
}
async function factRow(id: string) {
  const [row] = await engine.executeRaw<{ entity_slug: string | null; context: string | null; row_num: number | null; expired_at: Date | null; superseded_by: number | null }>(
    'SELECT entity_slug,context,row_num,expired_at,superseded_by FROM facts WHERE id=$1', [Number(id)]);
  return row!;
}
async function fenceRows(slug: string) {
  return parseFactsFence((await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth).facts;
}

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await putEntity('companies/acme-example', 'Acme Example', 'company');
  await putEntity('people/alice-example', 'Alice Example', 'person');
  await putEntity('people/dana-private-example', 'Dana Private-Example', 'person', '# Dana', { visibility: 'private' });
  await putEntity('companies/broken-fence-example', 'Broken Fence Example', 'company',
    '# Broken\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n');
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

describe('remember entity inference (#5836)', () => {
  test('a fact naming one entity links to it, notes the inference in row and fence, and prints it', async () => {
    const r = await remember({ fact: 'Acme Example raised a seed round' });
    expect(r).toMatchObject({ status: 'inserted', entity_slug: 'companies/acme-example', entity_inferred: 'mention' });
    expect(r.warnings).toBeUndefined();
    const row = await factRow(r.id);
    expect(row.entity_slug).toBe('companies/acme-example');
    expect(row.context).toBe('entity inferred from mention');
    expect(row.row_num).not.toBeNull();
    const cell = (await fenceRows('companies/acme-example')).find(f => f.claim === 'Acme Example raised a seed round');
    expect(cell?.context).toBe('entity inferred from mention');
    expect(formatRememberResult(r)).toContain('entity: companies/acme-example (inferred from mention)');
  });

  test('an unattributed save warns NO_ENTITY with a hint naming the entity field', async () => {
    const r = await remember({ fact: 'prefers dark mode in every editor' });
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    expect(r.hint).toContain('`entity`');
    expect(r.entity_inferred).toBeUndefined();
    const printed = formatRememberResult(r);
    expect(printed).toContain('warning: NO_ENTITY');
    expect(printed).toContain('hint: ');
  });

  test('infer_entity:false stores the fact unattributed', async () => {
    const r = await remember({ fact: 'Acme Example opened a second office', infer_entity: false });
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    expect((await factRow(r.id)).entity_slug).toBeNull();
  });

  test('the facts.entity_inference kill switch stores the fact unattributed', async () => {
    await engine.setConfig('facts.entity_inference', 'off');
    try {
      const r = await remember({ fact: 'Acme Example moved its offsite to May' });
      expect(r.entity_slug).toBeNull();
      expect(r.warnings).toEqual(['NO_ENTITY']);
    } finally { await engine.unsetConfig('facts.entity_inference'); }
  });

  test('an explicit entity is unchanged: no inference, no warning, no note', async () => {
    const r = await remember({ fact: 'Alice Example met Acme Example about pricing', entity: 'people/alice-example' });
    expect(r).toMatchObject({ status: 'inserted', entity_slug: 'people/alice-example' });
    expect(r.entity_inferred).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    expect((await factRow(r.id)).context).toBeNull();
  });

  test('a client slug fence that excludes the inferred entity falls back without error', async () => {
    const clientId = `client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,bound_slug_prefixes)
      VALUES($1,'fixture-hash','example-client','read write',$2,$3::text[])`, [clientId, sourceId, ['memory/']]);
    const ctx = context({ remote: true, auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId },
      scopes: ['read', 'write'], sourceId, boundSlugPrefixes: ['memory/'] } as OperationContext['auth'] });
    const r = await remember({ fact: 'Acme Example signed a new lease' }, ctx);
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    const control = await remember({ fact: 'Acme Example signed a second lease' }, context({ remote: true }));
    expect(control.entity_slug).toBe('companies/acme-example');
  });

  test('a subagent fence that excludes the inferred entity falls back without error', async () => {
    const r = await remember({ fact: 'Acme Example renewed the contract' },
      context({ viaSubagent: true, subagentId: 7, allowedSlugPrefixes: ['memory/*'] }));
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
  });

  test('a remote caller never links (or learns of) a private entity', async () => {
    const r = await remember({ fact: 'Dana Private-Example is relocating' }, context({ remote: true }));
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    const local = await remember({ fact: 'Dana Private-Example is relocating soon', visibility: 'private' });
    expect(local.entity_slug).toBe('people/dana-private-example');
  });

  test('a malformed target fence warns ENTITY_LINK_FAILED and saves unattributed', async () => {
    const r = await remember({ fact: 'Broken Fence Example hired a CFO' });
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['ENTITY_LINK_FAILED']);
    expect(formatRememberResult(r)).toContain('warning: ENTITY_LINK_FAILED');
    expect((await factRow(r.id)).entity_slug).toBeNull();
  });

  test('a replayed request id returns the original inferred link from the caller intent', async () => {
    const params = { fact: 'Acme Example hired a head of sales', request_id: randomUUID() };
    const first = await remember(params);
    expect(first).toMatchObject({ entity_slug: 'companies/acme-example', entity_inferred: 'mention' });
    await engine.setConfig('facts.entity_inference', 'off');
    try {
      expect(await remember(params)).toEqual(first);
    } finally { await engine.unsetConfig('facts.entity_inference'); }
  });

  test('an inferred link never supersedes a similar fact: both stay active', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-inference' } });
    __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(() => [1, ...new Array(1535).fill(0)]) })) as never);
    try {
      const first = await remember({ fact: 'Acme Example targets 40 percent gross margin', entity: 'companies/acme-example' });
      expect(first.status).toBe('inserted');
      const second = await remember({ fact: 'Acme Example targets 45 percent gross margin' });
      expect(second).toMatchObject({ status: 'inserted', entity_slug: 'companies/acme-example', entity_inferred: 'mention' });
      const [a, b] = [await factRow(first.id), await factRow(second.id)];
      expect(a.expired_at).toBeNull();
      expect(a.superseded_by).toBeNull();
      expect(b.expired_at).toBeNull();
      const fence = await fenceRows('companies/acme-example');
      expect(fence.find(f => f.claim === 'Acme Example targets 40 percent gross margin')?.active).toBe(true);
      const exact = await remember({ fact: 'Acme Example targets 45 percent gross margin' });
      expect(exact).toMatchObject({ status: 'duplicate', id: second.id });
    } finally {
      __setEmbedTransportForTests(null);
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }
  });

  test('facts.entity_inference is a registered config key', async () => {
    const { KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    expect(KNOWN_CONFIG_KEYS).toContain('facts.entity_inference');
  });
});
