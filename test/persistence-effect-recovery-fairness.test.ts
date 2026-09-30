import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { claimWorktree, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, completeWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { upsertFactRow } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
for (const kind of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) {
  describe(kind, () => {
    let scratch: string;
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-effect-fairness-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else {
        const local = new PGLiteEngine(); engine = local;
        await local.connect({}); await local.initSchema();
      }
    }, 120_000);
    afterAll(async () => {
      if (close) await close();
      else await engine?.disconnect();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    test('mirror recovery passes held roots and revisits them after cursor wrap', async () => withEnv({ GBRAIN_HOME: scratch }, async () => {
      const locks: NonNullable<Awaited<ReturnType<typeof acquireWorktree>>>[] = [];
      try {
        await registerLocalWriter(engine, 'cli');
        const hostId = localHostId(), config = { engine: engine.kind, embedding_disabled: true };
        const fixtures = [];
        for (let index = 0; index < 3; index++) {
          const root = join(scratch, `root-${index}`); mkdirSync(root);
          const sourceId = `effect-fairness-${randomUUID()}`;
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
          const binding = await claimWorktree(engine, sourceId, root, hostId);
          const body = upsertFactRow('Stable prose', { claim: 'Withdraw this claim', kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium' }).body;
          await engine.putPage('page', { type: 'note', title: 'Example', compiled_truth: body.trim(), timeline: '', frontmatter: {} }, { sourceId });
          const snapshot = (await engine.readPageSnapshot('page', { sourceId }))!;
          const file = join(root, 'page.md'); writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
          const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
          const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, 'page');
          const request = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
            sourceIncarnation: binding.source_incarnation, slug: 'page', pageId: snapshot.page.id, requestId: randomUUID(),
            callerIntent: { withdraw: true }, intent: { withdraw: true }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
          const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,source,visibility)
            VALUES($1,'page','Withdraw this claim','test conversation','world') RETURNING id`, [sourceId]);
          await engine.transaction(async tx => {
            await recordFactWithdrawal(tx, Number(fact.id), sourceId, false, { requestId: request.id });
            await completeWrite(tx, request, 'committed', { status: 'forgotten' });
          });
          await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
          await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='withdrawal-mirror'", [request.id]);
          let interrupted = false;
          await runPersistenceEffects(engine, config, { hostId, limit: 1, boundary: async name => {
            if (name === 'after_mirror_file') { interrupted = true; throw new Error('fixture interruption after mirror rename'); }
          } });
          expect(interrupted).toBe(true);
          const [effect] = await engine.executeRaw<{ id: string; recovery_bytes: string }>("SELECT id,recovery_bytes FROM persistence_effects WHERE request_id=$1::uuid AND recovery IS NOT NULL", [request.id]);
          expect(Number(effect.recovery_bytes)).toBeGreaterThan(0);
          fixtures.push({ binding, request, effectId: effect.id, file, bytes: readFileSync(file, 'utf8'),
            revision: (await engine.readPageSnapshot('page', { sourceId }))!.revision });
        }
        // Hold the entire first page of the recovery query with actual kernel locks.
        for (const fixture of fixtures.slice(0, 2)) {
          const lock = await acquireWorktree(fixture.binding); expect(lock).not.toBeNull(); locks.push(lock!);
        }
        await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE recovery IS NOT NULL');
        await runPersistenceEffects(engine, config, { hostId, limit: 2 });
        await runPersistenceEffects(engine, config, { hostId, limit: 2 });
        expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE id=$1 AND recovery IS NOT NULL', [fixtures[2].effectId])).toHaveLength(0);
        for (const fixture of fixtures.slice(0, 2)) {
          expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE id=$1 AND recovery IS NOT NULL', [fixture.effectId])).toHaveLength(1);
          const [counter] = await engine.executeRaw<{ recovery_bytes: string }>('SELECT recovery_bytes FROM persistence_counters WHERE key=$1', [`worktree:${fixture.binding.worktree_id}`]);
          expect(Number(counter.recovery_bytes)).toBeGreaterThan(0);
        }
        for (const lock of locks.splice(0)) await lock.release();
        await runPersistenceEffects(engine, config, { hostId, limit: 2 });
        expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE recovery IS NOT NULL')).toHaveLength(0);
        const [brain] = await engine.executeRaw<{ recovery_bytes: string; outstanding_count: string; lifetime_ids: string }>("SELECT recovery_bytes,outstanding_count,lifetime_ids FROM persistence_counters WHERE key='brain'");
        expect(Number(brain.recovery_bytes)).toBe(0);
        expect(Number(brain.outstanding_count)).toBe(0);
        expect(Number(brain.lifetime_ids)).toBe(3);
        for (const fixture of fixtures) {
          expect((await getWriteRequestById(engine, fixture.request.id))!.state).toBe('committed');
          expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.bytes);
          expect((await engine.readPageSnapshot('page', { sourceId: fixture.binding.source_id }))!.revision).toBe(fixture.revision);
        }
      } finally {
        for (const lock of locks) await lock.release();
      }
    }), 120_000);
  });
}
