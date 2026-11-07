/**
 * #5974: a database guard refusal during publication used to surface as an
 * opaque `storage_error: Publication failed (P0001)`. It now names the trigger,
 * table, operation, guard branch and source relationship, records the build and
 * host that ran the attempt, keeps that detail through recovery and
 * compaction, and exposes source identifiers only to the owner diagnostics.
 * Runs on PGLite, and on an isolated Postgres database when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts, receiptFor, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { databaseRefusal, publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { writeResponse } from '../src/core/persistence/service.ts';
import { DATABASE_REFUSAL_HINT } from '../src/core/persistence/connector-errors.ts';
import { VERSION } from '../src/version.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
const roots: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'refusal-owned';
const otherSource = 'refusal-other';
const hostId = randomUUID();
const input = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
const ctx = (engine: BrainEngine, source = sourceId): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId: source, remote: false,
  dryRun: false, logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  const local = new PGLiteEngine();
  await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    closePostgres = isolated.close; engines.push(isolated.engine);
  }
  for (const engine of engines) {
    for (const id of [sourceId, otherSource]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [id]);
    await registerLocalWriter(engine, 'cli');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function admission(engine: BrainEngine, slug: string, extra: Partial<WriteAdmission> = {}): Promise<WriteAdmission> {
  const source = extra.sourceId ?? sourceId;
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [source]);
  const authority = await submissionAuthority(ctx(engine, source), 'put_page', source, row.incarnation, slug);
  const page = await engine.readPageSnapshot(slug, { sourceId: source, includeDeleted: true });
  return { principal: authority.principal, operation: 'put_page', sourceId: source, sourceIncarnation: row.incarnation, slug,
    pageId: page?.page.id ?? null, requestId: randomUUID(), callerIntent: { content: slug }, intent: { content: slug }, authority, ...extra };
}
async function managed<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
}

describe('#5974 database refusal diagnostics', () => {
  test('#7777 a nested protocol refusal rolls back the page and survives receipt delivery and compaction', async () => {
    for (const engine of engines) await managed(engine, async () => {
      const slug = `protocol-${engine.kind}`;
      await admitWrite(engine, await admission(engine, slug));
      const row = (await claimNextWrite(engine, hostId))!;
      const done = await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage(slug, input('must roll back'), { sourceId });
        await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','',true)");
        // The request guard calls gbrain_require_persistence_protocol: the inner raiser must be retained.
        await tx.executeRaw('UPDATE persistence_requests SET protocol_version=2 WHERE id=$1::uuid', [row.id]);
        return {};
      } }, hostId);
      expect(done.state).toBe('failed');
      expect(done.error_code).toBe('writer_upgrade_required');
      expect(done.error_detail).toMatchObject({ origin: 'database_guard', sqlstate: '42501',
        raiser: 'gbrain_require_persistence_protocol', stage: 'publication', attempt: { consumer_version: VERSION } });
      expect(await engine.readPageSnapshot(slug, { sourceId })).toBeNull();
      expect(receiptFor(done)).toMatchObject({ write_error: 'writer_upgrade_required',
        write_error_detail: { sqlstate: '42501', raiser: 'gbrain_require_persistence_protocol', stage: 'publication' } });
      expect(JSON.stringify(receiptFor(done))).not.toContain('consumer_version');
      try { writeResponse(done); throw new Error('expected protocol refusal'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'writer_upgrade_required', detail: 'database_guard' });
        expect((error as { suggestion: string }).suggestion).toContain('Never lower');
      }
      const diagnostics = await readWriterDiagnostics(engine);
      expect(diagnostics.recent_failures.find(f => f.request_id === done.request_id)?.next_action).toContain('upgrade');
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '400 days' WHERE id=$1::uuid", [done.id]);
      await compactWriteReceipts(engine, 1);
      const [compacted] = await engine.executeRaw<{ error_code: string; error_detail: unknown; compacted: boolean }>(
        'SELECT error_code,error_detail,compacted FROM persistence_requests WHERE id=$1::uuid', [done.id]);
      expect(compacted).toMatchObject({ compacted: true, error_code: 'writer_upgrade_required',
        error_detail: { sqlstate: '42501', raiser: 'gbrain_require_persistence_protocol' } });
    });
  });
  test('a cross-source write inside publication fails with a structured, redacted diagnostic', async () => {
    for (const engine of engines) await managed(engine, async () => {
      const slug = `cross-${engine.kind}`;
      await admitWrite(engine, await admission(engine, slug));
      const row = (await claimNextWrite(engine, hostId))!;
      const done = await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage(slug, input('owned'), { sourceId });
        await tx.putPage(`${slug}-leak`, input('not owned'), { sourceId: otherSource });
        return { status: 'created' };
      } }, hostId);

      expect(done.state).toBe('failed');
      expect(done.error_code).toBe('writer_coordinator_required');
      expect(done.error_message).toBe('The managed-writer database guard refused an INSERT on pages: a row in a source this publication does not own. Nothing was committed.');
      expect(done.error_detail).toMatchObject({ origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer',
        table: 'pages', op: 'INSERT', branch: 'allowlist', relationship: 'different_source', stage: 'publication',
        sources: { target: otherSource, old: null, allowed: [sourceId] }, attempt: { consumer_version: VERSION } });
      expect(await engine.readPageSnapshot(slug, { sourceId })).toBeNull();
      expect(await engine.readPageSnapshot(`${slug}-leak`, { sourceId: otherSource })).toBeNull();

      const receipt = receiptFor(done) as Record<string, unknown>;
      expect(receipt.write_error).toBe('writer_coordinator_required');
      expect(receipt.write_error_detail).toEqual({ origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer',
        table: 'pages', op: 'INSERT', branch: 'allowlist', relationship: 'different_source', stage: 'publication' });
      expect(JSON.stringify(receipt)).not.toContain(otherSource);
      try { writeResponse(done); throw new Error('expected a refusal'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'writer_coordinator_required', suggestion: DATABASE_REFUSAL_HINT, detail: 'database_guard' });
        expect(JSON.stringify(error)).not.toContain(otherSource);
      }

      const diagnostics = await readWriterDiagnostics(engine);
      const failure = diagnostics.recent_failures.find(f => f.request_id === done.request_id)!;
      expect(failure.error_detail).toMatchObject({ sources: { target: otherSource, allowed: [sourceId] }, attempt: { consumer_version: VERSION } });
      expect(failure.next_action).toBe(DATABASE_REFUSAL_HINT);

      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '400 days' WHERE id=$1::uuid", [done.id]);
      await compactWriteReceipts(engine, 1);
      const [compacted] = await engine.executeRaw<{ compacted: boolean; error_message: string | null; error_detail: unknown }>(
        'SELECT compacted,error_message,error_detail FROM persistence_requests WHERE id=$1::uuid', [done.id]);
      expect(compacted.compacted).toBe(true);
      expect(compacted.error_message).toBeNull();
      expect(compacted.error_detail).toMatchObject({ table: 'pages', relationship: 'different_source' });
    });
  });

  test('a refusal after the canonical file was replaced restores it and records the stage', async () => {
    for (const engine of engines) {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-refusal-root-')); roots.push(root);
      const fileSource = `refusal-file-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [fileSource, root]);
      const binding = await claimWorktree(engine, fileSource, root, hostId);
      const path = join(root, 'file.md'); writeFileSync(path, 'Before');
      const a = await admission(engine, 'file', { sourceId: fileSource, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
      await managed(engine, async () => {
      await admitWrite(engine, a);
      const row = (await claimNextWrite(engine, hostId))!;
      const done = await publishMutation(engine, row, { observedRevision: null, file: { path, root, content: 'After' },
        apply: async tx => { await tx.putPage('file-leak', input('not owned'), { sourceId: otherSource }); return {}; } }, hostId);
      expect(done.state).toBe('failed');
      expect(done.recovery).toBeNull();
      expect(readFileSync(path, 'utf8')).toBe('Before');
      expect(done.error_detail).toMatchObject({ origin: 'database_guard', table: 'pages', stage: 'after_file_publication',
        sources: { target: otherSource, allowed: [fileSource] } });
      });
    }
  });

  test('a guarded tag write outside any coordinator names the table and missing allowlist', async () => {
    for (const engine of engines) {
      await engine.putPage('tagged', input('x'), { sourceId });
      const error = await managed(engine, () => engine.addTag('tagged', 'loose', { sourceId }).then(() => null, e => e));
      expect(databaseRefusal(error)).toMatchObject({ code: 'writer_coordinator_required',
        detail: { table: 'tags', op: 'INSERT', branch: 'allowlist', relationship: 'different_source', sources: { target: sourceId, allowed: [] } } });
    }
  });

  test('another P0001 raiser stays storage_error but names its function; other errors are not classified', async () => {
    for (const engine of engines) {
      const error = await engine.executeRaw("DO $$ BEGIN RAISE EXCEPTION 'private page text must not leak'; END $$").then(() => null, e => e);
      const refusal = databaseRefusal(error)!;
      expect(refusal).toMatchObject({ code: 'storage_error', detail: { origin: 'database_trigger', sqlstate: 'P0001', raiser: 'inline_code_block' } });
      expect(JSON.stringify(refusal)).not.toContain('private page text');
      expect(databaseRefusal(Object.assign(new Error('x'), { code: '23505' }))).toBeNull();
      expect(publicFailureDetail({ origin: 'database_guard', sources: { target: 'a' }, attempt: { consumer_version: '1' }, table: 'pages' }))
        .toEqual({ origin: 'database_guard', table: 'pages' });
    }
  });
});
