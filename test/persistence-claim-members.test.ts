/**
 * The lane head claim, the reclaim of a released write and the effect recovery claim on PGLite: the typed members
 * (`selectClaimableLaneHead`, `stampLaneHeadClaim`, `reclaimReleasedWrite`, `claimEffectRecovery`) send the statements
 * `claimNextLaneHead`, `reclaimReleasedWrite` and `claimAndRecoverEffect` used to send through executeRaw
 * (test/persistence-journal-statements.test.ts pins their text). The rows are seeded with SQL, so this also covers the one
 * thing no three-arm case can: an effect that holds a recovery record, which only a raw-SQL engine can write today.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimNextLaneHead, reclaimReleasedWrite } from '../src/core/persistence/journal.ts';
import { claimAndRecoverEffect } from '../src/core/persistence/effects.ts';
import { effectClaimStamp } from '../src/core/persistence/effect-journal.ts';

const SOURCE = 'claim-members-test';
const RUN = 'run-1';
let engine: PGLiteEngine;
const host = randomUUID();
let tree: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  [{ id: tree }] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,state) VALUES($1::uuid,'active') RETURNING id::text", [host]) as [{ id: string }];
  await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,(SELECT incarnation FROM sources WHERE id=$1),$2::uuid)`, [SOURCE, tree]);
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function queue(intent: Record<string, unknown>, extra = ''): Promise<{ id: string; request_id: string }> {
  const request_id = randomUUID();
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    const [row] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,intent,worktree_id)
      VALUES('local_cli','claims',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,$5::text::jsonb,$6::uuid) RETURNING id::text`,
    [request_id, SOURCE, `notes/${request_id.slice(0, 8)}`, randomUUID(), JSON.stringify({ ...intent, ...(intent.lane ? { group: request_id } : {}) }), tree]);
    if (extra) await tx.executeRaw(extra, [row!.id]);
    return { id: row!.id, request_id };
  });
}

describe('the claim members on PGLite', () => {
  test('the lane head is claimed once, in order, with the newest sequence', async () => {
    const first = await queue({ kind: 'managed_sync_import', lane: RUN });
    const second = await queue({ kind: 'managed_sync_import', lane: RUN });
    const claimed = await claimNextLaneHead(engine, host, tree, RUN, 30_000, null);
    expect(claimed).toMatchObject({ id: first.id, state: 'running' });
    expect(claimed!.execution_token).toBeTruthy();
    const [newest] = await engine.executeRaw<{ seen: string }>('SELECT max(sequence)::text AS seen FROM persistence_requests');
    expect(claimed!.seen_sequence).toBe(newest!.seen);
    expect(await claimNextLaneHead(engine, host, tree, RUN, 30_000, null)).toMatchObject({ id: second.id });
    expect(await claimNextLaneHead(engine, host, tree, RUN, 30_000, null)).toBeNull();
    expect(await claimNextLaneHead(engine, randomUUID(), tree, RUN, 30_000, null)).toBeNull();
  });

  test('a released write is reclaimed only past its backoff', async () => {
    const waiting = await queue({ kind: 'put_page' }, "UPDATE persistence_requests SET next_attempt_at=now()+interval '1 hour' WHERE id=$1::uuid");
    expect(await reclaimReleasedWrite(engine, waiting.id)).toBeNull();
    await engine.executeRaw('UPDATE persistence_requests SET next_attempt_at=now() WHERE id=$1::uuid', [waiting.id]);
    expect(await reclaimReleasedWrite(engine, waiting.id)).toMatchObject({ id: waiting.id, state: 'running', blocked_reason: null });
    expect(await reclaimReleasedWrite(engine, waiting.id)).toBeNull();
  });

  test('an effect is claimed for recovery only while it holds a recovery record', async () => {
    const request = await queue({ kind: 'put_page' });
    const [effect] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
      VALUES($1::uuid,'withdrawal-mirror','{}'::jsonb,$2,(SELECT incarnation FROM sources WHERE id=$2),$3::uuid) RETURNING id::text`, [request.id, SOURCE, tree]);
    const token = randomUUID();
    expect(await engine.claimEffectRecovery({ id: effect!.id, token, ownerJson: effectClaimStamp(token) })).toBeNull();
    expect(await claimAndRecoverEffect(engine, effect!.id, host)).toBeUndefined();
    await engine.executeRaw(`UPDATE persistence_effects SET recovery='{"version":1}'::jsonb WHERE id=$1`, [effect!.id]);
    const claimed = await engine.claimEffectRecovery<{ state: string; attempts: number; execution_token: string }>({ id: effect!.id, token, ownerJson: effectClaimStamp(token) });
    expect(claimed).toMatchObject({ state: 'running', attempts: 1, execution_token: token });
  });
});
