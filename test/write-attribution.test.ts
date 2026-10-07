/**
 * Foundations 1 (F1a) write attribution: the coordinator's actor reaches every
 * content row and page revision through BEFORE ROW triggers.
 *
 * Protects: who wrote each page_versions row, live page revision, fact, take
 * and timeline row (created_by and last_mutated_by), on a managed brain, for
 * journaled requests (OAuth client, legacy token, local CLI) and for
 * coordinated maintenance with no request. Fails if the coordinator stops
 * passing its request to withCoordinatedWrite, if a trigger is missing or
 * misclassifies a column, or if the managed guard refuses an attribution-only
 * update. Runs on PGLite, and on Postgres (direct and transaction-mode
 * PgBouncer) through test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { localHostId, registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { getWriteRequest } from '../src/core/persistence/journal.ts';
import { submitRememberMutation, submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { replaceDerivedFactsForPage } from '../src/core/persistence/derived-facts.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { maintenanceAttribution, withWriteAttribution, type WriteAttribution } from '../src/core/persistence/attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { runManagedStaleExtraction } from '../src/core/persistence/links-maintenance.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import {
  ROW_ATTRIBUTION_COLUMNS, WRITE_ATTRIBUTION_CONTENT_COLUMNS, WRITE_ATTRIBUTION_PROJECTION_COLUMNS, type AttributedTable,
} from '../src/core/persistence/attribution-schema.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain {
  engine: BrainEngine; sourceId: string; startedAt: string;
  oauth: OperationContext; token: OperationContext; local: OperationContext;
  principals: { oauth: Principal; token: Principal; local: Principal };
}
/** A managed brain with a database-only source and three principals that can write it. */
/** `embedding`: the supersession case needs fact vectors, so its brain must not opt out of embedding (no embedder call otherwise). */
async function managedBrain(engine: BrainEngine, opts: { embedding?: boolean } = {}): Promise<Brain> {
  const sourceId = `attr-${randomUUID().slice(0, 8)}`;
  // Each brain's consumer starts under this brain's config, not an earlier test's (the consumer keeps its first config).
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  const clientId = `client-${sourceId}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
    VALUES($1,'fixture-hash','example-client','read write',$2)`, [clientId, sourceId]);
  const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const principals = {
    oauth: { kind: 'oauth_client', id: clientId } as Principal,
    token: { kind: 'legacy_token', id: minted.id } as Principal,
    local: { kind: 'local_cli', id: (await readLocalWriter(engine, 'cli')).id } as Principal,
  };
  const base = { engine, config: { engine: engine.kind, embedding_disabled: !opts.embedding }, sourceId, dryRun: false, logger: quiet };
  const [{ now }] = await engine.executeRaw<{ now: string }>('SELECT now()::text AS now');
  return {
    engine, sourceId, startedAt: now, principals,
    oauth: { ...base, remote: true, transport: 'http',
      auth: { token: 'fixture', clientId, principal: principals.oauth, scopes: ['read', 'write'], sourceId } },
    token: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: principals.token, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
async function run(ctx: OperationContext, operation: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  try { return await operationsByName[operation].handler(ctx, { request_id: randomUUID(), ...params }) as Record<string, any>; }
  catch (error) { throw Object.assign(error as Error, { message: `${operation}: ${(error as Error).message}` }); }
}
/** persistence_requests.id of a receipt: attribution names the journal row, not the caller's request_id. */
async function requestRow(brain: Brain, ctx: OperationContext, receipt: Record<string, unknown>): Promise<string> {
  const principal = ctx.auth?.principal ?? brain.principals.local;
  return (await getWriteRequest(brain.engine, principal, String(receipt.request_id)))!.id;
}
const actor = (requestId: string | null, principal: Principal) => ({ request: requestId, kind: principal.kind, id: principal.id });
async function pageRevisionActor(brain: Brain, slug: string) {
  const [row] = await brain.engine.executeRaw<{ request: string | null; kind: string | null; id: string | null; revision: string }>(
    `SELECT revision_write_request_id::text AS request,revision_principal_kind AS kind,revision_principal_id AS id,knowledge_revision::text AS revision
       FROM pages WHERE source_id=$1 AND slug=$2`, [brain.sourceId, slug]);
  return row;
}
async function versions(brain: Brain, slug: string) {
  return brain.engine.executeRaw<{ id: number; revision: string; write: Record<string, string | null>; archived: Record<string, string | null> }>(
    `SELECT v.id,v.knowledge_revision::text AS revision,
       jsonb_build_object('request',v.write_request_id::text,'kind',v.write_principal_kind,'id',v.write_principal_id) AS write,
       jsonb_build_object('request',v.archived_write_request_id::text,'kind',v.archived_principal_kind,'id',v.archived_principal_id) AS archived
     FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id`, [brain.sourceId, slug]);
}
const ROW_COLUMNS = `write_request_id::text AS created_request,write_principal_kind AS created_kind,write_principal_id AS created_id,
  last_write_request_id::text AS last_request,last_write_principal_kind AS last_kind,last_write_principal_id AS last_id,last_written_at`;
type RowActors = { created_request: string | null; created_kind: string | null; created_id: string | null;
  last_request: string | null; last_kind: string | null; last_id: string | null; last_written_at: unknown };
const created = (row: RowActors) => ({ request: row.created_request, kind: row.created_kind, id: row.created_id });
const last = (row: RowActors) => ({ request: row.last_request, kind: row.last_kind, id: row.last_id });
async function fact(brain: Brain, id: unknown) {
  return (await brain.engine.executeRaw<RowActors & { expired_at: unknown }>(`SELECT ${ROW_COLUMNS},expired_at FROM facts WHERE id=$1`, [Number(id)]))[0];
}
const FIXED_EMBEDDING = (async (opts: { values: string[] }) => ({ embeddings: opts.values.map(() => [1, ...new Array(1535).fill(0)]) })) as never;
async function withFixedEmbeddings(fn: () => Promise<void>) {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-attribution' } });
  __setEmbedTransportForTests(FIXED_EMBEDDING);
  try { await fn(); }
  finally { __setEmbedTransportForTests(null); configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} }); }
}
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

describe('write attribution on a managed brain', () => {
  test('two HTTP principals editing one page: every version row and the live revision name their request', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      const slug = 'notes/shared-example';
      const createdBy = await run(brain.oauth, 'put_page', { slug, content: page('Shared', 'First line') });
      const editedBy = await run(brain.token, 'edit_page', { slug, expected_revision: createdBy.revision, edits: [{ old_text: 'First line', new_text: 'Second line' }] });
      const reEditedBy = await run(brain.oauth, 'edit_page', { slug, expected_revision: editedBy.revision, edits: [{ old_text: 'Second line', new_text: 'Third line' }] });
      const r1 = actor(await requestRow(brain, brain.oauth, createdBy), brain.principals.oauth);
      const r2 = actor(await requestRow(brain, brain.token, editedBy), brain.principals.token);
      const r3 = actor(await requestRow(brain, brain.oauth, reEditedBy), brain.principals.oauth);
      expect(await versions(brain, slug)).toMatchObject([
        { revision: createdBy.revision, write: r1, archived: r2 },
        { revision: editedBy.revision, write: r2, archived: r3 },
      ]);
      expect(await pageRevisionActor(brain, slug)).toEqual({ ...r3, revision: reEditedBy.revision });
    }
  }, 120_000);

  test('A creates, B replaces, C replaces, C reverts: attribution matches the bytes and revision of each version', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      const slug = 'notes/revert-chain-example';
      const a = await run(brain.oauth, 'put_page', { slug, content: page('Chain', 'Version one') });
      const b = await run(brain.token, 'put_page', { slug, content: page('Chain', 'Version two'), expected_revision: a.revision });
      const c = await run(brain.local, 'put_page', { slug, content: page('Chain', 'Version three'), expected_revision: b.revision });
      const [v1] = await versions(brain, slug);
      const revert = await run(brain.local, 'revert_version', { slug, version_id: v1.id, expected_revision: c.revision });
      const ra = actor(await requestRow(brain, brain.oauth, a), brain.principals.oauth);
      const rb = actor(await requestRow(brain, brain.token, b), brain.principals.token);
      const rc = actor(await requestRow(brain, brain.local, c), brain.principals.local);
      const rr = actor(await requestRow(brain, brain.local, revert), brain.principals.local);
      const rows = await versions(brain, slug);
      expect(rows).toMatchObject([
        { revision: a.revision, write: ra, archived: rb },
        { revision: b.revision, write: rb, archived: rc },
        { revision: c.revision, write: rc, archived: rr },
      ]);
      const bytes = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM page_versions WHERE id=ANY($1::int[]) ORDER BY id', [rows.map(row => row.id)]);
      expect(bytes.map(row => row.compiled_truth.trim())).toEqual(['Version one', 'Version two', 'Version three']);
      const live = await pageRevisionActor(brain, slug);
      expect(live).toEqual({ ...rr, revision: revert.revision });
      // Each version's revision is the outcome revision of the request that wrote it.
      for (const row of rows) {
        const [request] = await engine.executeRaw<{ revision: string }>("SELECT outcome->>'revision' AS revision FROM persistence_requests WHERE id=$1::uuid", [row.write.request]);
        expect(request.revision).toBe(row.revision);
      }
    }
  }, 120_000);

  test('remember from two principals, duplicate remember and supersession keep created_by and move last_mutated_by', async () => {
    await withFixedEmbeddings(async () => {
      for (const engine of engines) {
        const brain = await managedBrain(engine, { embedding: true });
        await run(brain.local, 'put_page', { slug: 'people/alice-example', content: page('Alice', 'Profile') });
        await run(brain.local, 'put_page', { slug: 'people/charlie-example', content: page('Charlie', 'Profile') });
        const byOauth = await submitRememberMutation(brain.oauth, { fact: 'Prefers written updates', provenance: 'test', entity: 'people/alice-example', request_id: randomUUID() }, 30_000);
        const byToken = await submitRememberMutation(brain.token, { fact: 'Runs the platform team', provenance: 'test', entity: 'people/charlie-example', request_id: randomUUID() }, 30_000);
        const oauthRequest = actor(await requestRow(brain, brain.oauth, byOauth), brain.principals.oauth);
        const tokenRequest = actor(await requestRow(brain, brain.token, byToken), brain.principals.token);
        const oauthFact = await fact(brain, byOauth.id);
        expect(created(oauthFact)).toEqual(oauthRequest);
        expect(last(oauthFact)).toEqual(oauthRequest);
        expect(oauthFact.last_written_at).not.toBeNull();
        expect(created(await fact(brain, byToken.id))).toEqual(tokenRequest);

        const duplicate = await submitRememberMutation(brain.token, { fact: 'Prefers written updates', provenance: 'test', entity: 'people/alice-example', request_id: randomUUID() }, 30_000);
        expect(duplicate).toMatchObject({ status: 'duplicate', id: byOauth.id });
        expect(await fact(brain, byOauth.id)).toEqual(oauthFact);

        const superseding = await submitRememberMutation(brain.token, { fact: 'Prefers written updates over calls', provenance: 'test', entity: 'people/alice-example', request_id: randomUUID() }, 30_000);
        expect(superseding.status).toBe('superseded');
        const supersedingRequest = actor(await requestRow(brain, brain.token, superseding), brain.principals.token);
        const old = await fact(brain, byOauth.id);
        expect(old.expired_at).not.toBeNull();
        expect(created(old)).toEqual(oauthRequest);
        expect(last(old)).toEqual(supersedingRequest);
        const next = await fact(brain, superseding.id);
        expect(created(next)).toEqual(supersedingRequest);
        expect(last(next)).toEqual(supersedingRequest);
      }
    });
  }, 120_000);

  test('forget stamps the forget request on the fact and on the withdrawal it records', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      await run(brain.local, 'put_page', { slug: 'people/alice-example', content: page('Alice', 'Profile') });
      const remembered = await submitRememberMutation(brain.oauth, { fact: 'Lives near the office', provenance: 'test', entity: 'people/alice-example', request_id: randomUUID() }, 30_000);
      const forgotten = await submitForgetMutation(brain.token, 'forget', { id: remembered.id, reason: 'asked to remove', request_id: randomUUID() });
      expect(forgotten.state ?? 'committed').toBe('committed');
      const forgetRequest = actor(await requestRow(brain, brain.token, forgotten), brain.principals.token);
      const row = await fact(brain, remembered.id);
      expect(row.expired_at).not.toBeNull();
      expect(created(row)).toEqual(actor(await requestRow(brain, brain.oauth, remembered), brain.principals.oauth));
      expect(last(row)).toEqual(forgetRequest);
      const effects = await engine.executeRaw<{ request_id: string | null }>("SELECT request_id::text FROM persistence_effects WHERE kind='withdrawal-mirror' AND source_id=$1", [brain.sourceId]);
      expect(effects.map(effect => effect.request_id)).toEqual([forgetRequest.request]);
    }
  }, 120_000);

  test('republishing an identical body keeps fence row attribution; editing one row moves only that row', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      const slug = 'notes/fenced-example';
      const facts = (confidence: number) => renderFactsTable([
        { rowNum: 1, claim: 'First fenced fact', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true },
        { rowNum: 2, claim: 'Second fenced fact', kind: 'fact', confidence, visibility: 'world', notability: 'medium', active: true },
      ] as never);
      const takes = renderTakesFence([{ rowNum: 1, claim: 'A fenced take', kind: 'take', holder: 'world', weight: 0.7, active: true }] as never);
      const body = (confidence: number, prose = 'Prose') => page('Fenced', `${prose}\n\n${facts(confidence)}\n\n${takes}\n\n<!-- timeline -->\n\n## Timeline\n- **2026-09-15** | manual — A fenced event`);
      const first = await run(brain.local, 'put_page', { slug, content: body(0.5) });
      const firstRequest = actor(await requestRow(brain, brain.local, first), brain.principals.local);
      const snapshot = async () => ({
        facts: await engine.executeRaw<RowActors & { row_num: number }>(`SELECT row_num,${ROW_COLUMNS} FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num`, [brain.sourceId, slug]),
        takes: await engine.executeRaw<RowActors>(`SELECT ${ROW_COLUMNS} FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY t.row_num`, [brain.sourceId, slug]),
        timeline: await engine.executeRaw<RowActors>(`SELECT ${ROW_COLUMNS} FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2`, [brain.sourceId, slug]),
      });
      const before = await snapshot();
      expect(before.facts).toHaveLength(2); expect(before.takes).toHaveLength(1); expect(before.timeline).toHaveLength(1);
      for (const row of [...before.facts, ...before.takes, ...before.timeline]) { expect(created(row)).toEqual(firstRequest); expect(last(row)).toEqual(firstRequest); }

      const second = await run(brain.token, 'put_page', { slug, content: body(0.5, 'Prose, revised'), expected_revision: first.revision });
      expect(await snapshot()).toEqual(before);

      const third = await run(brain.token, 'put_page', { slug, content: body(0.75, 'Prose, revised'), expected_revision: second.revision });
      const thirdRequest = actor(await requestRow(brain, brain.token, third), brain.principals.token);
      const after = await snapshot();
      expect(after.facts[0]).toEqual(before.facts[0]);
      expect(created(after.facts[1])).toEqual(firstRequest);
      expect(last(after.facts[1])).toEqual(thirdRequest);
      expect(after.takes).toEqual(before.takes);
      expect(after.timeline).toEqual(before.timeline);
    }
  }, 120_000);

  test('coordinated derived fact maintenance has no request and names the local writer', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      const slug = 'notes/derived-example';
      await run(brain.local, 'put_page', { slug, content: page('Derived', 'Conversation notes') });
      await replaceDerivedFactsForPage(engine, brain.sourceId, slug, { sourcePrefix: 'cli:extract-conversation-facts', isCurrent: async () => true,
        build: async () => [{ fact: 'Derived example claim', kind: 'fact', visibility: 'world', notability: 'medium',
          source: 'cli:extract-conversation-facts:test', entity_slug: slug, row_num: 1, source_markdown_slug: slug }] as never });
      const rows = await engine.executeRaw<RowActors>(`SELECT ${ROW_COLUMNS} FROM facts WHERE source_id=$1 AND fact='Derived example claim'`, [brain.sourceId]);
      expect(rows).toHaveLength(1);
      expect(created(rows[0])).toEqual(actor(null, brain.principals.local));
    }
  }, 120_000);

  test('attribution-only updates pass the managed guard and never bump the page revision', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      const slug = 'notes/backfill-example';
      const takes = renderTakesFence([{ rowNum: 1, claim: 'A take to backfill', kind: 'take', holder: 'world', weight: 0.5, active: true }] as never);
      await run(brain.local, 'put_page', { slug, content: page('Backfill', `Prose\n\n${takes}`) });
      const remembered = await submitRememberMutation(brain.local, { fact: 'Backfilled claim', provenance: 'test', entity: slug, request_id: randomUUID() }, 30_000);
      const before = (await engine.readPageSnapshot(slug, { sourceId: brain.sourceId }))!;
      const factBefore = await fact(brain, remembered.id);
      const revisionBefore = await pageRevisionActor(brain, slug);
      expect(revisionBefore.kind).toBe('local_cli');
      // A journal backfill writes attribution columns only, without the coordinator capability.
      await engine.executeRaw(`UPDATE facts SET write_principal_kind='application',write_principal_id='backfill-example',
        last_write_principal_id=last_write_principal_id WHERE id=$1`, [Number(remembered.id)]);
      await engine.executeRaw('UPDATE takes SET last_write_principal_id=last_write_principal_id,write_request_id=write_request_id WHERE page_id=$1', [before.page.id]);
      await engine.executeRaw('UPDATE pages SET revision_principal_id=revision_principal_id WHERE id=$1', [before.page.id]);
      // A projection-only page update outside any write scope keeps the live revision's writer.
      await engine.executeRaw('UPDATE pages SET links_extracted_at=now() WHERE id=$1', [before.page.id]);
      expect(await pageRevisionActor(brain, slug)).toEqual(revisionBefore);
      // created_by is immutable once recorded.
      expect(await fact(brain, remembered.id)).toEqual(factBefore);
      expect((await engine.readPageSnapshot(slug, { sourceId: brain.sourceId }))!.revision).toBe(before.revision);
      // Content still requires the coordinator.
      await expect(engine.executeRaw("UPDATE facts SET fact='Changed outside the coordinator' WHERE id=$1", [Number(remembered.id)]))
        .rejects.toThrow(/writer_coordinator_required/);
      await expect(engine.executeRaw("UPDATE pages SET title='Changed outside the coordinator' WHERE id=$1", [before.page.id]))
        .rejects.toThrow(/writer_coordinator_required/);
    }
  }, 120_000);

  test('every row a managed brain writes through sync, cycle maintenance and journaled operations is attributed', async () => {
    await withFixedEmbeddings(async () => {
      for (const engine of engines) {
        const brain = await managedBrain(engine);
        const sourceId = `attr-sync-${randomUUID().slice(0, 8)}`;
        const root = join(home, sourceId);
        const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const facts = renderFactsTable([{ rowNum: 1, claim: 'Synced fenced fact', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }] as never);
        const takes = renderTakesFence([{ rowNum: 1, claim: 'Synced fenced take', kind: 'take', holder: 'world', weight: 0.6, active: true }] as never);
        mkdirSync(join(root, 'people'), { recursive: true }); git('init', '-q');
        writeFileSync(join(root, 'people/alice-example.md'), page('Alice', `Profile\n\n${facts}\n\n${takes}\n\n<!-- timeline -->\n\n## Timeline\n- **2026-09-15** | manual — Joined the team`));
        writeFileSync(join(root, 'people/charlie-example.md'), page('Charlie', 'Profile'));
        git('add', '.'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')`, [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { ...brain.local, sourceId };
        expect((await performManagedSync(engine, { sourceId, noPull: true })).status).toBe('first_sync');

        // Remove derived rows so each cycle writer has real work to redo.
        const [alice] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id=$1 AND slug='people/alice-example'", [sourceId]);
        await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
          await tx.executeRaw('DELETE FROM facts WHERE source_id=$1', [sourceId]);
          await tx.executeRaw('DELETE FROM takes WHERE page_id=$1', [alice.id]);
          await tx.executeRaw('DELETE FROM timeline_entries WHERE page_id=$1', [alice.id]);
        }, TEST_WRITE_ATTRIBUTION));
        await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
        await runExtractFacts(engine, { sourceId });
        await extractTakes(engine, { source: 'db', rebuild: true });
        await runManagedStaleExtraction(engine, { sourceId });
        expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [sourceId])).toHaveLength(1);
        expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [alice.id])).toHaveLength(1);
        expect(await engine.executeRaw('SELECT id FROM timeline_entries WHERE page_id=$1', [alice.id])).toHaveLength(1);
        const maintenance = actor(null, brain.principals.local);
        for (const [table, where, key] of [['facts', 'source_id=$1', sourceId], ['takes', 'page_id=$1', alice.id], ['timeline_entries', 'page_id=$1', alice.id]] as const) {
          const rows = await engine.executeRaw<RowActors>(`SELECT ${ROW_COLUMNS} FROM ${table} WHERE ${where}`, [key]);
          expect({ table, created: rows.map(created) }).toEqual({ table, created: [maintenance] });
        }

        const remembered = await submitRememberMutation(ctx, { fact: 'Leads the design review', provenance: 'test', entity: 'people/charlie-example', request_id: randomUUID() }, 30_000);
        await run(ctx, 'takes_add', { slug: 'people/charlie-example', claim: 'Ships carefully', kind: 'take', holder: 'world' });
        await run(ctx, 'add_timeline_entry', { slug: 'people/charlie-example', date: '2026-09-20', summary: 'Gave a talk' });
        await submitForgetMutation(ctx, 'forget', { id: remembered.id, request_id: randomUUID() });
        const live = (await engine.readPageSnapshot('people/charlie-example', { sourceId }))!;
        await run(ctx, 'delete_page', { slug: 'people/charlie-example', expected_revision: live.revision });
        const deleted = (await engine.readPageSnapshot('people/charlie-example', { sourceId, includeDeleted: true }))!;
        await run(ctx, 'restore_page', { slug: 'people/charlie-example', expected_revision: deleted.revision });
        const [version] = await engine.executeRaw<{ id: number }>(`SELECT v.id FROM page_versions v JOIN pages p ON p.id=v.page_id
          WHERE p.source_id=$1 AND p.slug='people/charlie-example' ORDER BY v.id LIMIT 1`, [sourceId]);
        const current = (await engine.readPageSnapshot('people/charlie-example', { sourceId }))!;
        await run(ctx, 'revert_version', { slug: 'people/charlie-example', version_id: version.id, expected_revision: current.revision });

        const unattributed = await engine.executeRaw<{ kind: string; n: number }>(`
          SELECT 'facts' AS kind, count(*)::int AS n FROM facts WHERE source_id=$1 AND created_at>=$2::timestamptz AND (write_principal_kind IS NULL OR last_write_principal_kind IS NULL)
          UNION ALL SELECT 'takes', count(*)::int FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND t.created_at>=$2::timestamptz AND (t.write_principal_kind IS NULL OR t.last_write_principal_kind IS NULL)
          UNION ALL SELECT 'timeline_entries', count(*)::int FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND t.created_at>=$2::timestamptz AND (t.write_principal_kind IS NULL OR t.last_write_principal_kind IS NULL)
          UNION ALL SELECT 'page_versions', count(*)::int FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.snapshot_at>=$2::timestamptz AND (v.write_principal_kind IS NULL OR v.archived_principal_kind IS NULL)
          UNION ALL SELECT 'pages', count(*)::int FROM pages WHERE source_id=$1 AND revision_principal_kind IS NULL`, [sourceId, brain.startedAt]);
        expect(unattributed).toEqual(['facts', 'takes', 'timeline_entries', 'page_versions', 'pages'].map(kind => ({ kind, n: 0 })));
        const counted = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1`, [sourceId]);
        expect(counted[0].n).toBeGreaterThanOrEqual(3);
      }
    });
  }, 180_000);
});

describe('write attribution scopes', () => {
  test('a nested coordinated write keeps the outer actor; withWriteAttribution stamps without coordinator capability; both restore the enclosing settings', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      const slug = 'notes/nested-example';
      const createdBy = await run(brain.local, 'put_page', { slug, content: page('Nested', 'Body') });
      const outer: WriteAttribution = { requestId: randomUUID(), principal: brain.principals.oauth };
      const inner: WriteAttribution = { requestId: null, principal: brain.principals.token };
      const settings = async (db: BrainEngine) => (await db.executeRaw<{ v: string }>(`SELECT concat_ws('|',current_setting('gbrain.write_request',true),
        current_setting('gbrain.write_principal_kind',true),current_setting('gbrain.write_principal_id',true),current_setting('gbrain.write_sources',true)) AS v`))[0].v;
      const after = await engine.transaction(async tx => {
        const id = await withCoordinatedWrite(tx, [brain.sourceId], () => withCoordinatedWrite(tx, [brain.sourceId], async () =>
          (await tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,source,visibility) VALUES($1,$2,'Nested claim','test','world') RETURNING id`, [brain.sourceId, slug]))[0].id, inner), outer);
        const restored = await settings(tx);
        const [{ id: pageId }] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]);
        await withWriteAttribution(tx, inner, () => tx.executeRaw(`INSERT INTO page_versions(page_id,compiled_truth,frontmatter,knowledge_revision)
          SELECT id,compiled_truth,frontmatter,knowledge_revision FROM pages WHERE id=$1`, [pageId]));
        return { id, restored, final: await settings(tx) };
      });
      expect(after.restored).toBe('|||');
      expect(after.final).toBe('|||');
      expect(created(await fact(brain, after.id))).toEqual(actor(outer.requestId, outer.principal));
      const [version] = (await versions(brain, slug)).slice(-1);
      expect(version.write).toEqual(actor(await requestRow(brain, brain.local, createdBy), brain.principals.local));
      expect(version.archived).toEqual(actor(null, inner.principal));
    }
  }, 120_000);
});

describe('maintenance attribution', () => {
  test('names the local CLI registration, else the host, and never mints an identity file', async () => {
    for (const engine of engines) {
      const brain = await managedBrain(engine);
      expect(await engine.transaction(tx => maintenanceAttribution(tx))).toEqual({ requestId: null, principal: brain.principals.local });
      const elsewhere = mkdtempSync(join(home, 'unregistered-'));
      const unregistered = await withEnv({ GBRAIN_HOME: elsewhere }, () => engine.transaction(tx => maintenanceAttribution(tx)));
      expect(unregistered).toEqual({ requestId: null, principal: { kind: 'application', id: 'host:unregistered' } });
      expect(readdirSync(elsewhere)).toEqual([]);
      const fallback = await withEnv({ GBRAIN_HOME: elsewhere }, async () => {
        const hostId = localHostId();
        return { hostId, attribution: await engine.transaction(tx => maintenanceAttribution(tx)) };
      });
      expect(fallback.attribution).toEqual({ requestId: null, principal: { kind: 'application', id: `host:${fallback.hostId}` } });
    }
  });
});

describe('write attribution column classification', () => {
  test('every column of facts, takes and timeline_entries is content, physical projection or attribution', async () => {
    for (const engine of engines) {
      for (const table of Object.keys(WRITE_ATTRIBUTION_CONTENT_COLUMNS) as AttributedTable[]) {
        const columns = (await engine.executeRaw<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`, [table]))
          .map(row => row.column_name);
        const classified = [...WRITE_ATTRIBUTION_CONTENT_COLUMNS[table], ...WRITE_ATTRIBUTION_PROJECTION_COLUMNS[table], ...ROW_ATTRIBUTION_COLUMNS];
        expect({ table, unclassified: columns.filter(column => !classified.includes(column)) }).toEqual({ table, unclassified: [] });
        expect({ table, missing: classified.filter(column => !columns.includes(column)) }).toEqual({ table, missing: [] });
        expect(new Set(classified).size).toBe(classified.length);
      }
    }
  });
});
