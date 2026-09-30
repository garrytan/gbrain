import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configDir } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { acceptWriterTransfer, acquireWorktree, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcileBackups, runReconcilePreview, assertReconcileOutputPath } from '../src/core/persistence/reconcile.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts, getWriteRequest } from '../src/core/persistence/journal.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { retainReconcileBackup } from '../src/core/persistence/reconcile-backup.ts';
import { prepareReconcileMutation } from '../src/core/persistence/reconcile-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { reconcileCanonical } from '../src/core/persistence/reconcile-merge.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine, enabled = false, body = 'A useful durable example observation.') {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `reconcile-${randomUUID().slice(0, 12)}`, root = join(home, id), slug = 'notes/example';
  mkdirSync(join(root, 'notes'), { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  const content = `---\ntype: note\ntitle: Example\ncustom_database: kept\nprofile:\n  role: example-role\n---\n${body}\n`;
  await importFromContent(engine, slug, content, { sourceId: id, sourcePath: 'notes/example.md', noEmbed: true });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
  const file = join(root, 'notes/example.md');
  writeFileSync(file, serializePageToMarkdown({ ...snapshot.page, frontmatter: { profile: { location: 'example-place' }, custom_file: 'kept' } }, snapshot.tags));
  const binding = await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
  const registration = await registerLocalWriter(engine, 'cli');
  return { id, root, slug, file, binding, registration, snapshot };
}
const local = <T>(engine: BrainEngine, registration: LocalRegistration, fn: () => Promise<T>) => withVerifiedLocalRegistration(engine, registration, fn);
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
async function preparedRepair(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>) {
  const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
  const authority = await submissionAuthority({ engine, remote: false } as OperationContext, 'put_page', f.id, preview.preconditions.source_incarnation, f.slug);
  const requestId = randomUUID(), reference = await retainReconcileBackup(engine, preview, authority.principal, requestId);
  const callerIntent = { kind: 'canonical_reconcile', preview };
  await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: f.id, sourceIncarnation: preview.preconditions.source_incarnation,
    slug: f.slug, pageId: f.snapshot.page.id, worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation,
    requestId, authority, callerIntent, intent: { ...callerIntent, backup_reference: reference } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  expect(row.request_id).toBe(requestId);
  const prepared = await prepareReconcileMutation(engine, row, { engine: engine.kind });
  return { preview, authority, reference, row, prepared, params: { source_id: f.id, slug: f.slug, preview, request_id: requestId } };
}

test('repairs claimed enabled and disabled sources without topology changes and retains both preimages', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled), before = readFileSync(f.file);
    await expect(prepareFileTarget(engine, { source_id: f.id, slug: f.slug, worktree_id: f.binding.worktree_id }, f.snapshot, 'next')).rejects.toMatchObject({ code: 'source_changed' });
    const [sourceBefore] = await engine.executeRaw('SELECT incarnation,last_commit,last_sync_at,config FROM sources WHERE id=$1', [f.id]);
    await local(engine, f.registration, async () => {
      const preview = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      expect(preview.status).toBe('ready');
      expect(preview.preview.result.frontmatter).toMatchObject({ custom_database: 'kept', custom_file: 'kept', profile: { role: 'example-role', location: 'example-place' } });
      expect(readFileSync(f.file)).toEqual(before);
      expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
      const receipt = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: preview.preview, request_id: randomUUID() });
      expect(receipt.state).toBe('committed');
      expect(receipt.outcome).toMatchObject({ status: 'reconciled', database_changed: true, file_changed: true });
      const outcome = receipt.outcome as { backup_reference: string };
      const backup = join(configDir(), 'reconciliation-previews', outcome.backup_reference);
      if (process.platform !== 'win32') {
        expect(statSync(backup).mode & 0o777).toBe(0o600);
        expect(statSync(join(configDir(), 'reconciliation-previews')).mode & 0o777).toBe(0o700);
      }
      expect(JSON.parse(readFileSync(backup, 'utf8')).preview.preimages.file_base64).toBe(before.toString('base64'));
      const current = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
      expect(current.page.frontmatter).toEqual(preview.preview.result.frontmatter);
      expect(parseMarkdown(readFileSync(f.file, 'utf8'), f.slug).frontmatter).toEqual(current.page.frontmatter);
      await expect(prepareFileTarget(engine, { source_id: f.id, slug: f.slug, worktree_id: f.binding.worktree_id }, current, 'next')).resolves.toBeDefined();
    });
    expect(await getWorktreeBinding(engine, f.id)).toEqual(f.binding);
    expect((await engine.executeRaw('SELECT incarnation,last_commit,last_sync_at,config FROM sources WHERE id=$1', [f.id]))[0]).toEqual(sourceBefore);
    expect((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled).toBe(enabled);
  }
}), 120_000);

test('same-ID replay precedes raw CAS, survives compaction and never allocates another backup', async () => isolated(async engine => {
  const f = await fixture(engine);
  await local(engine, f.registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    const params = { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() };
    const receipt = await runReconcileApply(engine, params);
    const files = readdirSync(join(configDir(), 'reconciliation-previews'));
    writeFileSync(f.file, 'A later independent edit.\n');
    expect((await runReconcileApply(engine, params)).revision).toBe(receipt.revision);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id=(SELECT id FROM persistence_requests WHERE request_id=$1::uuid)", [params.request_id]);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '60 days' WHERE request_id=$1::uuid", [params.request_id]);
    await compactWriteReceipts(engine);
    expect(await runReconcileApply(engine, params)).toMatchObject({ state: 'committed', compacted: true, revision: receipt.revision });
    expect(readdirSync(join(configDir(), 'reconciliation-previews'))).toEqual(files);
    await expect(runReconcileApply(engine, { ...params, preview: { ...preview, preview_id: randomUUID() } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
}), 120_000);

test('raw-byte, policy, withdrawal and owner epoch changes refuse new admission', async () => isolated(async engine => {
  for (const mutation of ['raw', 'policy', 'withdrawal', 'owner']) {
    const f = await fixture(engine);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      if (mutation === 'raw') writeFileSync(f.file, readFileSync(f.file, 'utf8').replace(/\n/g, '\r\n'));
      if (mutation === 'policy') await engine.setConfig('content_sanity.bytes_warn', String(200000 + Math.floor(Math.random() * 100)));
      if (mutation === 'withdrawal') await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES($1,'world',$2)", [f.id, 'a'.repeat(64)]);
      if (mutation === 'owner') await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=$1::uuid', [f.binding.worktree_id]);
      await expect(runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() })).rejects.toMatchObject({ code: 'source_changed' });
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
    });
  }
}), 120_000);

test('file-only drift publishes instead of a global no-op and preserves the DB revision', async () => isolated(async engine => {
  const f = await fixture(engine);
  writeFileSync(f.file, serializePageToMarkdown({ ...f.snapshot.page, frontmatter: {} }, []));
  await local(engine, f.registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    const result = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() });
    expect(result.outcome).toMatchObject({ database_changed: false, file_changed: true });
    expect(result.revision).toBe(f.snapshot.revision);
    expect(parseMarkdown(readFileSync(f.file, 'utf8'), f.slug).frontmatter.custom_database).toBe('kept');
  });
}), 120_000);

test('original and current grants are enforced before reading either preimage', async () => isolated(async engine => {
  const f = await fixture(engine);
  await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({ code: 'permission_denied' });
  const narrow = await registerLocalWriter(engine, 'stdio');
  await expect(local(engine, narrow, () => runReconcilePreview(engine, { source_id: f.id, slug: f.slug }))).rejects.toMatchObject({ code: 'permission_denied' });
  const originalRead = engine.readPageSnapshot;
  let reads = 0;
  engine.readPageSnapshot = async (...args) => { reads++; return originalRead.apply(engine, args); };
  try {
    await local(engine, f.registration, async () => {
      await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid", [f.registration.id,
        JSON.stringify({ sourceIds: ['*'], scopes: ['write'], operations: ['put_page'], slugPrefixes: ['other/'] })]);
      await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({ code: 'permission_denied' });
      expect(reads).toBe(0);
    });
  } finally {
    engine.readPageSnapshot = originalRead;
    await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid", [f.registration.id,
      JSON.stringify({ sourceIds: ['*'], scopes: ['read', 'write'], operations: null, slugPrefixes: null })]);
  }
  await expect(assertReconcileOutputPath(engine, f.id, join(f.root, 'private.json'))).rejects.toMatchObject({ code: 'permission_denied' });
}), 120_000);

test('conflicting bodies require reviewed decisions and modified artifacts cannot apply', async () => isolated(async engine => {
  const f = await fixture(engine);
  writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('A useful durable example observation.', 'A different carefully reviewed observation.'));
  await local(engine, f.registration, async () => {
    const initial = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    expect(initial.status).toBe('needs_resolution');
    expect(initial.conflict_paths).toEqual(['/compiled_truth']);
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug, from: initial.preview,
      decisions: [{ path: '/compiled_truth', action: 'take_file' }, { path: '/frontmatter/custom_database', action: 'delete' }] });
    expect(preview.status).toBe('ready');
    expect(preview.result.compiled_truth).toBe('A different carefully reviewed observation.');
    await expect(runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: { ...preview, unexpected: true }, request_id: randomUUID() })).rejects.toMatchObject({ code: 'invalid_params' });
    expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() })).state).toBe('committed');
  });
}), 120_000);

test('unchanged safety assessments reuse canonical stamps without fresh revision churn', async () => isolated(async engine => {
  const f = await fixture(engine, true, 'Just a moment...\n\nChecking your browser before accessing this website.\nVerify you are human.');
  await local(engine, f.registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    expect(preview.result.frontmatter.quarantine).toBeDefined();
    const first = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() });
    const second = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    expect(second.preview.result).toEqual(preview.result);
    const repeated = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: second.preview, request_id: randomUUID() });
    expect(repeated.revision).toBe(first.revision);
    expect(repeated.outcome).toMatchObject({ database_changed: false, file_changed: false });
    let importNoop = false;
    await importFromContent(engine, f.slug, readFileSync(f.file, 'utf8'), { sourceId: f.id, sourcePath: 'notes/example.md', noEmbed: true,
      prepare: async value => { importNoop = value.noop; expect(value.parsedPage.frontmatter).toEqual(preview.result.frontmatter); return value.result; } });
    expect(importNoop).toBe(true);
  });
}), 120_000);

test('private and withdrawn timeline facts survive file choices without resurrection', async () => isolated(async engine => {
  const privateBody = upsertFactRow('Private biography.', { claim: 'Prefers a private example venue', kind: 'fact', visibility: 'private', confidence: 1, notability: 'medium' }).body;
  const timeline = upsertFactRow('## Timeline\n', { claim: 'Previously preferred the old example venue', kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium' }).body.replace('| 1 |', '| 2 |');
  const f = await fixture(engine, false, `${privateBody}\n<!-- timeline -->\n${timeline}`);
  await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES($1,'world',$2)",
    [f.id, sha256('previously preferred the old example venue')]);
  writeFileSync(f.file, serializePageToMarkdown({ ...f.snapshot.page, compiled_truth: 'A revised public biography.' }, []));
  await local(engine, f.registration, async () => {
    const initial = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    const decisions = initial.preview.conflicts.map(c => ({ path: c.path, action: 'take_file' }));
    const resolved = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug, from: initial.preview, decisions });
    expect(parseFactsFence(resolved.preview.result.compiled_truth).facts[0].visibility).toBe('private');
    const retired = parseFactsFence(resolved.preview.result.timeline).facts[0];
    expect(retired.validUntil).toBeDefined();
    expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: resolved.preview, request_id: randomUUID() })).state).toBe('committed');
    const current = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
    expect(parseFactsFence(current.page.compiled_truth).facts[0].visibility).toBe('private');
    expect(parseFactsFence(current.page.timeline).facts[0].validUntil).toBe(retired.validUntil);
  });
}), 120_000);

test('matching legacy scan state migrates only during canonical publication', async () => isolated(async engine => {
  const f = await fixture(engine);
  const marker = f.snapshot.page.content_hash!.slice(0, 16);
  await withCoordinatedWrite(engine, [f.id], () => engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || $3::text::jsonb WHERE source_id=$1 AND slug=$2",
    [f.id, f.slug, JSON.stringify({ atoms_scan_hash: marker, atoms_custom: 'preserve' })]));
  const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
  writeFileSync(f.file, serializePageToMarkdown(before.page, before.tags));
  await local(engine, f.registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    expect(preview.result.frontmatter.atoms_scan_hash).toBeUndefined();
    expect(preview.result.frontmatter.atoms_custom).toBe('preserve');
    expect(await engine.executeRaw('SELECT * FROM extract_atoms_page_state WHERE page_id=$1', [before.page.id])).toHaveLength(0);
    const result = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() });
    expect(result.outcome).toMatchObject({ scan_state_transferred: true });
    expect(await engine.executeRaw('SELECT tombstoned FROM extract_atoms_page_state WHERE page_id=$1', [before.page.id])).toEqual([{ tombstoned: true }]);
  });
}), 120_000);

test('capacity refusal is bounded, preserves originals, and admits no request', async () => isolated(async engine => {
  const f = await fixture(engine), raw = readFileSync(f.file);
  await local(engine, f.registration, async () => {
    await engine.setConfig('persistence.limits.brain_lifetime_ids', '0');
    try {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      await expect(runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() })).rejects.toMatchObject({ code: 'queue_capacity' });
      expect(readFileSync(f.file)).toEqual(raw);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
    } finally { await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.brain_lifetime_ids'"); }
  });
}), 120_000);

test('queued intent resumes with a fresh consumer and retains its accepted request identity', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      const ctx = { engine, remote: false, sourceId: f.id } as OperationContext;
      const authority = await submissionAuthority(ctx, 'put_page', f.id, preview.preconditions.source_incarnation, f.slug);
      const requestId = randomUUID();
      const reference = await retainReconcileBackup(engine, preview, authority.principal, requestId);
      const callerIntent = { kind: 'canonical_reconcile', preview };
      await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: f.id,
        sourceIncarnation: preview.preconditions.source_incarnation, slug: f.slug, pageId: f.snapshot.page.id,
        worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation, requestId, authority, callerIntent,
        intent: { ...callerIntent, backup_reference: reference } });
      await expect(runReconcileBackups(engine, { source_id: f.id, slug: f.slug, action: 'remove', backup_reference: reference })).rejects.toMatchObject({ code: 'recovery_required' });
      await disposePersistenceConsumer(engine);
      const result = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: requestId });
      expect(result).toMatchObject({ state: 'committed', request_id: requestId });
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(configDir(), 'reconciliation-previews', reference), 'utf8')).preview.result_digest).toBe(preview.result_digest);
      await disposePersistenceConsumer(engine);
      const listing = await runReconcileBackups(engine, { source_id: f.id, slug: f.slug, action: 'list' });
      expect(listing.backups).toMatchObject([{ backup_reference: reference, retained: true, removable: true }]);
      expect(await runReconcileBackups(engine, { source_id: f.id, slug: f.slug, action: 'remove', backup_reference: reference })).toMatchObject({ removed: true });
      expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: requestId })).revision).toBe(result.revision);
    });
  }
}), 120_000);

test('publication rechecks grants after preparation without touching the canonical file', async () => isolated(async engine => {
  const f = await fixture(engine), raw = readFileSync(f.file);
  await local(engine, f.registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    const authority = await submissionAuthority({ engine, remote: false } as OperationContext, 'put_page', f.id, preview.preconditions.source_incarnation, f.slug);
    const requestId = randomUUID(), reference = await retainReconcileBackup(engine, preview, authority.principal, requestId);
    const callerIntent = { kind: 'canonical_reconcile', preview };
    await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: f.id, sourceIncarnation: preview.preconditions.source_incarnation,
      slug: f.slug, pageId: f.snapshot.page.id, worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation,
      requestId, authority, callerIntent, intent: { ...callerIntent, backup_reference: reference } });
    const row = (await claimNextWrite(engine, localHostId()))!;
    const prepared = await prepareReconcileMutation(engine, row, { engine: engine.kind });
    await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid", [f.registration.id,
      JSON.stringify({ sourceIds: ['*'], scopes: ['read'], operations: null, slugPrefixes: null })]);
    try {
      const result = await publishMutation(engine, row, prepared);
      expect(result.state).not.toBe('committed');
      expect((await getWriteRequest(engine, authority.principal, requestId))?.error_code).toBe('permission_denied');
      expect(readFileSync(f.file)).toEqual(raw);
    } finally {
      await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid", [f.registration.id,
        JSON.stringify({ sourceIds: ['*'], scopes: ['read', 'write'], operations: null, slugPrefixes: null })]);
    }
  });
}), 120_000);

test('concurrent same-ID callers replay a winner committed between lookup and live CAS', async () => isolated(async engine => {
  for (const pauseLookup of [1, 3]) {
    const f = await fixture(engine);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      const params = { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() };
      const executeRaw = engine.executeRaw;
      let release!: () => void, paused!: () => void, reads = 0;
      const held = new Promise<void>(resolve => { release = resolve; });
      const reached = new Promise<void>(resolve => { paused = resolve; });
      engine.executeRaw = async function(this: BrainEngine, sql: string, values?: unknown[]) {
        const result = await executeRaw.call(this, sql, values);
        if (sql.includes('SELECT * FROM persistence_requests WHERE principal_kind=') && values?.[2] === params.request_id && ++reads === pauseLookup) {
          paused(); await held;
        }
        return result;
      } as BrainEngine['executeRaw'];
      try {
        const delayed = runReconcileApply(engine, params);
        await reached;
        const winner = await runReconcileApply(engine, params);
        expect(winner.state).toBe('committed');
        release();
        expect(await delayed).toMatchObject({ state: 'committed', request_id: params.request_id, revision: winner.revision });
        expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
        await expect(runReconcileApply(engine, { ...params, request_id: randomUUID() })).rejects.toMatchObject({ code: 'source_changed' });
      } finally { release(); engine.executeRaw = executeRaw; }
    });
  }
}), 120_000);

test('valid empty metadata is ordinary input while malformed metadata and missing files are refused', async () => isolated(async engine => {
  const f = await fixture(engine);
  await local(engine, f.registration, async () => {
    writeFileSync(f.file, '---\n{}\n---\nA useful durable example observation.\n');
    expect((await runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).preview.result.frontmatter.custom_database).toBe('kept');
    for (const invalid of ['---\n[1, 2]\n---\nBody.', '---\nkey: [broken\n---\nBody.', '---\nkey: value\nBody.']) {
      writeFileSync(f.file, invalid);
      await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({ code: 'invalid_params' });
    }
    rmSync(f.file);
    await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({ code: 'source_changed' });
  });
}), 120_000);

test('a repaired page supports normal capture, put, delete and restore with revision-bound readback', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() })).state).toBe('committed');
      const ctx: OperationContext = { engine, remote: false, sourceId: f.id, config: { engine: engine.kind }, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      for (const operation of ['capture', 'put_page']) {
        const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
        const content = serializePageToMarkdown({ ...before.page, compiled_truth: `${before.page.compiled_truth}\n\nA new ${operation} observation.` }, before.tags);
        const receipt = await operationsByName[operation]!.handler(ctx, { source_id: f.id, slug: f.slug, content,
          expected_revision: before.revision, request_id: randomUUID() }) as Record<string, unknown>;
        expect(receipt.state).toBe('committed');
        const after = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
        const file = parseMarkdown(readFileSync(f.file, 'utf8'), f.slug);
        expect(reconcileCanonical(file, file.tags)).toEqual(reconcileCanonical(after.page, after.tags));
        expect(after.page.compiled_truth).toContain(`A new ${operation} observation.`);
        expect(after.page.frontmatter.custom_file).toBe('kept');
      }
      const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
      const deleted = await operationsByName.delete_page!.handler(ctx, { source_id: f.id, slug: f.slug,
        expected_revision: before.revision, request_id: randomUUID() }) as Record<string, unknown>;
      expect(deleted.state).toBe('committed');
      expect(existsSync(f.file)).toBe(false);
      expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toBeNull();
      const tombstone = (await engine.readPageSnapshot(f.slug, { sourceId: f.id, includeDeleted: true }))!;
      const restored = await operationsByName.restore_page!.handler(ctx, { source_id: f.id, slug: f.slug,
        expected_revision: tombstone.revision, request_id: randomUUID() }) as Record<string, unknown>;
      expect(restored.state).toBe('committed');
      const after = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
      const file = parseMarkdown(readFileSync(f.file, 'utf8'), f.slug);
      expect(reconcileCanonical(file, file.tags)).toEqual(reconcileCanonical(after.page, after.tags));
      expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
      expect(after.page.source_kind).toBe(before.page.source_kind);
      expect(after.page.ingested_via).toBe(before.page.ingested_via);
    });
  }
}), 120_000);

test('source substitution, changed canonical revisions and recreated pages never consume an old preview', async () => isolated(async engine => {
  for (const mutation of ['source', 'revision', 'identity']) {
    const f = await fixture(engine), raw = readFileSync(f.file);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      let sourceId = f.id;
      if (mutation === 'source') sourceId = (await fixture(engine)).id;
      else await withCoordinatedWrite(engine, [f.id], async () => {
        if (mutation === 'identity') await engine.deletePage(f.slug, { sourceId: f.id });
        await engine.putPage(f.slug, { type: 'note', title: 'Example', compiled_truth: 'A later database observation.', frontmatter: {} }, { sourceId: f.id });
      });
      await expect(runReconcileApply(engine, { source_id: sourceId, slug: f.slug, preview, request_id: randomUUID() })).rejects.toMatchObject({
        code: mutation === 'source' ? 'invalid_params' : 'source_changed' });
      expect(readFileSync(f.file)).toEqual(raw);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
    });
  }
}), 120_000);

test('derived page telemetry does not stale canonical preimages and CRLF-only differences are explicit', async () => isolated(async engine => {
  const f = await fixture(engine);
  writeFileSync(f.file, serializePageToMarkdown(f.snapshot.page, f.snapshot.tags).replace(/\n/g, '\r\n'));
  await local(engine, f.registration, async () => {
    const result = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    expect(result).toMatchObject({ status: 'ready', line_endings: 'crlf', formatting_only: true });
    await engine.executeRaw('UPDATE pages SET emotional_weight=0.3 WHERE id=$1', [f.snapshot.page.id]);
    expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: result.preview, request_id: randomUUID() })).state).toBe('committed');
    expect(readFileSync(f.file, 'utf8')).not.toContain('\r\n');
    expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  });
}), 120_000);

test('unadmitted private backups cannot be removed through receipt administration', async () => isolated(async engine => {
  const f = await fixture(engine);
  await local(engine, f.registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
    const authority = await submissionAuthority({ engine, remote: false } as OperationContext, 'put_page', f.id, preview.preconditions.source_incarnation, f.slug);
    const reference = await retainReconcileBackup(engine, preview, authority.principal, randomUUID());
    await expect(runReconcileBackups(engine, { source_id: f.id, slug: f.slug, action: 'remove', backup_reference: reference })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(existsSync(join(configDir(), 'reconciliation-previews', reference))).toBe(true);
  });
}), 120_000);

test('public warn-mode put_page rejects reserved reconciliation fields for local and remote callers before admission', async () => isolated(async engine => {
  const f = await fixture(engine);
  await engine.setConfig('mcp.strict_params', 'warn');
  const stdio = await registerLocalWriter(engine, 'stdio');
  for (const remote of [false, true]) for (const extra of [{ kind: 'canonical_reconcile' }, { preview: {} }, { backup_reference: 'private-backup' }]) {
    const result = await local(engine, remote ? stdio : f.registration, () => dispatchToolCall(engine, 'put_page', {
      source_id: f.id, slug: f.slug, content: 'A public caller observation.', expected_revision: f.snapshot.revision,
      request_id: randomUUID(), ...extra,
    }, { remote, sourceId: f.id, config: { engine: engine.kind }, auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: f.id },
      logger: { info() {}, warn() {}, error() {} } }));
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ error: 'invalid_params' });
    expect((result.content[0] as { text: string }).text).toContain('Reserved persistence fields');
  }
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
}), 120_000);

test('a real ownership transfer to a matching successor invalidates an unadmitted preview without changing canonical content', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled), before = readFileSync(f.file);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      const successor = join(home, `${f.id}-successor`), successorHost = randomUUID();
      cpSync(f.root, successor, { recursive: true });
      const transfer = await prepareWriterTransfer(engine, f.id);
      await acceptWriterTransfer(engine, f.id, successor, transfer.owner_epoch, transfer.manifest.digest, successorHost);
      const binding = (await getWorktreeBinding(engine, f.id, successorHost))!;
      expect(binding.owner_host_id).toBe(successorHost);
      expect(binding.local_path).toBe(successor);
      expect(Number(binding.owner_epoch)).toBe(Number(f.binding.owner_epoch) + 1);
      await expect(runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() })).rejects.toMatchObject({ code: 'owner_unavailable' });
      expect(readFileSync(f.file)).toEqual(before);
      expect(readFileSync(join(successor, 'notes/example.md'))).toEqual(before);
      expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
      expect((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled).toBe(enabled);
    });
  }
}), 120_000);

test('a publication holding the native root excludes real transfer until commit and preserves replay after transfer', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled), before = readFileSync(f.file);
    await local(engine, f.registration, async () => {
      const repair = await preparedRepair(engine, f);
      let release!: () => void, reached!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const preparedBoundary = new Promise<void>(resolve => { reached = resolve; });
      const publication = publishMutation(engine, repair.row, repair.prepared, localHostId(), {
        boundary: async name => { if (name === 'prepared') { reached(); await held; } },
      });
      try {
        await preparedBoundary;
        const competingLock = await acquireWorktree(f.binding);
        if (competingLock) await competingLock.release();
        expect(competingLock).toBeNull();
        await expect(prepareWriterTransfer(engine, f.id)).rejects.toMatchObject({ code: 'write_pending' });
        const pending = (await getWriteRequest(engine, repair.authority.principal, repair.row.request_id))!;
        expect(pending.state).toBe('running');
        expect(pending.recovery).not.toBeNull();
        expect((await getWorktreeBinding(engine, f.id))?.state).toBe('active');
        expect(readFileSync(f.file)).toEqual(before);
        expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
      } finally { release(); await publication; }
      const committed = await publication;
      expect(committed.state).toBe('committed');
      const receipt = await runReconcileApply(engine, repair.params);
      const canonical = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
      const repairedBytes = readFileSync(f.file);
      expect(reconcileCanonical(canonical.page, canonical.tags)).toEqual(repair.preview.result);
      const successor = join(home, `${f.id}-successor`), successorHost = randomUUID();
      cpSync(f.root, successor, { recursive: true });
      const transfer = await prepareWriterTransfer(engine, f.id);
      await acceptWriterTransfer(engine, f.id, successor, transfer.owner_epoch, transfer.manifest.digest, successorHost);
      expect((await getWorktreeBinding(engine, f.id, successorHost))?.owner_host_id).toBe(successorHost);
      expect(await runReconcileApply(engine, repair.params)).toEqual(receipt);
      expect(readFileSync(f.file)).toEqual(repairedBytes);
      expect(readFileSync(join(successor, 'notes/example.md'))).toEqual(repairedBytes);
      expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(canonical);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
      expect((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled).toBe(enabled);
    });
  }
}), 120_000);

test('file and database edits after reconciliation preparation abort publication without overwriting the competing state', async () => isolated(async engine => {
  for (const enabled of [false, true]) for (const mutation of ['file', 'database']) {
    const f = await fixture(engine, enabled), originalBytes = readFileSync(f.file);
    await local(engine, f.registration, async () => {
      const repair = await preparedRepair(engine, f);
      const competingBytes = Buffer.from(`${originalBytes.toString('utf8')}\nA competing local file observation.\n`);
      if (mutation === 'file') writeFileSync(f.file, competingBytes);
      else await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage(f.slug, {
        type: f.snapshot.page.type, title: f.snapshot.page.title, compiled_truth: 'A competing database observation.',
        timeline: f.snapshot.page.timeline, frontmatter: f.snapshot.page.frontmatter,
      }, { sourceId: f.id, expectedRevision: f.snapshot.revision })));
      const competingSnapshot = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
      const result = await publishMutation(engine, repair.row, repair.prepared);
      expect(result.state).toBe('conflict');
      expect(result.error_code).toBe(mutation === 'file' ? 'source_changed' : 'revision_conflict');
      expect(readFileSync(f.file)).toEqual(mutation === 'file' ? competingBytes : originalBytes);
      expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(competingSnapshot);
      expect(competingSnapshot.revision === f.snapshot.revision).toBe(mutation === 'file');
      const receipt = (await getWriteRequest(engine, repair.authority.principal, repair.row.request_id))!;
      expect(receipt.recovery).toBeNull();
      expect(receipt.publication_started).toBe(false);
      expect(JSON.parse(readFileSync(join(configDir(), 'reconciliation-previews', repair.reference), 'utf8')).preview.preimages.file_base64).toBe(originalBytes.toString('base64'));
    });
  }
}), 120_000);

test('historical basename origins in separate slug directories remain distinct canonical files', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled), otherSlug = 'other/example', otherFile = join(f.root, 'other/example.md');
    mkdirSync(join(f.root, 'other'), { recursive: true });
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], async () => {
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [f.id, f.slug, 'example.md']);
      await tx.putPage(otherSlug, { type: 'note', title: 'Other example', compiled_truth: 'An independent historical basename page.',
        frontmatter: { independent: true }, source_path: 'example.md' }, { sourceId: f.id });
    }));
    const other = (await engine.readPageSnapshot(otherSlug, { sourceId: f.id }))!;
    writeFileSync(otherFile, serializePageToMarkdown(other.page, other.tags));
    const otherBytes = readFileSync(otherFile);
    await local(engine, f.registration, async () => {
      const result = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      expect(result).toMatchObject({ status: 'ready', relative_path: 'notes/example.md' });
      expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: result.preview, request_id: randomUUID() })).state).toBe('committed');
      expect(readFileSync(otherFile)).toEqual(otherBytes);
      const after = (await engine.readPageSnapshot(otherSlug, { sourceId: f.id }))!;
      expect(after.revision).toBe(other.revision);
      expect(reconcileCanonical(after.page, after.tags)).toEqual(reconcileCanonical(other.page, other.tags));
      expect(after.page.source_path).toBe(other.page.source_path);
    });
  }
}), 120_000);

test('shared provenance URI does not override distinct explicit canonical paths', async () => isolated(async engine => {
  for (const enabled of [false, true]) {
    const f = await fixture(engine, enabled), otherSlug = 'other/provenance', otherFile = join(f.root, 'other/provenance.md');
    const sharedUri = pathToFileURL(f.file).href;
    mkdirSync(join(f.root, 'other'), { recursive: true });
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], async () => {
      await tx.executeRaw('UPDATE pages SET source_uri=$3 WHERE source_id=$1 AND slug=$2', [f.id, f.slug, sharedUri]);
      await tx.putPage(otherSlug, { type: 'note', title: 'Independent provenance', compiled_truth: 'A distinct file sharing ingestion provenance.',
        frontmatter: {}, source_path: 'other/provenance.md', source_uri: sharedUri }, { sourceId: f.id });
    }));
    const other = (await engine.readPageSnapshot(otherSlug, { sourceId: f.id }))!;
    writeFileSync(otherFile, serializePageToMarkdown(other.page, other.tags));
    const otherBytes = readFileSync(otherFile);
    await local(engine, f.registration, async () => {
      const { preview } = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug });
      expect(preview.status).toBe('ready');
      expect((await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview, request_id: randomUUID() })).state).toBe('committed');
      expect(readFileSync(otherFile)).toEqual(otherBytes);
      const after = (await engine.readPageSnapshot(otherSlug, { sourceId: f.id }))!;
      expect(after.revision).toBe(other.revision);
      expect(reconcileCanonical(after.page, after.tags)).toEqual(reconcileCanonical(other.page, other.tags));
      expect(after.page.source_path).toBe(other.page.source_path);
      expect(after.page.source_uri).toBe(sharedUri);
    });
  }
}), 120_000);

test('genuine shared-file origins through explicit paths or URI fallback still refuse reconciliation', async () => isolated(async engine => {
  for (const enabled of [false, true]) for (const origin of ['path', 'dot-path', 'repeated-separators', 'uri']) {
    const f = await fixture(engine, enabled), raw = readFileSync(f.file), uri = pathToFileURL(f.file).href;
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], async () => {
      const sourcePath = origin === 'uri' ? null : origin === 'dot-path' ? './notes/example.md'
        : origin === 'repeated-separators' ? 'notes//example.md' : 'notes/example.md';
      await tx.putPage('other/collision', { type: 'note', title: 'Collision', compiled_truth: 'Another page claiming the same file.',
        frontmatter: {}, source_path: sourcePath, source_uri: origin === 'uri' ? uri : null }, { sourceId: f.id });
    }));
    const snapshot = await engine.readPageSnapshot(f.slug, { sourceId: f.id });
    await local(engine, f.registration, async () => {
      await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({
        code: 'source_changed', message: 'Several pages claim the recorded canonical file.' });
      expect(readFileSync(f.file)).toEqual(raw);
      expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(snapshot);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
    });
  }
}), 120_000);

test('candidate-origin fanout stops at a bounded verification limit rather than scanning the source', async () => isolated(async engine => {
  const f = await fixture(engine), uri = pathToFileURL(f.file).href;
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], async () => {
    await tx.executeRaw('UPDATE pages SET source_uri=$3 WHERE source_id=$1 AND slug=$2', [f.id, f.slug, uri]);
    await tx.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,frontmatter,source_path,source_uri)
      SELECT $1,'other/candidate-'||n,'note','Independent origin','Independent candidate '||n,'{}'::jsonb,'other/candidate-'||n||'.md',$2
      FROM generate_series(1,101) n`, [f.id, uri]);
  }));
  await local(engine, f.registration, async () => {
    await expect(runReconcilePreview(engine, { source_id: f.id, slug: f.slug })).rejects.toMatchObject({
      code: 'source_changed', message: 'Too many candidate page origins to verify this exact file safely.' });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
  });
}), 120_000);
