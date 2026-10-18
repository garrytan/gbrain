/**
 * A withdrawal-mirror effect recovery whose canonical file was edited between the mirror's file write and its database commit
 * refuses `unexpected_file_bytes` and retains its record: only the user resolving the file clears it. The head probe used to
 * classify every effect recovery as live, so a sync behind it waited the whole no-progress window (5 minutes) before stopping.
 * Such a recovery is now intervention-required: the drain stops `drain_stalled` / `cause: head_blocked` after one governor tick
 * with a fix naming the file and running the `gbrain repair stuck-recovery` preview of the effect (GBRA-130 C-1: its `--keep withdrawn` is the exit).
 * A recovery that can still finish forward (the file holds a recorded version) keeps the wait.
 * A page write's own publication recovery refused the same way (#6650) stops the same way, its fix pointing at
 * `gbrain repair stuck-recovery`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { upsertFactRow } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { headClaimability } from '../src/core/persistence/head-blocker.ts';
import { drainNext, engineStallProbe, formatDrainSummary, runDrain } from '../src/core/persistence/sync-drain.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { recoverPublication } from '../src/core/persistence/coordinator.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { AFTER, EDITED, PRIOR, stuckRecoveryFixture } from './helpers/stuck-recovery-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const hostId = localHostId();
const config = { engine: 'pglite' as const, embedding_disabled: true };
const roots: string[] = [];
const engines: Array<[string, BrainEngine]> = [];
let closePostgres: (() => Promise<void>) | undefined;
const done: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0,
  pagesAffected: [], managedCursor: { index: 1, total: 1 } };
const body = upsertFactRow('Stable prose', { claim: 'Withdraw this claim', kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium' }).body;
const EDIT = 'An edit the user made while the withdrawal was being mirrored\n';

beforeAll(async () => {
  if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(['pglite', lite]); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(['postgres', pg.engine]); closePostgres = pg.close; }
  for (const [, engine] of engines) await registerLocalWriter(engine, 'cli');
}, 120_000);
afterAll(async () => {
  for (const [kind, engine] of engines) if (kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A source whose page carries one fact, withdrawn, with its mirror crashed between the file write and the commit, and a queued write behind it. */
async function crashedMirror(engine: BrainEngine) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-mirror-blocked-')); roots.push(root);
  const sourceId = `mirror-${randomUUID().slice(0, 8)}`, slug = 'page';
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, hostId);
  await engine.putPage(slug, { type: 'note', title: 'Example', compiled_truth: body.trim(), timeline: '', frontmatter: {} }, { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  const admit = () => admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, sourceIncarnation: binding.source_incarnation,
    slug, pageId: snapshot.page.id, requestId: randomUUID(), callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: binding.worktree_id,
    topologyGeneration: binding.topology_generation });
  const withdrawal = await admit();
  const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,source,visibility)
    VALUES($1,$2,'Withdraw this claim','test conversation','world') RETURNING id`, [sourceId, slug]);
  await engine.transaction(async tx => {
    await recordFactWithdrawal(tx, Number(fact.id), sourceId, false, { requestId: withdrawal.id });
    await completeWrite(tx, withdrawal, 'committed', { status: 'forgotten' });
  });
  const only = async () => {
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id<>$1::uuid OR kind<>'withdrawal-mirror'", [withdrawal.id]);
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='withdrawal-mirror'", [withdrawal.id]);
  };
  await only();
  let crashed = false;
  await runPersistenceEffects(engine, config, { hostId, limit: 1, boundary: async name => { if (name === 'after_mirror_file') { crashed = true; throw new Error('process ended before commit'); } } });
  expect(crashed).toBe(true);
  const [effect] = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_effects WHERE request_id=$1::uuid AND kind='withdrawal-mirror' AND recovery IS NOT NULL", [withdrawal.id]);
  expect(effect).toBeDefined();
  const published = readFileSync(file, 'utf8');
  const head = await admit();
  const [row] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [head.request_id]);
  return { sourceId, slug, file, published, effectId: effect!.id, withdrawalRequestId: withdrawal.request_id, head: { id: row!.id, request_id: head.request_id },
    recover: async () => { await only(); await runPersistenceEffects(engine, config, { hostId, limit: 1 }); },
    /** Runs the mirror until it settles (after its recovery it requeues to finish its scan). */
    settle: async () => {
      for (let pass = 0; pass < 5; pass++) {
        await only(); await runPersistenceEffects(engine, config, { hostId, limit: 1 });
        const [left] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE id=$1 AND (recovery IS NOT NULL OR state IN ('queued','running'))", [effect!.id]);
        if (!Number(left!.n)) return;
      }
    } };
}

describe('withdrawal-mirror effect recovery blocking a sync', () => {
  test('a recovery that can finish forward is live: not intervention-required, and the drain keeps waiting', async () => {
    for (const [kind, engine] of engines) {
      const f = await crashedMirror(engine);
      expect(await headClaimability(engine, { id: f.head.id, state: 'queued' }, hostId), kind)
        .toMatchObject({ claimable_here: false, blocked_by: { predicate: 'effect_recovery', ids: [f.effectId], intervention: false } });
      let reads = 0;
      const probe = engineStallProbe(engine, f.sourceId), head = probe.head!;
      const result = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 60_000, probe: { ...probe, head: async () => { reads++; return head(); } },
        pass: () => new Promise<SyncResult>(resolve => setTimeout(() => resolve(done), 400)) });
      expect(reads, kind).toBeGreaterThanOrEqual(3);
      expect(result.drain, kind).toMatchObject({ outcome: 'synced' });
      await f.settle();
      expect(await headClaimability(engine, { id: f.head.id, state: 'queued' }, hostId), kind).toEqual({ claimable_here: true, blocked_by: null });
    }
  }, 60_000);

  test('a file edited during the mirror stops the sync at once with a coded fix naming the file; restoring the file clears it', async () => {
    for (const [kind, engine] of engines) {
      const f = await crashedMirror(engine);
      writeFileSync(f.file, EDIT);
      await f.recover();
      expect(readFileSync(f.file, 'utf8'), kind).toBe(EDIT);
      const [effect] = await engine.executeRaw<{ error_code: string | null; recovering: boolean }>('SELECT error_code, recovery IS NOT NULL AS recovering FROM persistence_effects WHERE id=$1', [f.effectId]);
      expect(effect, kind).toMatchObject({ error_code: 'unexpected_file_bytes', recovering: true });

      const started = Date.now();
      const result = await runDrain({ governMs: 20, noProgressMs: 10_000, publicationCeilingMs: 60_000, probe: engineStallProbe(engine, f.sourceId),
        pass: () => new Promise<SyncResult>(() => undefined) });
      const elapsed = Date.now() - started;
      expect(result.drain, kind).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'head_blocked', in_pass: true, head_request_id: f.head.id,
        claimable_here: false, blocked_by: { predicate: 'effect_recovery', ids: [f.effectId], state: 'unexpected_file_bytes', intervention: true, file: { slug: f.slug, path: f.file } } } });
      expect(elapsed, kind).toBeLessThan(5_000);
      const resume = `gbrain sync --source ${f.sourceId}`;
      const next = drainNext(result, resume, f.sourceId)!;
      const preview = ['gbrain', 'repair', 'stuck-recovery', '--source', f.sourceId, '--request-id', f.withdrawalRequestId];
      expect(next, kind).toMatchObject({ code: 'drain_stalled', cause: 'head_blocked', safe_to_loop: false, docs: 'docs/guides/write-refusals.md#head-blocked',
        command: preview.join(' '), fix: { actor: 'agent', next: 'run', argv: preview } });
      expect(next.why, kind).toContain(f.file);
      expect(next.fix!.user_message, kind).toContain(f.file);
      expect(next.fix!.user_message, kind).toContain(resume);
      expect(next.fix!.user_message, kind).toContain(preview.join(' '));
      expect(formatDrainSummary(result, resume, f.sourceId).join('\n'), kind).toContain(`blocked_by=effect_recovery(unexpected_file_bytes ${f.effectId})`);
      const status = await readWriterDiagnostics(engine);
      const row = (status.blockers as Array<Record<string, unknown>>).find(b => b.request_id === f.head.request_id)!;
      expect(row, kind).toMatchObject({ claimable_here: false, blocked_by: { predicate: 'effect_recovery', intervention: true } });
      expect(String(row.next_action), kind).toContain(f.file);

      // The file back on a recorded version: the recovery can finish forward again, so the head is live before the next retry runs.
      writeFileSync(f.file, f.published);
      expect(await headClaimability(engine, { id: f.head.id, state: 'queued' }, hostId), kind)
        .toMatchObject({ claimable_here: false, blocked_by: { predicate: 'effect_recovery', intervention: false } });
      await f.settle();
      expect(readFileSync(f.file, 'utf8'), kind).toBe(f.published);
      expect(await headClaimability(engine, { id: f.head.id, state: 'queued' }, hostId), kind).toEqual({ claimable_here: true, blocked_by: null });
    }
  }, 120_000);
});

describe('page-write request recovery blocking a sync', () => {
  test('a request recovery refusing unexpected_file_bytes stops the sync at once and points at gbrain repair stuck-recovery; undoing the edit clears it', async () => {
    for (const [kind, engine] of engines) {
      const s = await stuckRecoveryFixture(engine, roots).stuck({ prior: PRIOR, after: AFTER, disk: EDITED, follower: true });
      const started = Date.now();
      const result = await runDrain({ governMs: 20, noProgressMs: 10_000, publicationCeilingMs: 60_000, probe: engineStallProbe(engine, s.sourceId),
        pass: () => new Promise<SyncResult>(() => undefined) });
      const elapsed = Date.now() - started;
      const blockedBy = { predicate: 'request_recovery', ids: [s.requestId], state: 'unexpected_file_bytes', intervention: true, file: { slug: 'page', path: s.path } };
      expect(result.drain, kind).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled',
        stall: { cause: 'head_blocked', in_pass: true, head_request_id: s.id, head_state: 'recovering', claimable_here: false, blocked_by: blockedBy } });
      expect(elapsed, kind).toBeLessThan(5_000);
      const resume = `gbrain sync --source ${s.sourceId}`, preview = ['gbrain', 'repair', 'stuck-recovery', '--source', s.sourceId];
      const next = drainNext(result, resume, s.sourceId)!;
      expect(next, kind).toMatchObject({ code: 'drain_stalled', cause: 'head_blocked', safe_to_loop: false, command: preview.join(' '),
        fix: { actor: 'agent', next: 'run', argv: preview } });
      expect(next.why, kind).toContain(s.path);
      expect(next.fix!.user_message, kind).toContain(s.path);
      expect(next.fix!.user_message, kind).toContain(resume);
      expect(next.fix!.user_message, kind).toContain(preview.join(' '));
      expect(formatDrainSummary(result, resume, s.sourceId).join('\n'), kind).toContain(`blocked_by=request_recovery(unexpected_file_bytes ${s.requestId})`);

      // The queued write behind it is classified the same way, and writer status names the preview.
      expect(await headClaimability(engine, { id: s.follower!, state: 'queued' }, hostId), kind).toMatchObject({ claimable_here: false, blocked_by: blockedBy });
      const follower = (await getWriteRequestById(engine, s.follower!))!;
      const status = await readWriterDiagnostics(engine);
      const row = (status.blockers as Array<Record<string, unknown>>).find(b => b.request_id === follower.request_id)!;
      expect(row, kind).toMatchObject({ claimable_here: false, blocked_by: { predicate: 'request_recovery', intervention: true } });
      expect(String(row.next_action), kind).toContain(preview.join(' '));

      // Undoing the edit makes the recovery live again before its next pass: the drain keeps waiting, then the pass finishes it.
      writeFileSync(s.path, PRIOR);
      expect(await headClaimability(engine, { id: s.follower!, state: 'queued' }, hostId), kind)
        .toMatchObject({ claimable_here: false, blocked_by: { predicate: 'request_recovery', intervention: false } });
      let reads = 0;
      const probe = engineStallProbe(engine, s.sourceId), head = probe.head!;
      const waited = await runDrain({ governMs: 10, noProgressMs: 60_000, publicationCeilingMs: 60_000, probe: { ...probe, head: async () => { reads++; return head(); } },
        pass: () => new Promise<SyncResult>(resolve => setTimeout(() => resolve(done), 400)) });
      expect(reads, kind).toBeGreaterThanOrEqual(3);
      expect(waited.drain, kind).toMatchObject({ outcome: 'synced' });
      expect(await recoverPublication(engine, s.id), kind).toMatchObject({ state: 'queued', blocked_reason: null });
    }
  }, 120_000);
});
