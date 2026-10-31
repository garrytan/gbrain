/** GBRA-248: doctor owner_host_stale on PGLite: ok with nothing waiting or an own-host owner; warn for writes queued on a foreign owner. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { ownerHostStaleCheck } from '../src/commands/doctor/checks/owner-host-stale.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'owner-host-stale-test';
let engine: PGLiteEngine;
let home: string;
const inHome = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, run);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-owner-stale-'));
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function queuedOn(owner: string): Promise<string> {
  const [tree] = await engine.executeRaw<{ id: string }>("INSERT INTO persistence_worktrees(owner_host_id,heartbeat_at) VALUES($1::uuid,now()-interval '2 days') RETURNING id::text", [owner]);
  await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,(SELECT incarnation FROM sources WHERE id=$1),$2::uuid)
    ON CONFLICT (source_id) DO UPDATE SET worktree_id=EXCLUDED.worktree_id`, [SOURCE, tree!.id]);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,intent,worktree_id)
      VALUES('local_cli','doctor',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),'notes/x',$3,'{}'::jsonb,0,0,'{"content":"x"}'::jsonb,$4::uuid)`, [randomUUID(), SOURCE, randomUUID(), tree!.id]);
  });
  return tree!.id;
}

describe('owner_host_stale', () => {
  test('ok when nothing waits, ok for this host\'s own worktree, warn for a foreign owner', async () => inHome(async () => {
    expect(await ownerHostStaleCheck(engine)).toMatchObject({ name: 'owner_host_stale', status: 'ok', details: { count: 0 } });
    await queuedOn(localHostId());
    expect(await ownerHostStaleCheck(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
    const owner = randomUUID();
    const tree = await queuedOn(owner);
    const check = await ownerHostStaleCheck(engine);
    expect(check).toMatchObject({ status: 'warn', details: { count: 1 } });
    expect((check.details as { stale: unknown[] }).stale[0]).toMatchObject({ worktree_id: tree, owner_host_id: owner, source_ids: [SOURCE], foreign_file_holder: true, open_writes: 1 });
    expect(check.message).toContain('The accept-pending opt-in does not cover these writes');
    expect(check.fix?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--json']);
  }));
});
