import { afterAll, beforeAll, expect, test } from 'bun:test';
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
