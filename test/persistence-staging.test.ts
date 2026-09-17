import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL } from '../src/core/persistence/schema.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree, acquireWorktree, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, completeWrite, clearResolvedRecovery, getWriteRequestById, prepareRecovery } from '../src/core/persistence/journal.ts';
import { publishMutation, recoverPublication } from '../src/core/persistence/coordinator.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { reserveEffectRecovery, recoverEffectPublication } from '../src/core/persistence/effect-recovery.ts';
import type { EffectRecovery, PersistenceEffect } from '../src/core/persistence/effect-model.ts';
import { recoveryStagingFile } from '../src/core/persistence/staging.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

interface Fixture { engine: BrainEngine; sourceId: string; root: string; path: string; binding: WorktreeBinding }
const fixtures: Fixture[][] = [];
const engines: BrainEngine[] = [];
let hostId: string;
let home: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-staging-tests-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    hostId = localHostId();
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
    if (process.env.DATABASE_URL) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close;
    }
    for (const engine of engines) {
      const cases: Fixture[] = [];
      for (let i = 0; i < 9; i++) {
        const sourceId = `staging-case-${i}`;
        const root = join(home, `${engine.kind}-${i}`); mkdirSync(root);
        const path = join(root, 'page.md'); writeFileSync(path, 'original');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        const binding = await claimWorktree(engine, sourceId, root, hostId);
        cases.push({ engine, sourceId, root, path, binding });
      }
      await registerLocalWriter(engine, 'cli');
      await activatePersistence(engine, { confirmQuiesced: true });
      fixtures.push(cases);
    }
  });
}, 120_000);
afterAll(async () => {
  for (const engine of engines.filter(engine => engine.kind === 'pglite')) await engine.disconnect();
  await closePostgres?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function accepted(f: Fixture) {
  const authority = await submissionAuthority({ engine: f.engine, remote: false, sourceId: f.sourceId } as OperationContext,
    'put_page', f.sourceId, f.binding.source_incarnation, 'page');
  const current = await f.engine.readPageSnapshot('page', { sourceId: f.sourceId });
  const input = { principal: authority.principal, authority, operation: 'put_page', sourceId: f.sourceId,
    sourceIncarnation: f.binding.source_incarnation, slug: 'page', worktreeId: f.binding.worktree_id,
    topologyGeneration: f.binding.topology_generation, pageId: current?.page.id ?? null,
    callerIntent: { content: 'replacement' }, intent: { content: 'replacement' } };
  const row = await admitWrite(f.engine, input);
  const claimed = (await claimNextWrite(f.engine, hostId))!; expect(claimed.id).toBe(row.id);
  const prepared = { observedRevision: current?.revision ?? null, file: { path: f.path, root: f.root, content: 'replacement' },
    apply: async (tx: BrainEngine) => {
      await tx.putPage('page', { type: 'note', title: 'Stage example', compiled_truth: 'replacement', frontmatter: {} }, { sourceId: f.sourceId });
      return { slug: 'page' };
    } };
  return { row: claimed, prepared };
}
function temporaryFiles(f: Fixture) { return readdirSync(f.root).filter(name => name.includes('.tmp.')); }
async function bytes(f: Fixture) {
  const [row] = await f.engine.executeRaw<{ recovery_bytes: string }>('SELECT recovery_bytes FROM persistence_counters WHERE key=$1', [`worktree:${f.binding.worktree_id}`]);
  return Number(row.recovery_bytes);
}

test('journaled flush failure removes owned stage and releases accounting only after rollback', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const cases of fixtures) {
    const f = cases[0]; const { row, prepared } = await accepted(f);
    let stage: string | undefined;
    const done = await publishMutation(f.engine, row, prepared, hostId, {
      boundary: async name => {
        if (name !== 'prepared') return;
        const saved = (await getWriteRequestById(f.engine, row.id))!;
        stage = saved.recovery!.staging!.publication!.path;
        expect(existsSync(stage)).toBe(false); expect(await bytes(f)).toBeGreaterThan(0);
      },
      stagingFlushed: () => {
        expect(readFileSync(stage!, 'utf8')).toBe('replacement');
        expect(readFileSync(f.path, 'utf8')).toBe('original');
        throw new Error('fixture flushed write failed');
      },
    });
    expect(done.state).toBe('failed'); expect(temporaryFiles(f)).toEqual([]);
    expect(readFileSync(f.path, 'utf8')).toBe('original'); expect(await bytes(f)).toBe(0);
    expect(await f.engine.readPageSnapshot('page', { sourceId: f.sourceId })).toBeNull();
  }
}));

for (const [index, suffix] of [[7, ['page.md']], [8, ['missing', 'page.md']]] as const) {
  test(`blocked file ancestor settles failed publication and releases its worktree (${index})`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const cases of fixtures) {
      const f = cases[index]; const { row, prepared } = await accepted(f);
      const blocker = join(f.root, 'blocked'); writeFileSync(blocker, 'preserved blocker');
      prepared.file.path = join(blocker, ...suffix);
      let reserved = false;
      const done = await publishMutation(f.engine, row, prepared, hostId, { boundary: async name => {
        if (name !== 'prepared') return;
        reserved = true;
        expect((await getWriteRequestById(f.engine, row.id))!.recovery!.beforeHash).toBeNull();
        expect(await bytes(f)).toBeGreaterThan(0);
      } });
      expect(reserved).toBe(true);
      expect(done).toMatchObject({ state: 'failed', error_code: 'storage_error', recovery: null });
      expect(readFileSync(blocker, 'utf8')).toBe('preserved blocker');
      expect(readFileSync(f.path, 'utf8')).toBe('original');
      expect(await f.engine.readPageSnapshot('page', { sourceId: f.sourceId })).toBeNull();
      expect(await bytes(f)).toBe(0);
      const retained = await getWriteRequestById(f.engine, row.id);
      const next = await accepted(f);
      expect((await publishMutation(f.engine, next.row, next.prepared, hostId)).state).toBe('committed');
      expect(await getWriteRequestById(f.engine, row.id)).toEqual(retained);
      expect(readFileSync(blocker, 'utf8')).toBe('preserved blocker');
      expect(await bytes(f)).toBe(0);
    }
  }));
}

for (const [index, unexpected] of [[1, 'rep'], [2, 'unknown bytes']] as const) {
  test(`unexpected/partial staging is retained without releasing recovery capacity (${index})`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const cases of fixtures) {
      const f = cases[index]; const { row, prepared } = await accepted(f); let stage = '';
      const done = await publishMutation(f.engine, row, prepared, hostId, { boundary: async name => {
        if (name !== 'prepared') return;
        stage = (await getWriteRequestById(f.engine, row.id))!.recovery!.staging!.publication!.path;
        writeFileSync(stage, unexpected); throw new Error('fixture stage collision');
      } });
      expect(done.state).toBe('recovering'); expect(done.blocked_reason).toBe('unexpected_staging_bytes');
      const reserved = await bytes(f); expect(reserved).toBeGreaterThan(0);
      expect((await recoverPublication(f.engine, row.id, hostId)).blocked_reason).toBe('unexpected_staging_bytes');
      expect(readFileSync(stage, 'utf8')).toBe(unexpected); expect(await bytes(f)).toBe(reserved);
      expect(readFileSync(f.path, 'utf8')).toBe('original');
      writeFileSync(stage, 'replacement'); // Explicit fixture repair to exactly known attempted bytes.
      expect((await recoverPublication(f.engine, row.id, hostId)).state).toBe('failed');
      expect(temporaryFiles(f)).toEqual([]); expect(await bytes(f)).toBe(0);
    }
  }));
}

test('terminal recovery survives index upgrade and fences its worktree until staging cleanup completes', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const cases of fixtures) {
    const f = cases[3]; const { row, prepared } = await accepted(f); let stage = '';
    const done = await publishMutation(f.engine, row, prepared, hostId, { boundary: async name => {
      if (name !== 'after_commit') return;
      stage = (await getWriteRequestById(f.engine, row.id))!.recovery!.staging!.publication!.path;
      writeFileSync(stage, 'unexpected committed-stage bytes'); throw new Error('fixture lost response');
    } });
    expect(done.state).toBe('committed'); expect(done.blocked_reason).toBe('unexpected_staging_bytes');
    const outcome = done.outcome; const reserved = await bytes(f); expect(reserved).toBeGreaterThan(0);
    await expect(clearResolvedRecovery(f.engine, row.id)).rejects.toMatchObject({ code: 'unexpected_staging_bytes' });
    const indexDefinition = async () => {
      const [index] = await f.engine.executeRaw<{ definition: string; valid: boolean }>(`SELECT pg_get_indexdef(indexrelid) AS definition,
        indisvalid AS valid FROM pg_index WHERE indexrelid=to_regclass('persistence_requests_recovery')`);
      expect(index?.valid).toBe(true);
      expect(index?.definition).toContain('(worktree_id, sequence)');
      expect(index?.definition).toContain('WHERE (recovery IS NOT NULL)');
    };
    await indexDefinition();
    const retained = await getWriteRequestById(f.engine, row.id);
    const counters = await f.engine.executeRaw('SELECT * FROM persistence_counters ORDER BY key');
    await f.engine.executeRaw('DROP INDEX persistence_requests_recovery');
    await f.engine.setConfig('version', '158');
    const upgraded = await runMigrations(f.engine);
    expect(upgraded.applied).toBeGreaterThanOrEqual(1); expect(upgraded.current).toBe(LATEST_VERSION);
    await indexDefinition();
    // Bootstrap composition and migration share an idempotent index definition.
    await f.engine.executeRaw(PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL);
    expect(await getWriteRequestById(f.engine, row.id)).toEqual(retained);
    expect(await f.engine.executeRaw('SELECT * FROM persistence_counters ORDER BY key')).toEqual(counters);
    const authority = await submissionAuthority({ engine: f.engine, remote: false, sourceId: f.sourceId } as OperationContext,
      'put_page', f.sourceId, f.binding.source_incarnation, 'follower');
    const follower = await admitWrite(f.engine, { principal: authority.principal, authority, operation: 'put_page',
      sourceId: f.sourceId, sourceIncarnation: f.binding.source_incarnation, slug: 'follower',
      worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation,
      callerIntent: { content: 'following update' }, intent: { content: 'following update' } });
    expect(await claimNextWrite(f.engine, hostId)).toBeNull();
    expect((await getWriteRequestById(f.engine, follower.id))!.state).toBe('queued');
    const healthy = cases[6]; const independent = await accepted(healthy);
    expect((await publishMutation(healthy.engine, independent.row, independent.prepared, hostId)).state).toBe('committed');
    expect(readFileSync(healthy.path, 'utf8')).toBe('replacement');
    expect((await getWriteRequestById(f.engine, follower.id))!.state).toBe('queued');

    // A stale/direct publication attempt must repeat the fence under native
    // exclusion even when it did not enter through the current claim query.
    const [staleClaim] = await f.engine.executeRaw<typeof row>(`UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+interval '30 seconds' WHERE id=$1::uuid RETURNING *`,
    [follower.id, randomUUID()]);
    let applied = false;
    const followerPath = join(f.root, 'follower.md');
    const followerPrepared = { observedRevision: null, file: { path: followerPath, root: f.root, content: 'following update' },
      apply: async (tx: BrainEngine) => {
        applied = true;
        await tx.putPage('follower', { type: 'note', title: 'Follower example', compiled_truth: 'following update', frontmatter: {} }, { sourceId: f.sourceId });
        return { slug: 'follower' };
      } };
    expect(await publishMutation(f.engine, staleClaim, followerPrepared, hostId)).toMatchObject({ state: 'queued', blocked_reason: 'recovery_required' });
    expect(applied).toBe(false); expect(existsSync(followerPath)).toBe(false);
    expect(await bytes(f)).toBe(reserved);
    expect((await getWriteRequestById(f.engine, row.id))!.outcome).toEqual(outcome);
    writeFileSync(stage, 'replacement');
    const lock = await acquireWorktree(f.binding); expect(lock).not.toBeNull();
    try {
      expect((await recoverPublication(f.engine, row.id, hostId)).recovery).not.toBeNull();
      expect(existsSync(stage)).toBe(true); expect(await bytes(f)).toBe(reserved);
    } finally { await lock!.release(); }
    const recovered = await recoverPublication(f.engine, row.id, hostId);
    expect(recovered.state).toBe('committed'); expect(recovered.outcome).toEqual(outcome);
    expect(readFileSync(f.path, 'utf8')).toBe('replacement'); expect(temporaryFiles(f)).toEqual([]);
    expect(await bytes(f)).toBe(0); expect((await getWriteRequestById(f.engine, row.id))!.recovery).toBeNull();
    const next = (await claimNextWrite(f.engine, hostId))!; expect(next.id).toBe(follower.id);
    expect((await publishMutation(f.engine, next, followerPrepared, hostId)).state).toBe('committed');
    expect(applied).toBe(true); expect(readFileSync(followerPath, 'utf8')).toBe('following update');
    expect((await f.engine.readPageSnapshot('follower', { sourceId: f.sourceId }))!.page.compiled_truth).toBe('following update');
    expect(await bytes(f)).toBe(0);
  }
}));

test('legacy recovery gains durable restoration staging before rewriting the old file', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const cases of fixtures) {
    const f = cases[4]; const { row } = await accepted(f);
    await prepareRecovery(f.engine, row, { version: 1, path: f.path, root: f.root, before: Buffer.from('original').toString('base64'),
      beforeHash: sha256('original'), afterHash: sha256('replacement'), mode: 0o600, ownerEpoch: String(f.binding.owner_epoch), attempt: row.execution_token! }, 4096);
    writeFileSync(f.path, 'replacement');
    const recovered = await recoverPublication(f.engine, row.id, hostId);
    expect(recovered.state).toBe('queued'); expect(recovered.recovery).toBeNull();
    expect(readFileSync(f.path, 'utf8')).toBe('original'); expect(temporaryFiles(f)).toEqual([]); expect(await bytes(f)).toBe(0);
    await f.engine.transaction(tx => completeWrite(tx, recovered, 'cancelled', {}));
  }
}));

test('withdrawal mirror staging preserves unexpected bytes and only finishes forward', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const cases of fixtures) {
    const f = cases[5]; const { row } = await accepted(f);
    await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.putPage('page',
      { type: 'note', title: 'Withdrawn example', compiled_truth: 'Current sanitized content.', frontmatter: {} }, { sourceId: f.sourceId })));
    const snapshot = (await f.engine.readPageSnapshot('page', { sourceId: f.sourceId }))!;
    await f.engine.transaction(tx => completeWrite(tx, row, 'committed', { revision: snapshot.revision }));
    const [effect] = await f.engine.executeRaw<PersistenceEffect>(`INSERT INTO persistence_effects
      (request_id,kind,revision,data,source_id,source_incarnation,worktree_id,state,execution_token)
      VALUES($1::uuid,'withdrawal-mirror',$2::uuid,'{"source_scan":true}',$3,$4::uuid,$5::uuid,'running',$6::uuid) RETURNING *`,
    [row.id, snapshot.revision, f.sourceId, f.binding.source_incarnation, f.binding.worktree_id, randomUUID()]);
    const after = serializePageToMarkdown(snapshot.page, snapshot.tags);
    const record: EffectRecovery = { version: 1, kind: 'withdrawal-mirror', path: f.path, root: f.root,
      beforeHash: sha256('original'), afterHash: sha256(after), after: Buffer.from(after).toString('base64'), mode: 0o600,
      ownerEpoch: String(f.binding.owner_epoch), pageId: snapshot.page.id, sourceIncarnation: snapshot.sourceIncarnation,
      slug: 'page', revision: snapshot.revision, staging: { publication: recoveryStagingFile(f.path, after) } };
    const lock = await acquireWorktree(f.binding); expect(lock).not.toBeNull();
    try {
      await reserveEffectRecovery(f.engine, effect, record, 8192, hostId);
      writeFileSync(record.staging!.publication!.path, 'Unexpected mirror fragment.');
      await expect(recoverEffectPublication(f.engine, effect, hostId)).rejects.toMatchObject({ code: 'unexpected_staging_bytes' });
      expect(await bytes(f)).toBe(8192); expect(readFileSync(f.path, 'utf8')).toBe('original');
      unlinkSync(record.staging!.publication!.path); // Remove only this fixture's deliberate unexpected file.
      await recoverEffectPublication(f.engine, effect, hostId);
      expect(readFileSync(f.path, 'utf8')).toBe(after); expect(temporaryFiles(f)).toEqual([]); expect(await bytes(f)).toBe(0);
      expect((await f.engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.revision).toBe(snapshot.revision);
      expect((await getWriteRequestById(f.engine, row.id))!.state).toBe('committed');
    } finally { await lock!.release(); }
  }
}));
