import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectSharedMemberMigration } from '../src/core/shared-skills/migration-members.ts';

let engine: PGLiteEngine;
let brainId: string;
let incarnation: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  brainId = brain.brain_id; incarnation = source.incarnation;
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('migration reports each known member stage without inventing native verification', async () => {
  const id = randomUUID();
  await engine.executeRaw(`INSERT INTO shared_skill_members(installation_id,principal_kind,principal_id,adapter,brain_id,follow_policy)
    VALUES($1::uuid,'oauth_client','migration-example','codex',$2::uuid,$3::text::jsonb)`,
  [id, brainId, JSON.stringify({ sources: { default: incarnation } })]);
  expect(await inspectSharedMemberMigration(engine, 'hidden', incarnation)).toEqual([]);
  expect((await inspectSharedMemberMigration(engine, 'default', incarnation))[0]).toMatchObject({ installation_id: id, state: 'joined', native_activation: 'unverified' });
  await engine.executeRaw('UPDATE shared_skill_members SET desired_view=$2 WHERE installation_id=$1::uuid', [id, 'issued-view']);
  expect((await inspectSharedMemberMigration(engine, 'default', incarnation))[0].state).toBe('refresh_pending');
  await engine.executeRaw(`INSERT INTO shared_skill_delivery_batches(token,installation_id,epoch,sequence,view_token,authority_digest,revisions,evidence,acknowledged_at)
    VALUES($1::uuid,$2::uuid,1,1,'issued-view','fixture','[]'::jsonb,'{"stage":"installed"}'::jsonb,now())`, [randomUUID(), id]);
  await engine.executeRaw("UPDATE shared_skill_members SET acknowledged_view='issued-view',acknowledged_sequence=1 WHERE installation_id=$1::uuid", [id]);
  const installed = (await inspectSharedMemberMigration(engine, 'default', incarnation))[0];
  expect(installed.state).toBe('delivery_reported'); expect(installed.native_activation).toBe('unverified');
  expect((await inspectSharedMemberMigration(engine, 'default', randomUUID()))[0].state).toBe('source_changed');
  await engine.executeRaw('UPDATE shared_skill_members SET active=false WHERE installation_id=$1::uuid', [id]);
  expect((await inspectSharedMemberMigration(engine, 'default', incarnation))[0].state).toBe('left');
});
