/**
 * #6650 (L3): `gbrain sync status` summarizes the source's terminal write receipts.
 *
 * Protects: the status carries `terminal_failures` (active blockers apart from the unresolved pile and the historical
 * rows, with the drill-down command); a receipt still holding a recovery record is an active blocker and becomes
 * `next` when nothing else is; the human output prints the counts, each BLOCKING receipt and the drill-down; another
 * source's receipts never leak in. A managed-sync cursor waiting at its checkpoint step behind a failed page receipt
 * is an active blocker in the aggregate, in doctor and in sync status. PGLite in-memory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import { withEnv } from './helpers/with-env.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readCheckpointBlockerMap, readTerminalFailureSummary } from '../src/core/persistence/terminal-failures.ts';
import { terminalFailuresCheck } from '../src/commands/doctor/checks/persistence-requests.ts';

const SOURCE = 'status-src';
const OTHER = 'status-other';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2)', [SOURCE, OTHER]);
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM persistence_requests'); });

async function seed(o: { source?: string; slug: string; state: string; code?: string | null; detail?: unknown; recovery?: unknown; hoursAgo?: number; build?: string }) {
  const requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
      state,error_code,error_message,error_detail,recovery,intent,completed_at,updated_at,admitter_version)
    VALUES('local_cli','fixture',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,$5,$6,'x',$7::text::jsonb,$8::text::jsonb,'{"content":"x"}'::jsonb,
      now()-($9::double precision*interval '1 hour'),now()-($9::double precision*interval '1 hour'),$10)`,
  [requestId, o.source ?? SOURCE, o.slug, randomUUID(), o.state, o.code ?? null, o.detail === undefined ? null : JSON.stringify(o.detail),
    o.recovery === undefined ? null : JSON.stringify(o.recovery), o.hoursAgo ?? 1, o.build ?? '0.60.216.0']);
  return requestId;
}

async function human(sourceId: string): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  // #6712 PR 2 (L5): the terminal summary is a heavy read a plain status skips; these assertions read it with --detail.
  try { await withEnv({ GBRAIN_SOURCE: undefined }, () => runSyncStatus(engine, ['--source', sourceId, '--detail'])); } finally { console.log = log; }
  return lines.join('\n');
}

describe('sync status terminal_failures', () => {
  test('a clean source reports zero and next stays nothing', async () => {
    const status = await readSyncStatus(engine, SOURCE);
    expect(status.terminal_failures).toMatchObject({ status: 'ok', window_days: 7, active_blockers: [], unresolved: { rows: 0 }, historical_rows: 0, new_last_24h: 0, defects: 0 });
    expect(status.next).toBeNull();
    const out = await human(SOURCE);
    expect(out).toContain('terminal write failures (last 7 d): 0 active blocker(s), 0 unresolved');
    expect(out).not.toContain('drill down:');
  });

  test('separates the blocker, the unresolved pile and history, and names the blocker as next', async () => {
    const held = await seed({ slug: 'notes/held', state: 'committed', recovery: { version: 1, path: '/nonexistent/x.md', root: '/nonexistent', beforeHash: null, afterHash: 'a' } });
    await seed({ slug: 'notes/a', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception', error_class: 'TypeError' } });
    await seed({ slug: 'notes/b', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception', error_class: 'TypeError' } });
    // A pre-fix knock-on from an older build is history, not a pile to work.
    await seed({ slug: 'notes/old', state: 'cancelled', code: 'storage_error', detail: { origin: 'sync_knock_on', knock_on: 'window_predecessor' }, build: '0.60.200.0' });
    await seed({ source: OTHER, slug: 'notes/elsewhere', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception' } });

    const status = await readSyncStatus(engine, SOURCE);
    const t = status.terminal_failures;
    if (t.status !== 'ok') throw new Error('expected a finished summary');
    expect(t.active_blockers).toEqual([{ kind: 'recovery', request_id: held, slug: 'notes/held', category: 'recovery_pending' }]);
    expect(t.unresolved).toMatchObject({ rows: 2, distinct_slugs: 2 });
    expect(t.defects).toBe(2);
    expect(t.drill_down).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE, '--group-by', 'category', '--json']);
    expect(status.next).not.toBeNull();
    expect(status.next!.argv).toEqual(['gbrain', 'sync', '--source', SOURCE, '--no-pull', '--json']);
    expect(status.next!.why).toContain('publication recovery record');

    const out = await human(SOURCE);
    expect(out).toContain('1 active blocker(s), 2 unresolved (2 page(s)');
    expect(out).toContain('2 gbrain-defect row(s)');
    expect(out).toContain(`BLOCKING recovery: request ${held} (notes/held) [recovery_pending]`);
    expect(out).toContain(`drill down: gbrain sources writer failures ${SOURCE} --group-by category --json`);
    expect(out).not.toContain('notes/elsewhere');
  });
});

describe('a cursor waiting at its checkpoint step', () => {
  const MANAGED = 'status-managed';
  test('its blocking receipt is an active checkpoint blocker in the aggregate, doctor and sync status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-6650-checkpoint-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
        const root = join(home, MANAGED);
        mkdirSync(root);
        execFileSync('git', ['-C', root, 'init', '-q']);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [MANAGED, root]);
        await claimWorktree(engine, MANAGED, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const binding = (await getWorktreeBinding(engine, MANAGED))!;
        const runId = randomUUID(), blocker = randomUUID();
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          // Page 2 of the run failed and nothing committed at its index, so the run's checkpoint cannot commit.
          await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,
              terminal_reservation,state,error_code,error_message,error_detail,intent,completed_at,updated_at,admitter_version,worktree_id)
            VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,(SELECT incarnation FROM sources WHERE id=$2),'notes/two',$3,'{}'::jsonb,0,0,'failed','storage_error','x',
              '{"origin":"owner_exception"}'::jsonb,$4::text::jsonb,now()-interval '1 hour',now()-interval '1 hour','0.60.218.0',$5::uuid)`,
          [blocker, MANAGED, randomUUID(), JSON.stringify({ kind: 'managed_sync_import', runId, index: 2 }), binding.worktree_id]);
        });
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [MANAGED]);
        await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`, [`fp-${runId}`, JSON.stringify([{
          runId, sourceId: MANAGED, incarnation: source!.incarnation, index: 3, total: 3, target: 'a'.repeat(40), binding: { worktree_id: binding.worktree_id },
          pending: { requestId: randomUUID(), intent: { kind: 'managed_sync_checkpoint' } } }])]);

        const map = await readCheckpointBlockerMap(engine, [MANAGED]);
        expect(map.get(MANAGED)?.map(b => b.request_id)).toEqual([blocker]);
        const summary = await readTerminalFailureSummary(engine, { sourceIds: [MANAGED], checkpointBlockers: map });
        if (summary.status !== 'ok') throw new Error('unknown');
        expect(summary.sources[0]!.active_blockers).toEqual([expect.objectContaining({ kind: 'checkpoint', request_id: blocker, slug: 'notes/two', category: 'checkpoint_blocker' })]);

        const check = (await terminalFailuresCheck(engine, [MANAGED]))!;
        expect(check.status).toBe('warn');
        expect(check.message).toContain(`checkpoint blocker ${blocker} (notes/two) on source ${MANAGED}`);

        const status = await readSyncStatus(engine, MANAGED);
        expect(status.checkpoint_blockers?.map(b => b.request_id)).toEqual([blocker]);
        if (status.terminal_failures.status !== 'ok') throw new Error('unknown');
        expect(status.terminal_failures.active_blockers).toEqual([{ kind: 'checkpoint', request_id: blocker, slug: 'notes/two', category: 'checkpoint_blocker' }]);
        expect(await human(MANAGED)).toContain(`BLOCKING checkpoint: request ${blocker} (notes/two) [checkpoint_blocker]`);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
