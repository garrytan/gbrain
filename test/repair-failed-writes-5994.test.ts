/**
 * #5994: `gbrain repair failed-writes` replays subagent and restricted-namespace
 * writes under their stored identity and authority, while the global subagent
 * fence stays fail-closed for every live dispatch. Runs on PGLite and, through
 * test/e2e, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { enforceSubagentSlugFence } from '../src/core/ops/context.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import type { WriteAuthority, WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../src/core/persistence/writer-guard-schema.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installPre5983Guard } from './helpers/pre-5983-guard.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5994-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const logger = { info() {}, warn() {}, error() {} };
const JOB = 4107;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    for (const table of ['tags', 'timeline_entries', 'takes']) await engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_id TEXT`);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

/** Tagged content, so the pre-#5983 guard refuses its publication and leaves a failed receipt. */
const page = (title: string) => `---\ntitle: ${title}\ntype: note\ntags: [example]\n---\n${title} body.`;

interface Brain { engine: BrainEngine; sourceId: string; local: OperationContext; remote: OperationContext }

async function brain(run: (b: Brain) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5994-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `r5994-${randomUUID().slice(0, 8)}`;
    const local = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run({ engine, sourceId, local, remote: { ...local, remote: true } });
      });
    } finally {
      installFaultHook(undefined);
      await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await disposePersistenceConsumer(engine);
    }
  }
}

/** Submit under the pre-#5983 guard, restore the guard, and return the failed receipt. */
async function failedWrite(b: Brain, ctx: OperationContext, slug: string): Promise<WriteRequest> {
  await installPre5983Guard(b.engine);
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug), request_id: randomUUID() } }).catch(() => undefined);
  await b.engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
  const [row] = await b.engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='failed'
    AND error_code='writer_coordinator_required'`, [b.sourceId, slug]);
  expect(row).toBeDefined();
  return row;
}

async function replay(b: Brain) {
  const scope = await resolveRepairScope(b.engine, b.sourceId);
  const preview = await (await repairRunner(b.engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: b.sourceId });
  return (await repairRunner(b.engine, { apply: true, logger })).run('failed-writes', scope,
    { explicit: true, sourceFlag: b.sourceId, expect: preview.apply_command.split('--expect ')[1] });
}

const committedReplay = async (b: Brain, slug: string) => (await b.engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests
  WHERE source_id=$1 AND slug=$2 AND state='committed' ORDER BY sequence DESC LIMIT 1`, [b.sourceId, slug]))[0];

async function delegatedClient(b: Brain): Promise<OperationContext> {
  const clientId = `delegated-job-${randomUUID()}`;
  await b.engine.executeRaw(`INSERT INTO oauth_clients (client_id,client_name,client_secret_hash,scope,source_id,bound_source_id,
    federated_read,bound_tools,delegated_namespace,delegated_slug_prefixes)
    VALUES($1,'example-delegate','fixture-hash','read agent',$2,$2,ARRAY[$2]::text[],ARRAY['mcp__gbrain__put_page'],'job',NULL)`, [clientId, b.sourceId]);
  return { ...b.remote, viaSubagent: true, subagentId: JOB,
    auth: { token: 'fixture-token', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'agent'], sourceId: b.sourceId } } as OperationContext;
}

describe('#5994 failed-writes replays subagent writes under their stored identity', () => {
  test('a restricted-namespace write with an allow-list and no recorded job replays inside that list', async () => {
    await brain(async b => {
      const failed = await failedWrite(b, { ...b.remote, viaSubagent: true, subagentId: 7, allowedSlugPrefixes: ['wiki/personal/*'] }, 'wiki/personal/note-a');
      expect(failed.authority).toMatchObject({ restrictedNamespace: true, delegatedPrefixes: ['wiki/personal/*'] });
      expect((await replay(b)).outcomes).toEqual({ replayed: 1 });
      expect(await b.engine.getTags('wiki/personal/note-a', { sourceId: b.sourceId })).toEqual(['example']);
      const replayed = await committedReplay(b, 'wiki/personal/note-a');
      expect(replayed.authority).toMatchObject({ restrictedNamespace: true, delegatedPrefixes: ['wiki/personal/*'], remote: true });
      expect({ kind: replayed.principal_kind, id: replayed.principal_id }).toEqual({ kind: failed.principal_kind, id: failed.principal_id });
    });
  }, 120_000);

  test('a legacy subagent write (job id only) replays on its own wiki/agents/<id>/ path, still sandboxed', async () => {
    await brain(async b => {
      const failed = await failedWrite(b, { ...b.remote, viaSubagent: true, subagentId: 9 }, 'wiki/agents/9/notes');
      expect(failed.authority).toMatchObject({ restrictedNamespace: true, delegatedPrefixes: ['wiki/agents/9/*'], databaseOnlyReason: 'subagent_sandbox' });
      expect((await replay(b)).outcomes).toEqual({ replayed: 1 });
      expect((await committedReplay(b, 'wiki/agents/9/notes')).authority).toMatchObject({ databaseOnlyReason: 'subagent_sandbox', delegatedPrefixes: ['wiki/agents/9/*'] });
    });
  }, 120_000);

  test('an OAuth-delegated job write replays under the original client and delegation, not local authority', async () => {
    await brain(async b => {
      const failed = await failedWrite(b, await delegatedClient(b), `wiki/agents/${JOB}/summary`);
      expect(failed.authority).toMatchObject({ delegated: true, delegatedJobId: JOB });
      expect((await replay(b)).outcomes).toEqual({ replayed: 1 });
      const replayed = await committedReplay(b, `wiki/agents/${JOB}/summary`);
      expect(replayed.principal_kind).toBe('oauth_client');
      expect(replayed.authority).toMatchObject({ principal: failed.authority.principal, delegated: true, delegatedJobId: JOB, scopes: ['read', 'agent'],
        autoLinkTrusted: failed.authority.autoLinkTrusted });
    });
  }, 120_000);

  test('a revoked or narrowed grant refuses the replay before admission', async () => {
    await brain(async b => {
      const ctx = await delegatedClient(b);
      await failedWrite(b, ctx, `wiki/agents/${JOB}/plan`);
      await b.engine.executeRaw("UPDATE oauth_clients SET bound_tools=ARRAY['mcp__gbrain__get_page'] WHERE client_id=$1", [ctx.auth!.clientId]);
      expect((await replay(b)).outcomes).toEqual({ authority_revoked: 1 });
      await b.engine.executeRaw("UPDATE oauth_clients SET bound_tools=ARRAY['mcp__gbrain__put_page'], deleted_at=now() WHERE client_id=$1", [ctx.auth!.clientId]);
      expect((await replay(b)).outcomes).toEqual({ authority_revoked: 1 });
      expect(await b.engine.getPage(`wiki/agents/${JOB}/plan`, { sourceId: b.sourceId })).toBeNull();
    });
  }, 120_000);

  test('a grant narrowed after replay admission, before publication, refuses at publication', async () => {
    await brain(async b => {
      const ctx = await delegatedClient(b);
      await failedWrite(b, ctx, `wiki/agents/${JOB}/late`);
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'put_page') return;
        installFaultHook(undefined);
        await b.engine.executeRaw("UPDATE oauth_clients SET delegated_namespace='prefixes', delegated_slug_prefixes=ARRAY['notes/*'] WHERE client_id=$1", [ctx.auth!.clientId]);
      });
      const applied = await replay(b);
      expect(applied.outcomes).toEqual({ refused: 1 });
      expect(applied.outcome_items?.[0]?.reason).toMatch(/^permission_denied/);
      // The replay was admitted under the original client and refused by publication's live re-check.
      const attempts = await b.engine.executeRaw<{ state: string; principal_kind: string }>(`SELECT state, principal_kind FROM persistence_requests
        WHERE source_id=$1 AND slug=$2 ORDER BY sequence`, [b.sourceId, `wiki/agents/${JOB}/late`]);
      expect(attempts).toEqual([{ state: 'failed', principal_kind: 'oauth_client' }, { state: 'failed', principal_kind: 'oauth_client' }]);
      expect(await b.engine.getPage(`wiki/agents/${JOB}/late`, { sourceId: b.sourceId })).toBeNull();
    });
  }, 120_000);
});

describe('#5994 the replay marker is narrow', () => {
  const stored = (over: Partial<WriteAuthority> = {}): WriteAuthority => ({ version: 1, principal: { kind: 'local_stdio', id: randomUUID() }, remote: true,
    sourceId: 'default', sourceIncarnation: 'inc-1', scopes: ['write'], operations: null, slugPrefixes: null,
    restrictedNamespace: true, delegatedPrefixes: ['wiki/personal/*'], ...over });
  const fenced = (ctx: Partial<OperationContext>, slug: string) => () => enforceSubagentSlugFence(ctx as OperationContext, slug, 'put_page');

  test('a live dispatch with viaSubagent and no subagentId still fails closed, with or without an allow-list', () => {
    expect(fenced({ viaSubagent: true }, 'wiki/agents/1/x')).toThrow(/requires ctx.subagentId/);
    expect(fenced({ viaSubagent: true, allowedSlugPrefixes: ['wiki/personal/*'] }, 'wiki/personal/x')).toThrow(/requires ctx.subagentId/);
  });

  test('the replay marker passes only its exact non-empty stored list, and the slug must match it', () => {
    const replay = { viaSubagent: true, allowedSlugPrefixes: ['wiki/personal/*'], replayAuthority: stored() };
    expect(fenced(replay, 'wiki/personal/x')).not.toThrow();
    expect(fenced(replay, 'notes/elsewhere')).toThrow(/not within the trusted-workspace allow-list/);
    expect(fenced({ ...replay, allowedSlugPrefixes: ['notes/*'] }, 'notes/x')).toThrow(/requires ctx.subagentId/);
    expect(fenced({ viaSubagent: true, allowedSlugPrefixes: [], replayAuthority: stored({ delegatedPrefixes: [] }) }, 'wiki/personal/x')).toThrow(/requires ctx.subagentId/);
    expect(fenced({ ...replay, replayAuthority: stored({ restrictedNamespace: false }) }, 'wiki/personal/x')).toThrow(/requires ctx.subagentId/);
  });

  test('a replayed authority refuses a reincarnated source and a resolved slug outside its namespace', async () => {
    await brain(async b => {
      const [{ incarnation }] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [b.sourceId]);
      const failed = await failedWrite(b, { ...b.remote, viaSubagent: true, subagentId: 7, allowedSlugPrefixes: ['wiki/personal/*'] }, 'wiki/personal/note-b');
      const ctx = { ...b.remote, replayAuthority: failed.authority } as OperationContext;
      await expect(submissionAuthority(ctx, 'put_page', b.sourceId, randomUUID(), 'wiki/personal/note-b')).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(submissionAuthority(ctx, 'put_page', b.sourceId, incarnation, 'notes/resolved-elsewhere')).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(submissionAuthority(ctx, 'put_page', b.sourceId, incarnation, 'wiki/personal/note-b')).resolves.toMatchObject({ restrictedNamespace: true });
    });
  }, 120_000);
});
