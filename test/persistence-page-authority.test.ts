import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { authorizeStoredRequest, ownRequestAccessible, submissionAuthority } from '../src/core/persistence/authority.ts';
import { getWriteRequest, admitWrite } from '../src/core/persistence/journal.ts';
import { listWriteRequests, cancelWriteRequest } from '../src/core/persistence/control.ts';

const engines: BrainEngine[] = [];
const roots: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'page-authority-test';
const context = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId,
  remote: true, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const page = (visibility = 'world') => ({ type: 'note', title: 'Example', compiled_truth: 'Example prose', timeline: '', frontmatter: { visibility } });
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('remote force cannot overwrite a private target or learn its revision', async () => {
  for (const engine of engines) {
    const original = await engine.putPage('private', page('private'), { sourceId });
    await expect(submitPageMutation(context(engine), { operation: 'put_page', params: {
      slug: 'private', content: 'Replacement', force: true, request_id: randomUUID(),
    } })).rejects.toMatchObject({ code: 'page_not_found' });
    expect((await engine.getPage('private', { sourceId }))!.knowledge_revision).toBe(original.knowledge_revision);
  }
});

test('replay and receipt enumeration hide targets that become inaccessible', async () => {
  for (const engine of engines) {
    const request_id = randomUUID(), params = { slug: 'receipt', content: 'Example prose', request_id };
    await submitPageMutation(context(engine), { operation: 'put_page', params });
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const auth = await submissionAuthority(context(engine), 'put_page', sourceId, source.incarnation, 'receipt');
    const row = (await getWriteRequest(engine, auth.principal, request_id))!;
    expect(await ownRequestAccessible(context(engine), row)).toBe(true);
    await engine.putPage('receipt', page('private'), { sourceId });
    expect(await ownRequestAccessible(context(engine), row)).toBe(false);
    expect((await listWriteRequests(engine, auth.principal, { sourceId })).requests.some(r => r.id === row.id)).toBe(false);
    await expect(submitPageMutation(context(engine), { operation: 'put_page', params })).rejects.toMatchObject({ code: 'page_not_found' });
  }
});

test('accepted visibility is an immutable ceiling and current policy can narrow it', async () => {
  for (const engine of engines) {
    await engine.putPage('ceiling', page(), { sourceId });
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const authority = await submissionAuthority(context(engine), 'put_page', sourceId, source.incarnation, 'ceiling');
    const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
      sourceIncarnation: source.incarnation, slug: 'ceiling', requestId: randomUUID(), callerIntent: {}, intent: {} });
    await engine.putPage('ceiling', page('private'), { sourceId });
    await engine.setConfig('search.remote_private_pages', 'visible');
    try {
      await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' });
      const optedIn = await submissionAuthority(context(engine), 'put_page', sourceId, source.incarnation, 'ceiling');
      expect(optedIn.excludePrivate).toBe(false);
      await engine.setConfig('search.remote_private_pages', 'false');
      await expect(authorizeStoredRequest(engine, { ...row, authority: optedIn })).rejects.toMatchObject({ code: 'page_not_found' });
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key='search.remote_private_pages'");
      await engine.putPage('ceiling', page(), { sourceId });
      await cancelWriteRequest(engine, authority.principal, row.request_id);
    }
  }
});

test('sandboxed subagents keep intentional database-only writes despite a configured canonical root', async () => {
  for (const engine of engines) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-subagent-writer-')); roots.push(root);
    const sandboxSource = `sandbox-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sandboxSource, root]);
    const result = await submitPageMutation({ ...context(engine), sourceId: sandboxSource, viaSubagent: true, subagentId: 7 }, {
      operation: 'put_page', params: { slug: 'wiki/agents/7/example', content: 'Sandbox example', request_id: randomUUID() },
    });
    expect(result.state).toBe('committed');
    expect(result.persistence).toEqual({ mode: 'database' });
    expect(existsSync(join(root, 'wiki/agents/7/example.md'))).toBe(false);
    const bindings = await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [sandboxSource]);
    expect(bindings).toHaveLength(0);
  }
});

describe('OAuth delegated job namespace (#5920)', () => {
  const JOB = 4107;
  const delegatedClient = async (engine: BrainEngine, namespace: 'job' | 'prefixes', prefixes: string[] | null) => {
    const clientId = `delegated-${namespace}-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id,client_name,client_secret_hash,scope,source_id,bound_source_id,
      federated_read,bound_tools,delegated_namespace,delegated_slug_prefixes)
      VALUES($1,'example-delegate','fixture-hash','read agent',$2,$2,ARRAY[$2]::text[],ARRAY['mcp__gbrain__put_page'],$3,$4::text[])`,
      [clientId, sourceId, namespace, prefixes]);
    return clientId;
  };
  const delegatedCtx = (engine: BrainEngine, clientId: string, extra: Partial<OperationContext> = {}): OperationContext => ({
    ...context(engine), viaSubagent: true, subagentId: JOB, ...extra,
    auth: { token: 'fixture-token', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'agent'], sourceId },
  });
  const write = (ctx: OperationContext, slug: string, request_id: string = randomUUID()) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: `Delegated body for ${slug}`, request_id } });
  const grant = (engine: BrainEngine, clientId: string, assignments: string) =>
    engine.executeRaw(`UPDATE oauth_clients SET ${assignments} WHERE client_id=$1`, [clientId]);
  const denied = { code: 'permission_denied' };

  test('a job grant publishes and replays inside its own job tree only', async () => {
    for (const engine of engines) {
      const clientId = await delegatedClient(engine, 'job', null);
      const ctx = delegatedCtx(engine, clientId);
      const request_id = randomUUID();
      const own = `wiki/agents/${JOB}/summary`;
      expect((await write(ctx, own, request_id)).state).toBe('committed');
      expect((await engine.getPage(own, { sourceId }))?.compiled_truth).toContain('Delegated body');
      const receipt = (await getWriteRequest(engine, ctx.auth!.principal!, request_id))!;
      expect(receipt.authority.delegatedJobId).toBe(JOB);
      await authorizeStoredRequest(engine, receipt);
      expect((await write(ctx, own, request_id)).state).toBe('committed');
      for (const outside of [`wiki/agents/${JOB + 1}/summary`, `wiki/agents/${JOB}0/summary`, `wiki/agents/${JOB}x/summary`,
        `wiki/agents/${JOB}`, 'wiki/agents/summary', 'notes/summary']) {
        await expect(write(ctx, outside)).rejects.toMatchObject(denied);
        expect(await engine.getPage(outside, { sourceId })).toBeNull();
      }
    }
  });

  test('a stored receipt cannot borrow another job id or a malformed one', async () => {
    for (const engine of engines) {
      const clientId = await delegatedClient(engine, 'job', null);
      const ctx = delegatedCtx(engine, clientId);
      const request_id = randomUUID();
      await write(ctx, `wiki/agents/${JOB}/ledger`, request_id);
      const receipt = (await getWriteRequest(engine, ctx.auth!.principal!, request_id))!;
      for (const forged of [JOB + 1, JOB - 1, undefined, null, 0, -JOB, JOB + 0.5, Number.NaN, Infinity, String(JOB),
        Number.MAX_SAFE_INTEGER + 2, [JOB], { id: JOB }]) {
        await expect(authorizeStoredRequest(engine, { ...receipt, authority: { ...receipt.authority, delegatedJobId: forged as number } }))
          .rejects.toMatchObject(denied);
      }
      await expect(authorizeStoredRequest(engine, { ...receipt, slug: `wiki/agents/${JOB + 1}/ledger` })).rejects.toMatchObject(denied);
      await expect(authorizeStoredRequest(engine, { ...receipt, authority: { ...receipt.authority, sourceId: 'example-foreign-source' } }))
        .rejects.toMatchObject(denied);
    }
  });

  test('a delegated job context without a usable job id is denied and writes nothing', async () => {
    for (const engine of engines) {
      const clientId = await delegatedClient(engine, 'job', null);
      for (const subagentId of [Number.NaN, 0, -JOB, JOB + 0.25]) {
        for (const slug of [`wiki/agents/${JOB}/note`, 'wiki/agents/0/note', 'wiki/agents/NaN/note']) {
          await expect(write(delegatedCtx(engine, clientId, { subagentId }), slug)).rejects.toMatchObject(denied);
          expect(await engine.getPage(slug, { sourceId })).toBeNull();
        }
      }
      await expect(submitPageMutation(delegatedCtx(engine, clientId), { operation: 'put_page', params: {
        slug: `wiki/agents/${JOB}/note`, content: 'Elsewhere', request_id: randomUUID(), source_id: 'example-foreign-source',
      } })).rejects.toMatchObject(denied);
    }
  });

  test('narrowing, switching or revoking the live job grant stops replay', async () => {
    for (const engine of engines) {
      const clientId = await delegatedClient(engine, 'job', null);
      const ctx = delegatedCtx(engine, clientId);
      const request_id = randomUUID();
      await write(ctx, `wiki/agents/${JOB}/plan`, request_id);
      const receipt = (await getWriteRequest(engine, ctx.auth!.principal!, request_id))!;
      const changes = [
        ["bound_tools=ARRAY['mcp__gbrain__get_page']", "bound_tools=ARRAY['mcp__gbrain__put_page']"],
        ["delegated_namespace='prefixes', delegated_slug_prefixes=ARRAY['notes/*']", "delegated_namespace='job', delegated_slug_prefixes=NULL"],
        ["scope='read'", "scope='read agent'"],
        ['deleted_at=now()', 'deleted_at=NULL'],
      ];
      for (const [narrow, restore] of changes) {
        await grant(engine, clientId, narrow);
        await expect(authorizeStoredRequest(engine, receipt)).rejects.toMatchObject(denied);
        await grant(engine, clientId, restore);
        await authorizeStoredRequest(engine, receipt);
      }
    }
  });

  test('explicit prefix grants keep intersecting and never gain a job tree', async () => {
    for (const engine of engines) {
      const clientId = await delegatedClient(engine, 'prefixes', ['notes/delegated/*']);
      const ctx = delegatedCtx(engine, clientId, { allowedSlugPrefixes: ['notes/delegated/*'] });
      const request_id = randomUUID();
      expect((await write(ctx, 'notes/delegated/report', request_id)).state).toBe('committed');
      await expect(write(ctx, `wiki/agents/${JOB}/report`)).rejects.toMatchObject(denied);
      const receipt = (await getWriteRequest(engine, ctx.auth!.principal!, request_id))!;
      await authorizeStoredRequest(engine, receipt);
      await grant(engine, clientId, "delegated_slug_prefixes=ARRAY['notes/elsewhere/*']");
      await expect(authorizeStoredRequest(engine, receipt)).rejects.toMatchObject(denied);
      await grant(engine, clientId, "delegated_slug_prefixes=ARRAY['notes/*']");
      await authorizeStoredRequest(engine, receipt);
      await expect(authorizeStoredRequest(engine, { ...receipt, slug: 'notes/report' })).rejects.toMatchObject(denied);
      await grant(engine, clientId, "delegated_namespace='job', delegated_slug_prefixes=NULL");
      await expect(authorizeStoredRequest(engine, receipt)).rejects.toMatchObject(denied);
    }
  });
});
