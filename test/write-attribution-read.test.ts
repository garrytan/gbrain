/**
 * Foundations 1, F1b (spec 2.6-2.8, tests 12-14): write attribution read
 * exposure and the journal-proven backfill.
 *
 * Runs on PGLite, or on an isolated Postgres database when DATABASE_URL is set
 * (`test/e2e/write-attribution-read-parity.test.ts`, which the E2E backend
 * matrix also runs through transaction-mode PgBouncer).
 *
 * Lane F1a owns the attribution columns and triggers. Until it merges, the
 * test-only helper adds the columns (no triggers), so these tests stamp
 * attribution with plain SQL where F1a's triggers would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { attributionBackfillRepair } from '../src/core/repair/attribution-backfill.ts';
import { copyMigrationFacts, copyMigrationSources } from '../src/commands/migrate-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

let engine: BrainEngine;
let close: () => Promise<void>;
const logger = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engine = pg.engine; close = pg.close;
  } else {
    const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema();
    engine = pglite; close = () => pglite.disconnect();
  }
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await close();
}, 60_000);

async function newSource(prefix: string): Promise<string> {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  return id;
}

function local(sourceId: string): OperationContext {
  return { engine, sourceId, remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true }, logger };
}

function remote(sourceId: string, scopes: string[]): OperationContext {
  return { engine, sourceId, remote: true, transport: 'http', dryRun: false, config: { engine: engine.kind, embedding_disabled: true }, logger,
    auth: { token: 'synthetic', clientId: 'client-example', scopes, sourceId } } as OperationContext;
}

const ATTRIBUTION_KEY = /write|archived|principal|written_by|archived_by/;

/**
 * Make a source's rows look written before attribution existed. With lane
 * F1a's stamping triggers present, journaled writes are attributed at write
 * time and attribution is immutable once set, so only a trigger-bypassing
 * session (test setup only) can recreate pre-attribution rows.
 */
async function rawAttributionWrite(sql: string, params: unknown[]) {
  await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.executeRaw(sql, params);
  });
}

async function asPreAttributionRows(sourceId: string) {
  await rawAttributionWrite(`UPDATE pages SET revision_write_request_id=NULL, revision_principal_kind=NULL, revision_principal_id=NULL
    WHERE source_id=$1`, [sourceId]);
  await rawAttributionWrite(`UPDATE page_versions SET write_request_id=NULL, write_principal_kind=NULL, write_principal_id=NULL,
      archived_write_request_id=NULL, archived_principal_kind=NULL, archived_principal_id=NULL
    WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)`, [sourceId]);
  await rawAttributionWrite(`UPDATE facts SET write_request_id=NULL, write_principal_kind=NULL, write_principal_id=NULL,
      last_write_request_id=NULL, last_write_principal_kind=NULL, last_write_principal_id=NULL, last_written_at=NULL
    WHERE source_id=$1`, [sourceId]);
}

async function seedNames() {
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id, client_name) VALUES('client-example', 'agent-example') ON CONFLICT DO NOTHING`);
  const [token] = await engine.executeRaw<{ id: string }>(
    `INSERT INTO access_tokens(name, token_hash) VALUES('legacy-example', $1) RETURNING id::text AS id`, [`hash-${randomUUID()}`]);
  return token.id;
}

describe('read exposure (spec 2.7, test 12)', () => {
  let sourceA: string;
  let sourceB: string;
  let tokenId: string;
  const requestA = randomUUID();
  const requestB = randomUUID();

  beforeAll(async () => {
    sourceA = await newSource('attr-a'); sourceB = await newSource('attr-b');
    tokenId = await seedNames();
    for (const sourceId of [sourceA, sourceB]) {
      await engine.putPage('notes/shared', { type: 'note', title: 'Shared', compiled_truth: 'First body.', frontmatter: { visibility: 'world' } }, { sourceId });
      await engine.createVersion('notes/shared', { sourceId });
      await engine.putPage('notes/shared', { type: 'note', title: 'Shared', compiled_truth: 'Second body.', frontmatter: { visibility: 'world' } }, { sourceId });
    }
    await engine.executeRaw(`UPDATE page_versions SET write_request_id=$1, write_principal_kind='oauth_client', write_principal_id='client-example',
        archived_write_request_id=$2, archived_principal_kind='legacy_token', archived_principal_id=$3
      WHERE page_id=(SELECT id FROM pages WHERE source_id=$4 AND slug='notes/shared')`, [requestA, requestB, tokenId, sourceA]);
    await engine.executeRaw(`UPDATE pages SET revision_write_request_id=$1, revision_principal_kind='legacy_token', revision_principal_id=$2
      WHERE source_id=$3 AND slug='notes/shared'`, [requestB, tokenId, sourceA]);
  });

  test('get_versions without admin returns no attribution fields; admin and trusted local callers get resolved writers', async () => {
    const plain = await operationsByName.get_versions.handler(remote(sourceA, ['read', 'write']), { slug: 'notes/shared' }) as Record<string, unknown>[];
    expect(plain).toHaveLength(1);
    expect(Object.keys(plain[0]).filter(key => ATTRIBUTION_KEY.test(key))).toEqual([]);

    for (const ctx of [remote(sourceA, ['admin']), local(sourceA)]) {
      const [version] = await operationsByName.get_versions.handler(ctx, { slug: 'notes/shared' }) as Record<string, any>[];
      expect(version.write_principal_id).toBeUndefined();
      expect(version.written_by).toEqual({ request_id: requestA, operation: null, at: null, origin: 'request',
        principal: { kind: 'oauth_client', id: 'client-example', name: 'agent-example' } });
      expect(version.archived_by).toMatchObject({ request_id: requestB, origin: 'request',
        principal: { kind: 'legacy_token', id: tokenId, name: 'legacy-example' } });
      expect(version.archived_by.at).toBe(new Date(version.snapshot_at).toISOString());
    }
  });

  test('a pre-attribution version reads as unrecorded', async () => {
    const [version] = await operationsByName.get_versions.handler(local(sourceB), { slug: 'notes/shared' }) as Record<string, any>[];
    expect(version.written_by).toEqual({ request_id: null, operation: null, principal: null, at: null, origin: 'unrecorded' });
    expect(version.archived_by.origin).toBe('unrecorded');
  });

  test('get_write_attribution is an admin op and stays inside the caller grant', async () => {
    const op = operationsByName.get_write_attribution;
    expect(op.scope).toBe('admin');
    expect(op.localOnly).toBe(false);
    expect(op.cliHints?.name).toBe('attribution');

    const inGrant = await op.handler(remote(sourceA, ['admin']), { slug: 'notes/shared', versions: true }) as Record<string, any>;
    expect(inGrant.target).toMatchObject({ kind: 'page', slug: 'notes/shared', source_id: sourceA });
    expect(inGrant.created.principal).toEqual({ kind: 'oauth_client', id: 'client-example', name: 'agent-example' });
    expect(inGrant.last.principal).toEqual({ kind: 'legacy_token', id: tokenId, name: 'legacy-example' });
    expect(inGrant.live_revision.written_by.request_id).toBe(requestB);
    expect(inGrant.versions).toHaveLength(1);
    expect(inGrant.versions[0].written_by.request_id).toBe(requestA);

    const otherSource = await op.handler(remote(sourceB, ['admin']), { slug: 'notes/shared' }) as Record<string, any>;
    expect(otherSource.target.source_id).toBe(sourceB);
    expect(otherSource.created.origin).toBe('unrecorded');

    const outside = { ...remote(sourceB, ['admin']), auth: { token: 't', clientId: 'client-example', scopes: ['admin'], sourceId: sourceB, allowedSources: [sourceB] } } as OperationContext;
    const page = await engine.putPage('notes/only-a', { type: 'note', title: 'Only A', compiled_truth: 'A only.', frontmatter: { visibility: 'world' } }, { sourceId: sourceA });
    expect(page.id).toBeGreaterThan(0);
    await expect(op.handler(outside, { slug: 'notes/only-a' })).rejects.toMatchObject({ code: 'page_not_found' });
  });

  test('row targets: remote admins see world facts and allowed take holders only; local sees every row', async () => {
    const op = operationsByName.get_write_attribution;
    const [page] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id=$1 AND slug='notes/shared'`, [sourceA]);
    const facts = await engine.executeRaw<{ id: number; visibility: string }>(
      `INSERT INTO facts(source_id, entity_slug, fact, visibility, source, write_request_id, write_principal_kind, write_principal_id,
                         last_write_principal_kind, last_write_principal_id, last_written_at)
       VALUES ($1,'notes/shared','World fact.','world','test',$2,'oauth_client','client-example','local_cli','writer-example','2026-01-02T03:04:05Z'),
              ($1,'notes/shared','Private fact.','private','test',NULL,NULL,NULL,NULL,NULL,NULL)
       RETURNING id, visibility`, [sourceA, requestA]);
    const world = facts.find(f => f.visibility === 'world')!.id;
    const hidden = facts.find(f => f.visibility === 'private')!.id;

    const fact = await op.handler(remote(sourceA, ['admin']), { slug: 'notes/shared', fact: world }) as Record<string, any>;
    expect(fact.target).toMatchObject({ kind: 'fact', id: Number(world), slug: 'notes/shared', source_id: sourceA });
    expect(fact.created).toMatchObject({ request_id: requestA, origin: 'request', principal: { kind: 'oauth_client', name: 'agent-example' } });
    expect(fact.last).toEqual({ request_id: null, operation: null, at: '2026-01-02T03:04:05.000Z', origin: 'maintenance',
      principal: { kind: 'local_cli', id: 'writer-example', name: null } });

    await expect(op.handler(remote(sourceA, ['admin']), { slug: 'notes/shared', fact: hidden })).rejects.toMatchObject({ code: 'fact_not_found' });
    const privateLocal = await op.handler(local(sourceA), { slug: 'notes/shared', fact: hidden }) as Record<string, any>;
    expect(privateLocal.created.origin).toBe('unrecorded');

    await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,write_principal_kind,write_principal_id)
      VALUES ($1,1,'World take.','take','world','application','host:example'),($1,2,'Owner take.','take','owner-example',NULL,NULL)`, [page.id]);
    const take = await op.handler(remote(sourceA, ['admin']), { slug: 'notes/shared', take: 1 }) as Record<string, any>;
    expect(take.target).toMatchObject({ kind: 'take', row_num: 1 });
    expect(take.created).toMatchObject({ origin: 'maintenance', principal: { kind: 'application', id: 'host:example', name: null } });
    await expect(op.handler(remote(sourceA, ['admin']), { slug: 'notes/shared', take: 2 })).rejects.toMatchObject({ code: 'not_found' });
    expect((await op.handler(local(sourceA), { slug: 'notes/shared', take: 2 }) as Record<string, any>).target.row_num).toBe(2);

    const [entry] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries(page_id,date,summary,write_request_id,write_principal_kind,write_principal_id)
      VALUES ($1,'2026-01-01','Met.',$2,'legacy_token',$3) RETURNING id`, [page.id, requestB, tokenId]);
    const timeline = await op.handler(remote(sourceA, ['admin']), { slug: 'notes/shared', timeline: entry.id }) as Record<string, any>;
    expect(timeline.created.principal.name).toBe('legacy-example');

    await expect(op.handler(local(sourceA), { slug: 'notes/shared', fact: world, take: 1 })).rejects.toBeInstanceOf(OperationError);
    await expect(op.handler(local(sourceA), { slug: 'notes/shared', fact: -1 })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('attribution-backfill (spec 2.6, test 13)', () => {
  test('fills only journal-proven NULLs, resumes after an interruption, is idempotent and leaves the rest NULL', async () => {
    const sourceId = await newSource('attr-fill');
    const ctx = local(sourceId);
    const put = async (slug: string, body: string) => {
      const requestId = randomUUID();
      const [current] = await engine.executeRaw<{ revision: string }>(
        'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      await operationsByName.put_page.handler(ctx, { slug, request_id: requestId, content: `---\ntype: note\ntitle: Alpha\n---\n${body}\n`,
        ...(current ? { expected_revision: current.revision } : {}) });
      return requestId;
    };
    const first = await put('notes/alpha', 'First body.');
    const second = await put('notes/alpha', 'Second body.');
    await engine.putPage('people/beta-example', { type: 'person', title: 'Beta Example', compiled_truth: 'Unjournaled page.' }, { sourceId });
    const rememberId = randomUUID();
    const remembered = await operationsByName.remember.handler(ctx, { fact: 'Beta likes tea.', provenance: 'test', entity: 'people/beta-example',
      request_id: rememberId }) as Record<string, any>;
    expect(remembered.status).toBe('inserted');
    const duplicate = await operationsByName.remember.handler(ctx, { fact: 'Beta likes tea.', provenance: 'test', entity: 'people/beta-example',
      request_id: randomUUID() }) as Record<string, any>;
    expect(duplicate.status).toBe('duplicate');
    await engine.putPage('notes/gamma', { type: 'note', title: 'Gamma', compiled_truth: 'Unjournaled gamma.' }, { sourceId });
    const gamma = await operationsByName.get_page.handler(ctx, { slug: 'notes/gamma', include_content: true }) as Record<string, any>;
    const [gammaRevision] = await engine.executeRaw<{ revision: string }>(
      `SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug='notes/gamma'`, [sourceId]);
    const unchanged = await operationsByName.put_page.handler(ctx, { slug: 'notes/gamma', request_id: randomUUID(), content: gamma.content,
      expected_revision: gammaRevision.revision }) as Record<string, any>;
    expect(unchanged.status).toBe('skipped');
    expect(unchanged.revision).toBe(gammaRevision.revision);
    const [orphan] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts(source_id, entity_slug, fact, visibility, source) VALUES ($1,'people/beta-example','Unjournaled fact.','world','test') RETURNING id`, [sourceId]);

    const journal = async (requestId: string) => (await engine.executeRaw<{ id: string; principal_kind: string; principal_id: string }>(
      'SELECT id::text AS id, principal_kind, principal_id FROM persistence_requests WHERE request_id=$1', [requestId]))[0];
    const [r1, r2, r3] = [await journal(first), await journal(second), await journal(rememberId)];
    expect(r1.principal_kind).toBe('local_cli');
    const alpha = async () => (await engine.executeRaw<Record<string, string | null>>(
      `SELECT revision_write_request_id::text AS req, revision_principal_kind AS kind, revision_principal_id AS pid FROM pages WHERE source_id=$1 AND slug='notes/alpha'`, [sourceId]))[0];
    const versions = async () => engine.executeRaw<Record<string, string | null>>(
      `SELECT pv.write_request_id::text AS req, pv.write_principal_kind AS kind FROM page_versions pv JOIN pages p ON p.id=pv.page_id
        WHERE p.source_id=$1 AND p.slug='notes/alpha' ORDER BY pv.id`, [sourceId]);
    const fact = async (id: number | string) => (await engine.executeRaw<Record<string, string | null>>(
      'SELECT write_request_id::text AS req, write_principal_kind AS kind, last_write_request_id::text AS last FROM facts WHERE id=$1', [id]))[0];
    const revisionOf = async (slug: string) => (await engine.executeRaw<Record<string, string | null>>(
      'SELECT revision_write_request_id::text AS req, revision_principal_kind AS kind FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];

    await asPreAttributionRows(sourceId);
    const scope = await resolveRepairScope(engine, sourceId);
    const preview = await runRepair(ctx, attributionBackfillRepair, scope, { apply: false });
    expect(preview.mode).toBe('dry_run');
    expect(preview.sample.map(s => s.split(':')[1].split('#')[0])).toEqual(['pages', 'page_versions', 'facts']);
    expect(preview.residuals).toEqual({ unrecorded_pages: 1, unrecorded_page_versions: 1, unrecorded_facts: 1 });
    expect(await alpha()).toEqual({ req: null, kind: null, pid: null });

    const interrupted = await runRepair(ctx, attributionBackfillRepair, scope, { apply: true, limit: 1 });
    expect(interrupted).toMatchObject({ applied: 1, complete: false });
    expect(await alpha()).toEqual({ req: r2.id, kind: 'local_cli', pid: r2.principal_id });
    expect((await versions())[0].req).toBeNull();

    const resumed = await runRepair(ctx, attributionBackfillRepair, scope, { apply: true });
    expect(resumed.resumed_from).toEqual({ phase: 0, id: expect.any(Number) });
    expect(resumed).toMatchObject({ applied: 2, complete: true });
    expect(await versions()).toEqual([{ req: r1.id, kind: 'local_cli' }]);
    expect(await fact(remembered.id)).toEqual({ req: r3.id, kind: 'local_cli', last: null });
    expect(await fact(orphan.id)).toEqual({ req: null, kind: null, last: null });
    // The fenced remember wrote the entity page's live revision; the duplicate only observed it and proves nothing.
    expect(await revisionOf('people/beta-example')).toEqual({ req: r3.id, kind: 'local_cli' });
    // A skipped put_page reports the unjournaled page's revision without writing it: still unrecorded.
    expect(await revisionOf('notes/gamma')).toEqual({ req: null, kind: null });

    const again = await runRepair(ctx, attributionBackfillRepair, scope, { apply: true });
    expect(again).toMatchObject({ affected: 0, applied: 0, complete: true, resumed_from: null });
    expect(await alpha()).toEqual({ req: r2.id, kind: 'local_cli', pid: r2.principal_id });

    await rawAttributionWrite(`UPDATE pages SET revision_write_request_id=NULL, revision_principal_kind='oauth_client', revision_principal_id='client-example'
      WHERE source_id=$1 AND slug='notes/alpha'`, [sourceId]);
    await runRepair(ctx, attributionBackfillRepair, scope, { apply: true });
    expect(await alpha()).toEqual({ req: null, kind: 'oauth_client', pid: 'client-example' });
  });

  test('is a registered bookkeeping kind that --all runs', async () => {
    const { repairSpec, AUTO_REPAIR_REGISTRY } = await import('../src/core/repair/registry.ts');
    expect(repairSpec('attribution-backfill')).toMatchObject({ embeds: 'none', checks: [] });
    expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('attribution-backfill');
  });
});

describe('engine copy (test 14)', () => {
  let target: PGLiteEngine;
  beforeAll(async () => {
    target = new PGLiteEngine(); await target.connect({}); await target.initSchema();
  }, 120_000);
  afterAll(async () => { await target.disconnect(); });

  test('foresights migrate --to copies fact attribution verbatim', async () => {
    const sourceId = await newSource('attr-copy');
    const requestId = randomUUID();
    await engine.executeRaw(`INSERT INTO facts(source_id, entity_slug, fact, visibility, source, write_request_id, write_principal_kind, write_principal_id,
        last_write_request_id, last_write_principal_kind, last_write_principal_id, last_written_at)
      VALUES ($1,'people/copy-example','Copied fact.','world','test',$2,'oauth_client','client-example',$2,'legacy_token','token-example','2026-02-03T04:05:06Z')`,
    [sourceId, requestId]);
    await copyMigrationSources(engine, target);
    const result = await copyMigrationFacts(engine, target);
    expect(result.failed).toEqual([]);
    const select = `SELECT write_request_id::text AS w, write_principal_kind AS wk, write_principal_id AS wi, last_write_request_id::text AS l,
      last_write_principal_kind AS lk, last_write_principal_id AS li, last_written_at FROM facts WHERE source_id=$1`;
    const [copied] = await target.executeRaw<Record<string, unknown>>(select, [sourceId]);
    const [original] = await engine.executeRaw<Record<string, unknown>>(select, [sourceId]);
    expect({ ...copied, last_written_at: new Date(copied.last_written_at as string).toISOString() })
      .toEqual({ ...original, last_written_at: new Date(original.last_written_at as string).toISOString() });
    expect(copied.w).toBe(requestId);
  });
});
