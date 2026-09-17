import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { tryAcquirePoolLongHold } from '../src/core/pool-budget.ts';
import { tryAcquirePublicationCapacity } from '../src/core/persistence/pool-capacity.ts';
import { claimWorktree, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, prepareRecovery, completeWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { recoverPublication } from '../src/core/persistence/coordinator.ts';
import { reserveEffectRecovery } from '../src/core/persistence/effect-recovery.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import type { PersistenceEffect } from '../src/core/persistence/effect-model.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-recovery-capacity-'));
const engines: BrainEngine[] = [];
const roots: string[] = [];
const hostId = randomUUID();
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(isolated.engine); closePostgres = isolated.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect(); await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function fixture(engine: BrainEngine) {
  const sourceId = `capacity-${randomUUID().slice(0, 20)}`;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-capacity-root-')); roots.push(root);
  const path = join(root, 'page.md'); writeFileSync(path, 'Before');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, hostId);
  const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
    'put_page', sourceId, binding.source_incarnation, 'page');
  const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug: 'page', worktreeId: binding.worktree_id,
    topologyGeneration: binding.topology_generation, callerIntent: { content: 'After' }, intent: { content: 'After' } });
  return { sourceId, root, path, binding, row };
}

/** Occupy all permitted long holds, leaving the actual last Postgres connection free. */
async function occupy(engine: BrainEngine): Promise<() => Promise<void>> {
  const releases = [tryAcquirePublicationCapacity(engine)];
  if (engine.kind === 'postgres') releases.push(tryAcquirePublicationCapacity(engine), tryAcquirePoolLongHold((engine as PostgresEngine).sql));
  expect(releases.every(Boolean)).toBe(true);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const holds: Promise<void>[] = [];
  const ready: Promise<void>[] = [];
  if (engine.kind === 'postgres') for (const _ of releases) {
    let started!: () => void;
    ready.push(new Promise<void>(resolve => { started = resolve; }));
    holds.push(engine.transaction(async tx => { await tx.executeRaw('SELECT 1'); started(); await gate; }));
  }
  await Promise.all(ready);
  return async () => { finish(); await Promise.all(holds); for (const release of releases) release?.(); };
}

test('standalone page and withdrawal recovery respect occupied pool capacity and retain a control connection', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    await registerLocalWriter(engine, 'cli');
    const canonical = await fixture(engine);
    const row = (await claimNextWrite(engine, hostId))!; expect(row.id).toBe(canonical.row.id);
    let lock = await acquireWorktree(canonical.binding); expect(lock).not.toBeNull();
    try {
      await prepareRecovery(engine, row, { version: 1, path: canonical.path, root: canonical.root,
        before: Buffer.from('Before').toString('base64'), beforeHash: sha256('Before'), afterHash: sha256('After'),
        mode: 0o600, ownerEpoch: String(canonical.binding.owner_epoch), attempt: row.execution_token! }, 4096);
    } finally { await lock?.release(); }
    writeFileSync(canonical.path, 'After'); // interrupted publication before its DB commit
    const mirror = await fixture(engine);
    await engine.putPage('page', { type: 'note', title: 'Example', compiled_truth: 'Sanitized effective body', timeline: '', frontmatter: {} }, { sourceId: mirror.sourceId });
    const snapshot = (await engine.readPageSnapshot('page', { sourceId: mirror.sourceId }))!;
    await engine.transaction(tx => completeWrite(tx, mirror.row, 'committed', {}));
    const [effect] = await engine.executeRaw<PersistenceEffect>(`INSERT INTO persistence_effects
      (request_id,kind,revision,data,source_id,source_incarnation,worktree_id,state,execution_token)
      VALUES($1::uuid,'withdrawal-mirror',$2::uuid,'{"source_scan":true}',$3,$4::uuid,$5::uuid,'running',$6::uuid) RETURNING *`,
    [mirror.row.id, snapshot.revision, mirror.sourceId, mirror.binding.source_incarnation, mirror.binding.worktree_id, randomUUID()]);
    const after = serializePageToMarkdown(snapshot.page, snapshot.tags);
    lock = await acquireWorktree(mirror.binding); expect(lock).not.toBeNull();
    try {
      await reserveEffectRecovery(engine, effect, { version: 1, kind: 'withdrawal-mirror', path: mirror.path, root: mirror.root,
        beforeHash: sha256('Before'), afterHash: sha256(after), after: Buffer.from(after).toString('base64'), mode: 0o600,
        ownerEpoch: String(mirror.binding.owner_epoch), pageId: snapshot.page.id, sourceIncarnation: snapshot.sourceIncarnation,
        slug: 'page', revision: snapshot.revision }, 4096, hostId);
    } finally { await lock?.release(); }
    const release = await occupy(engine);
    try {
      expect((await recoverPublication(engine, row.id, hostId)).blocked_reason).toBe('writer_pool_capacity');
      await runPersistenceEffects(engine, { engine: engine.kind }, { hostId, limit: 1 });
      expect(readFileSync(canonical.path, 'utf8')).toBe('After'); expect(readFileSync(mirror.path, 'utf8')).toBe('Before');
      expect((await getWriteRequestById(engine, row.id))!.recovery).not.toBeNull();
      const [blocked] = await engine.executeRaw<{ error_code: string; recovering: boolean }>('SELECT error_code,recovery IS NOT NULL AS recovering FROM persistence_effects WHERE id=$1', [effect.id]);
      expect(blocked).toMatchObject({ error_code: 'writer_pool_capacity', recovering: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rows = await Promise.race([engine.executeRaw('SELECT 42 AS answer'), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The reserved control connection was exhausted')), 2000); })]);
        expect(rows).toEqual([{ answer: 42 }]);
      } finally { if (timer) clearTimeout(timer); }
    } finally { await release(); }
    expect((await recoverPublication(engine, row.id, hostId)).recovery).toBeNull(); expect(readFileSync(canonical.path, 'utf8')).toBe('Before');
    await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effect.id]);
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId, limit: 1 });
    expect(readFileSync(mirror.path, 'utf8')).toBe(after);
    expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE id=$1 AND recovery IS NOT NULL', [effect.id])).toHaveLength(0);
  }
}), 120_000);
