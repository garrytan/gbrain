import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { SHARED_SKILLS_SCHEMA_STATEMENTS } from '../src/core/shared-skills/schema.ts';
import { SHARED_SKILLS_MEMBERSHIP_SCHEMA_STATEMENTS } from '../src/core/shared-skills/membership-schema.ts';
import { joinBrain, syncBrain, leaveBrain } from '../src/core/shared-skills/membership.ts';
import { listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { SHARED_SKILLS_DELIVERY_LIMITS, type MembershipSnapshot } from '../src/core/shared-skills/membership-types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import type { SkillMetadata } from '../src/core/shared-skills/model.ts';

let engine: BrainEngine;
let close: () => Promise<void>;
let incarnation: string, policyEpoch: string;
const operations = ['join_brain', 'sync_brain_skills', 'leave_brain', 'list_skills', 'get_skill', 'get_skill_asset'];
const policy = { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true };

beforeAll(async () => {
  if (process.env.MEMBERSHIP_TEST_DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.MEMBERSHIP_TEST_DATABASE_URL);
    engine = isolated.engine; close = isolated.close;
  } else {
    const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engine = local; close = () => local.disconnect();
  }
  for (const statement of [...SHARED_SKILLS_SCHEMA_STATEMENTS, ...SHARED_SKILLS_MEMBERSHIP_SCHEMA_STATEMENTS]) await engine.executeRaw(statement);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('gbrain.writer_quiesced','true',true)");
    await tx.executeRaw('UPDATE persistence_brain SET enabled=true,skill_bundles_enabled=true,writer_protocol_floor=2 WHERE singleton=1');
  });
  await engine.setConfig('mcp.publish_skills', 'true');
}, 120_000);
afterAll(async () => { await close?.(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM shared_skill_members');
  await projectFixture('DELETE FROM shared_skill_heads');
  await engine.executeRaw('DELETE FROM shared_skill_policies');
  await projectFixture("UPDATE sources SET archived=false WHERE id='default'");
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'"); incarnation = source.incarnation;
  policyEpoch = randomUUID();
  await engine.executeRaw('INSERT INTO shared_skill_policies(source_id,source_incarnation,epoch,policy) VALUES($1,$2::uuid,$3::uuid,$4::text::jsonb)', ['default', incarnation, policyEpoch, JSON.stringify(policy)]);
  await publish();
});
async function publish(requirements: string[] = []) {
  const revision = randomUUID();
  const metadata: SkillMetadata = { description: 'Synthetic fixture', triggers: ['fixture'], requirements, private: false,
    audience: ['readers'], writes_pages: false, mutating: false, file_policy: [{ file_class: 'prose', audience: ['readers'] }] };
  await projectFixture(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
    VALUES($1,$2::uuid,$3,$4,$5::uuid,$6::text::jsonb,$7) ON CONFLICT(source_id,source_incarnation,pack_id,name)
    DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata`, ['default', incarnation, 'example', 'fixture', revision,
    JSON.stringify(metadata), policyEpoch]);
  return revision;
}
async function projectFixture(sql: string, params: unknown[] = []) {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('gbrain.write_sources',$1,true)", [JSON.stringify(['default'])]);
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw(sql, params);
    await tx.executeRaw(`INSERT INTO shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision,metadata,files,policy_epoch,request_id)
      SELECT source_id,source_incarnation,pack_id,name,revision,metadata,'[]'::jsonb,policy_epoch,gen_random_uuid() FROM shared_skill_heads
      ON CONFLICT(source_id,source_incarnation,pack_id,name,revision) DO NOTHING`);
  });
}
async function context(scopes = ['read', 'skills_member_self']): Promise<OperationContext> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const created = await provider.registerClientManual(`membership-example-${randomUUID()}`, ['client_credentials'], scopes.join(' '), [], 'default');
  await engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$2::text[] WHERE client_id=$1', [created.clientId, operations]);
  return { engine, config: { engine: 'pglite' }, remote: true, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} },
    auth: { token: '', clientId: created.clientId, principal: { kind: 'oauth_client', id: created.clientId }, scopes, issuedScopes: scopes,
      allowedOperations: operations, sourceId: 'default', allowedSources: ['default'] } };
}
const join = (ctx: OperationContext) => joinBrain(ctx, { adapter: 'codex', follow_policy: { approved: true } });
const params = (snapshot: MembershipSnapshot) => ({ installation_id: snapshot.installation_id, enrollment_epoch: snapshot.enrollment_epoch });
const ack = (snapshot: MembershipSnapshot) => ({ ...params(snapshot), acknowledgment: { batch_token: snapshot.batch_token, view_token: snapshot.view_token,
  evidence: { stage: 'installed' as const, revisions: snapshot.skills } } });

test('catalog readers need not enroll and admin is not self-member authority', async () => {
  const reader = await context(['read']);
  expect((await listSharedSkills(reader)).skills.length).toBe(1);
  await expect(join(reader)).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(join(await context(['admin']))).rejects.toMatchObject({ code: 'permission_denied' });
});

test('server-assigned identities are durable, own-principal only and idempotent for shared credentials', async () => {
  const ctx = await context();
  const [first, second] = await Promise.all([join(ctx), join(ctx)]);
  expect(first.installation_id).toBe(second.installation_id); expect(first.batch_token).toBe(second.batch_token);
  await expect(joinBrain(ctx, { adapter: 'codex', follow_policy: { approved: true }, installation_id: randomUUID() } as any)).rejects.toMatchObject({ code: 'invalid_params' });
  const foreign = await context();
  await expect(syncBrain(foreign, params(first))).rejects.toMatchObject({ code: 'membership_not_found' });
  await expect(leaveBrain(foreign, params(first))).rejects.toMatchObject({ code: 'membership_not_found' });
  const [row] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM shared_skill_members'); expect(row.n).toBe(1);
});

test('future revisions and invented tokens fail; reordered acknowledgments cannot clear newer pending work', async () => {
  const ctx = await context(), first = await join(ctx);
  await expect(syncBrain(ctx, { ...ack(first), acknowledgment: { ...ack(first).acknowledgment, batch_token: randomUUID() } })).rejects.toMatchObject({ code: 'acknowledgment_unavailable' });
  await expect(syncBrain(ctx, { ...ack(first), acknowledgment: { ...ack(first).acknowledgment, evidence: { stage: 'installed', revisions: [{ ...first.skills[0], revision: randomUUID() }] } } })).rejects.toMatchObject({ code: 'invalid_acknowledgment' });
  await publish(); const next = await syncBrain(ctx, params(first));
  expect(next.sequence).toBeGreaterThan(first.sequence);
  const late = await syncBrain(ctx, ack(first)); expect(late.acknowledgment).toBe('historical'); expect(late.delivery.installation).toBe('unverified');
  const current = await syncBrain(ctx, ack(next)); expect(current.acknowledgment).toBe('recorded'); expect(current.delivery.installation).toBe('self_reported');
  expect((await syncBrain(ctx, ack(next))).acknowledgment).toBe('replayed');
  expect((await syncBrain(ctx, ack(first))).sequence).toBe(next.sequence);
});

test('leave prevents late acknowledgments and rejoin advances epoch', async () => {
  const ctx = await context(), first = await join(ctx);
  await leaveBrain(ctx, params(first)); await leaveBrain(ctx, params(first));
  await expect(syncBrain(ctx, ack(first))).rejects.toMatchObject({ code: 'membership_inactive' });
  const next = await join(ctx); expect(next.enrollment_epoch).toBe(first.enrollment_epoch + 1);
  await expect(syncBrain(ctx, ack(first))).rejects.toMatchObject({ code: 'membership_inactive' });
  expect((await syncBrain(ctx, params(next))).delivery.native).toBe('unverified');
});

test('empty enrollment follows later skills under the same approved source policy', async () => {
  const ctx = await context();
  await projectFixture('DELETE FROM shared_skill_heads');
  const empty = await join(ctx); expect(empty.skills).toEqual([]);
  await publish();
  expect((await syncBrain(ctx, params(empty))).skills.length).toBe(1);
});

test('delivery evidence advances monotonically from fetched to installed', async () => {
  const ctx = await context(), first = await join(ctx);
  const fetched = { ...ack(first), acknowledgment: { ...ack(first).acknowledgment, evidence: { stage: 'fetched' as const, revisions: first.skills } } };
  expect((await syncBrain(ctx, fetched)).delivery.installation).toBe('unverified');
  expect((await syncBrain(ctx, ack(first))).delivery.installation).toBe('self_reported');
  await expect(syncBrain(ctx, fetched)).rejects.toMatchObject({ code: 'invalid_acknowledgment' });
});

test('live permission revocation rejects stale auth and source archive is authoritative empty', async () => {
  const ctx = await context(), first = await join(ctx);
  await engine.executeRaw('UPDATE oauth_clients SET scope=$2 WHERE client_id=$1', [ctx.auth!.clientId, 'read']);
  await expect(syncBrain(ctx, params(first))).rejects.toMatchObject({ code: 'permission_denied' });
  await engine.executeRaw('UPDATE oauth_clients SET scope=$2 WHERE client_id=$1', [ctx.auth!.clientId, 'read skills_member_self']);
  await projectFixture("UPDATE sources SET archived=true WHERE id='default'");
  const empty = await syncBrain(ctx, params(first)); expect(empty.complete).toBe(true); expect(empty.skills).toEqual([]);
});

test('requirement, policy and source incarnation changes require renewed approval', async () => {
  const ctx = await context(), first = await join(ctx);
  await publish(['paid-tool']);
  let blocked = await syncBrain(ctx, params(first)); expect(blocked.status).toBe('requirements_changed'); expect(blocked.skills).toEqual([]);
  await publish(); await engine.executeRaw('UPDATE shared_skill_policies SET epoch=$1::uuid', [randomUUID()]);
  blocked = await syncBrain(ctx, params(first)); expect(blocked.status).toBe('requirements_changed');
  const nextIncarnation = randomUUID();
  await projectFixture("UPDATE sources SET incarnation=$1::uuid WHERE id='default'", [nextIncarnation]);
  incarnation = nextIncarnation;
  await engine.executeRaw('INSERT INTO shared_skill_policies(source_id,source_incarnation,epoch,policy) VALUES($1,$2::uuid,$3::uuid,$4::text::jsonb)', ['default', incarnation, policyEpoch, JSON.stringify(policy)]);
  await publish();
  blocked = await syncBrain(ctx, params(first)); expect(blocked.skills).toEqual([]); expect(blocked.blocked_skills[0].source_incarnation).toBe(nextIncarnation);
});

test('concurrent leave and acknowledgment cannot reactivate an enrollment', async () => {
  const ctx = await context(), first = await join(ctx);
  const results = await Promise.allSettled([syncBrain(ctx, ack(first)), leaveBrain(ctx, params(first))]);
  expect(results[1].status).toBe('fulfilled');
  const [row] = await engine.executeRaw<{ active: boolean }>('SELECT active FROM shared_skill_members WHERE installation_id=$1::uuid', [first.installation_id]);
  expect(row.active).toBe(false);
  await expect(syncBrain(ctx, params(first))).rejects.toMatchObject({ code: 'membership_inactive' });
});

test('failed enumeration never issues an empty replacement delivery batch', async () => {
  const ctx = await context(), first = await join(ctx);
  await engine.executeRaw('ALTER TABLE shared_skill_heads RENAME TO unavailable_fixture_heads');
  try {
    await expect(syncBrain(ctx, params(first))).rejects.toMatchObject({ code: 'catalog_unavailable' });
    const [row] = await engine.executeRaw<{ issued_sequence: number }>('SELECT issued_sequence FROM shared_skill_members WHERE installation_id=$1::uuid', [first.installation_id]);
    expect(Number(row.issued_sequence)).toBe(first.sequence);
  } finally { await engine.executeRaw('ALTER TABLE unavailable_fixture_heads RENAME TO shared_skill_heads'); }
});

test('serving epoch invalidates issued batches after recovery without asserting native use', async () => {
  const ctx = await context(), first = await join(ctx);
  await engine.executeRaw('UPDATE shared_skill_state SET serving_epoch=$1::uuid', [randomUUID()]);
  await expect(syncBrain(ctx, ack(first))).rejects.toMatchObject({ code: 'invalid_acknowledgment' });
  expect((await syncBrain(ctx, params(first))).batch_token).not.toBe(first.batch_token);
});

test('membership rejoin and issued batch history are bounded', async () => {
  const ctx = await context(); let current = await join(ctx);
  for (let i = 1; i < 10; i++) { await leaveBrain(ctx, params(current)); current = await join(ctx); }
  await leaveBrain(ctx, params(current)); await expect(join(ctx)).rejects.toMatchObject({ code: 'rate_limited' });
  const other = await context(); current = await join(other);
  const first = current;
  let recent = current;
  for (let i = 1; i < 75; i++) { recent = current; await publish(); current = await syncBrain(other, params(current)); }
  const [retained] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid', [current.installation_id]);
  expect(retained.n).toBe(SHARED_SKILLS_DELIVERY_LIMITS.retainedBatches);
  await expect(syncBrain(other, ack(first))).rejects.toMatchObject({ code: 'acknowledgment_unavailable' });
  expect((await syncBrain(other, ack(recent))).acknowledgment).toBe('historical');
  expect((await syncBrain(other, params(current))).delivery.installation).toBe('unverified');
  expect((await syncBrain(other, ack(current))).acknowledgment).toBe('recorded');
  expect((await syncBrain(other, ack(current))).acknowledgment).toBe('replayed');
  expect((await syncBrain(other, params(current))).sequence).toBe(current.sequence);
});

test('expired delivery acknowledgments require a fresh batch without advancing receipts', async () => {
  const ctx = await context(), first = await join(ctx);
  await engine.executeRaw("UPDATE shared_skill_delivery_batches SET issued_at=now()-interval '25 hours' WHERE token=$1::uuid", [first.batch_token]);
  await expect(syncBrain(ctx, ack(first))).rejects.toMatchObject({ code: 'acknowledgment_unavailable' });
  const next = await syncBrain(ctx, params(first));
  expect(next.batch_token).not.toBe(first.batch_token);
  expect(next.delivery.installation).toBe('unverified');
});

test('one thousand skills enumerate and acknowledge completely, while capacity overflow preserves the prior batch', async () => {
  const ctx = await context();
  await projectFixture(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
    SELECT h.source_id,h.source_incarnation,h.pack_id,'fixture-'||g,gen_random_uuid(),h.metadata,h.policy_epoch
    FROM shared_skill_heads h CROSS JOIN generate_series(1,999) g WHERE h.name='fixture'`);
  const first = await join(ctx);
  expect(first.skills.length).toBe(1000);
  expect(new Set(first.skills.map(skill => skill.name)).size).toBe(1000);
  expect((await syncBrain(ctx, ack(first))).delivery.installation).toBe('self_reported');
  await projectFixture(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
    SELECT source_id,source_incarnation,pack_id,'fixture-overflow',gen_random_uuid(),metadata,policy_epoch FROM shared_skill_heads WHERE name='fixture'`);
  await expect(syncBrain(ctx, params(first))).rejects.toMatchObject({ code: 'catalog_capacity_exceeded' });
  const [row] = await engine.executeRaw<{ issued_sequence: number }>('SELECT issued_sequence FROM shared_skill_members WHERE installation_id=$1::uuid', [first.installation_id]);
  expect(Number(row.issued_sequence)).toBe(first.sequence);
});

test('catalog metadata bytes are bounded independently of skill count', async () => {
  const ctx = await context(), first = await join(ctx);
  await projectFixture(`UPDATE shared_skill_heads SET metadata=jsonb_set(metadata,'{description}',to_jsonb($1::text))`, ['x'.repeat(SHARED_SKILLS_DELIVERY_LIMITS.metadataBytes)]);
  await expect(syncBrain(ctx, params(first))).rejects.toMatchObject({ code: 'catalog_capacity_exceeded' });
  const [row] = await engine.executeRaw<{ issued_sequence: number }>('SELECT issued_sequence FROM shared_skill_members WHERE installation_id=$1::uuid', [first.installation_id]);
  expect(Number(row.issued_sequence)).toBe(first.sequence);
});

test('a revision removed before lease issuance returns typed unavailable without advancing the member', async () => {
  const ctx = await context(), first = await join(ctx);
  const nextRevision = await publish();
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('gbrain.write_sources',$1,true)", [JSON.stringify(['default'])]);
    await tx.executeRaw('DELETE FROM shared_skill_revisions WHERE revision=$1::uuid', [nextRevision]);
  });
  await expect(syncBrain(ctx, params(first))).rejects.toMatchObject({ code: 'catalog_unavailable' });
  const [row] = await engine.executeRaw<{ issued_sequence: number }>('SELECT issued_sequence FROM shared_skill_members WHERE installation_id=$1::uuid', [first.installation_id]);
  expect(Number(row.issued_sequence)).toBe(first.sequence);
});
