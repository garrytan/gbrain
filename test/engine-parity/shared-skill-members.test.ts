/**
 * BrainEngine parity — shared-skill membership (engine-sql/shared-skill-members.ts): the catalog identity, the
 * follow-source and policy reads, the member rows join_brain, sync_brain_skills and leave_brain read and write, and
 * the delivery batches they issue and acknowledge.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: join_brain enrolls one member per principal and adapter under the persistent brain id, re-activates
 *    it at the next epoch with its sequences reset, and only narrows an active member's follow policy;
 *    sync_brain_skills issues one batch per view (a repeat sync reuses it), records an acknowledgment once, replays
 *    the same evidence and refuses a batch from another epoch; leave_brain ends only the current epoch. Every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts) gives the
 *    same answers. A stored publication policy and a stored head bind a source on every arm, a new batch leases each
 *    revision it names, a refused issue changes nothing (its prune included), and a malformed uuid fails with 22P02.
 *    writeSharedSkillRevision refuses on a brain without shared publication (42501 writer_not_quiesced) on every arm.
 *    Shared publication activates under the same quiescence rules (a queued request refuses writer_not_quiesced), and
 *    put_skill then gives the same receipt, get_skill and join_brain answers. Each arm writes the canonical
 *    skills/<name>/SKILL.md and skillpack.json, so a second put_skill of the same skill publishes against them with
 *    the same answer and leaves the same SKILL.md bytes.
 *  - Regression: these reads and writes ran through executeRaw, so on a Rust brain join_brain ended in
 *    engine_capability_missing at the brain-id lock, and sync_brain_skills and leave_brain could never reach a member.
 *    Each filter is an access cut: a case puts the row a dropped clause would let through (another principal's
 *    member, a batch from another epoch or another installation, a batch older than 24 hours, an archived source)
 *    where the result shows it.
 *  - Why existing coverage misses it: shared-skills tests run on PGLite only; access-grants.test.ts runs membership
 *    of an unknown installation, which stops before any member row.
 *  - Seam: GBRAIN_HOME through withEnv (the local writer registration lives under it). Generated values (ids,
 *    tokens, timestamps) are reduced to their shape in the returned values.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSource, createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { SharedSkillBatchIssue, SharedSkillRevisionWrite } from '../../src/core/engine-sql/shared-skill-members.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { getSharedSkillPolicy, setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import { getSharedSkill } from '../../src/core/shared-skills/catalog.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { brainMembershipOperations } from '../../src/core/ops/brain-membership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { cancelWriteRequest } from '../../src/core/persistence/control.ts';
import { submitSharedSkillMutation } from '../../src/core/shared-skills/publication.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const A = 'd0000000-0000-4000-8000-0000000000a1';
const B = 'd0000000-0000-4000-8000-0000000000b2';
const UNKNOWN = 'd0000000-0000-4000-8000-0000000000f9';
const POLICY = { source_ids: null, sources: {}, requirements: {} };

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-shared-skill-members-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function local(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

/** The handler's answer, or the code it refused with. */
async function answer(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<any> {
  const op = brainMembershipOperations.find(o => o.name === name)!;
  try { return { ok: await op.handler(local(engine), params) }; }
  catch (error) { return { code: (error as { code?: string }).code ?? String(error) }; }
}

/** `value` with every UUID, timestamp and Date replaced by its kind, so two runs compare equal. */
function generic(value: unknown, drop: readonly string[] = []): unknown {
  if (value instanceof Date) return '<date>';
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? '<date>' : value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  }
  if (Array.isArray(value)) return value.map(v => generic(v, drop));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, generic(v, drop)]));
  }
  return value;
}

/** A sync or join result reduced to what does not vary between runs. */
function shape(r: any) {
  if (!r.ok) return r;
  const o = r.ok;
  return { status: o.status, complete: o.complete, epoch: o.enrollment_epoch, sequence: o.sequence, skills: o.skills.length,
    blocked: o.blocked_skills.length, installation: o.delivery.installation, ack: o.acknowledgment ?? null,
    ids: UUID.test(o.installation_id) && UUID.test(o.batch_token) && UUID.test(o.brain_id) };
}

/** Fixture: the arm reset empties the shared_skill_state singleton a brain gets at schema install; put it back. */
async function installSingletons(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  if (backend === 'rust') return;
  await engine.executeRaw('INSERT INTO trust_policy_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await engine.executeRaw('INSERT INTO shared_skill_state(singleton) VALUES(1) ON CONFLICT DO NOTHING');
}

async function enroll(engine: BrainEngine, installationId: string, principalId: string, adapter = 'generic'): Promise<void> {
  const brainId = (await engine.transaction(tx => tx.lockSharedSkillBrainId()))!;
  await engine.enrollSharedSkillMember({ installationId, principalKind: 'local_writer', principalId, adapter, brainId, followPolicy: POLICY });
}

const REVISION = 'e0000000-0000-4000-8000-0000000000c1';
const OTHER_REVISION = 'e0000000-0000-4000-8000-0000000000c3';
const BODY = '---\nname: notes\ndescription: Take notes.\n---\nTake notes.\n';

/** One published skill revision: a SKILL.md of class prose for readers. */
function skillRevision(incarnation: string, policyEpoch: string, revision = REVISION): SharedSkillRevisionWrite {
  const file = { path: 'skills/notes/SKILL.md', file_class: 'prose' as const, audience: ['readers'], media_type: 'text/markdown', size: Buffer.byteLength(BODY),
    sha256: createHash('sha256').update(BODY).digest('hex'), depends_on: [], content: Buffer.from(BODY).toString('base64') };
  return { sourceId: 'default', incarnation, packId: 'pack', name: 'notes', revision, deleted: false, policyEpoch, requestId: 'e0000000-0000-4000-8000-0000000000c2',
    metadata: { description: 'Take notes.', triggers: [], requirements: [], private: false, audience: ['readers'], writes_pages: false, mutating: false,
      file_policy: [{ file_class: 'prose', audience: ['readers'] }], tools_declared: false },
    files: [file] };
}

/**
 * Fixture: store a revision and its head. The SQL arms write it under the publication guard (no arm here activates
 * shared publication); the Rust arm writes it to the store, since its engine member refuses as that guard does.
 */
async function seedRevision(engine: BrainEngine, backend: ParityBackend, write: SharedSkillRevisionWrite): Promise<void> {
  if (backend === 'rust') { await (engine as unknown as RustEngine).openStore('seedRevision').brain.writeSharedSkillRevision(write); return; }
  await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.writeSharedSkillRevision(write);
  });
}

function issueSpec(over: Partial<SharedSkillBatchIssue>): SharedSkillBatchIssue {
  return { installationId: A, epoch: 1, issuedSequence: 0, viewToken: 'v1', authorityDigest: 'auth', revisions: [], token: crypto.randomUUID(),
    retainedBatches: 32, ...over };
}

/**
 * Fixture: give the default source a fresh canonical root and run `fn` with shared publication possible. The SQL arms
 * also claim the root's worktree (a Rust brain has none). The arm reset keeps the persistence_brain row, so the SQL
 * arms put its publication columns back afterwards under replica role (the floor trigger refuses a lower floor).
 */
async function withCanonicalRoot<T>(engine: BrainEngine, backend: ParityBackend, fn: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-parity-skill-root-')));
  try {
    await engine.attachSourcePath('default', root);
    if (backend !== 'rust') {
      // The arm reset empties config; activation reads the schema version a fresh SQL brain records there.
      await engine.setConfig('version', String(LATEST_VERSION));
      await claimWorktree(engine, 'default', root);
    }
    return await fn(root);
  } finally {
    await disposePersistenceConsumer(engine);
    if (backend !== 'rust') await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      await tx.executeRaw('UPDATE persistence_brain SET skill_bundles_enabled=false, writer_protocol_floor=1, enabled=false WHERE singleton=1');
    });
    rmSync(root, { recursive: true, force: true });
  }
}

/** The answer of `run`, or its refusal reduced to the code, the message and the first line of the suggestion. */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try { return { ok: await run() }; }
  catch (error) {
    const e = error as { code?: string; message?: string; suggestion?: string };
    return { code: e.code, message: e.message, suggestion: e.suggestion ?? null };
  }
}

describe('engine parity: shared-skill membership', () => {
  parityTest('the catalog identity is the brain id, a 64-hex token secret and the serving epoch; an empty brain has no heads and no stored policy, and a written policy reads back', {
    methods: ['readSharedSkillCatalogIdentity', 'readPersistenceBrainId', 'readSharedSkillServingEpoch', 'lockSharedSkillBrainId', 'listSharedSkillCatalogHeads',
      'readSharedSkillPolicyRow', 'writeSharedSkillPolicy', 'readSourceMembership', 'transaction'],
  }, async (engine, backend) => {
    await installSingletons(engine, backend);
    const first = await engine.readSharedSkillCatalogIdentity();
    const second = await engine.readSharedSkillCatalogIdentity();
    const brainId = await engine.readPersistenceBrainId();
    const locked = await engine.transaction(tx => tx.lockSharedSkillBrainId());
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const result = {
      brain: first?.brain_id === brainId && UUID.test(String(brainId)) && locked === brainId,
      secret: /^[0-9a-f]{64}$/.test(first?.token_secret ?? ''),
      epoch: first?.serving_epoch === await engine.readSharedSkillServingEpoch(),
      stable: JSON.stringify(first) === JSON.stringify(second),
      heads: await engine.listSharedSkillCatalogHeads({ sourceIds: null, limit: 101, sourceId: null, sourceIncarnation: null, packId: null, name: null, hidePrivate: true }),
      policy: await engine.readSharedSkillPolicyRow('default', incarnation, false) ?? null,
      locked: await engine.transaction(tx => tx.readSharedSkillPolicyRow('default', incarnation, true)) ?? null,
    };
    expect(result).toEqual({ brain: true, secret: true, epoch: true, stable: true, heads: [], policy: null, locked: null });
    // A policy the engine writes is the row it then reads back, on every arm.
    const written = { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true };
    await engine.transaction(tx => tx.writeSharedSkillPolicy({ sourceId: 'default', incarnation, epoch: 'f0000000-0000-4000-8000-0000000000e1', policy: written,
      principalKind: 'local_cli', principalId: 'parity', previousEpoch: 'consent-required' }));
    const stored = await engine.readSharedSkillPolicyRow('default', incarnation, false) ?? null;
    expect(stored).toEqual({ epoch: 'f0000000-0000-4000-8000-0000000000e1', policy: written });
    return { ...result, stored };
  });

  parityTest('the follow sources are the live sources in both lists, by id; an archived source never binds', {
    methods: ['listSharedSkillFollowSources', 'readSourceMembership'],
  }, async (engine, backend) => {
    for (const id of ['gamma', 'alpha', 'beta']) await createSource(engine, backend, id);
    await archiveSource(engine, backend, 'beta');
    const ids = async (allowed: string[] | null, sourceIds: string[] | null) => (await engine.listSharedSkillFollowSources(allowed, sourceIds)).map(r => r.id);
    const rows = await engine.listSharedSkillFollowSources(null, null);
    const result = {
      all: rows.map(r => r.id),
      incarnations: rows.every(r => UUID.test(r.incarnation)) && rows[0]!.incarnation === (await engine.readSourceMembership('alpha'))!.incarnation,
      allowed: await ids(['beta', 'default', 'alpha'], null),
      named: await ids(null, ['gamma', 'beta', 'missing']),
      both: await ids(['alpha', 'gamma'], ['gamma', 'default']),
      disjoint: await ids(['alpha'], ['gamma']),
    };
    expect(result).toEqual({ all: ['alpha', 'default', 'gamma'], incarnations: true, allowed: ['alpha', 'default'], named: ['gamma'], both: ['gamma'], disjoint: [] });
    return result;
  });

  parityTest('a member reads only under its own principal; a re-enroll moves to the next epoch with its sequences reset', {
    methods: ['lockSharedSkillBrainId', 'enrollSharedSkillMember', 'readSharedSkillMember', 'countSharedSkillMembers', 'rebindSharedSkillMember',
      'leaveSharedSkillMember', 'issueSharedSkillDeliveryBatch', 'transaction'],
  }, async (engine) => {
    const empty = await engine.countSharedSkillMembers();
    await enroll(engine, A, 'writer-a');
    await enroll(engine, B, 'writer-b');
    const own = await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-a' });
    const reduce = (m: any) => m && ({ installation: m.installation_id, principal: `${m.principal_kind}:${m.principal_id}`, adapter: m.adapter, epoch: m.epoch,
      active: m.active, policy: m.follow_policy, issued: m.issued_sequence, acknowledged: m.acknowledged_sequence, desired: m.desired_view, count: m.join_count,
      brain: UUID.test(m.brain_id), dates: [m.joined_at, m.last_seen_at, m.join_window].every(d => d instanceof Date) });
    await engine.issueSharedSkillDeliveryBatch(issueSpec({}));
    const issued = await engine.readSharedSkillMember({ principalKind: 'local_writer', principalId: 'writer-a', adapter: 'generic' });
    await enroll(engine, A, 'writer-a');
    const rejoined = await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-a' });
    await engine.rebindSharedSkillMember(A, { ...POLICY, source_ids: ['default'] }, 7);
    const rebound = await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-a' });
    await engine.leaveSharedSkillMember(A);
    const left = await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-a' });
    const result = {
      empty, count: await engine.countSharedSkillMembers(),
      own: reduce(own),
      // Access cuts: another principal's installation id, and the right principal on another adapter.
      otherPrincipal: await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-b' }) ?? null,
      otherKind: await engine.readSharedSkillMember({ installationId: A, principalKind: 'oauth_client', principalId: 'writer-a' }) ?? null,
      otherAdapter: await engine.readSharedSkillMember({ principalKind: 'local_writer', principalId: 'writer-a', adapter: 'claude-code' }) ?? null,
      issued: { issued: issued?.issued_sequence, desired: issued?.desired_view },
      rejoined: { epoch: rejoined?.epoch, issued: rejoined?.issued_sequence, desired: rejoined?.desired_view, count: rejoined?.join_count, active: rejoined?.active },
      rebound: { epoch: rebound?.epoch, policy: rebound?.follow_policy, count: rebound?.join_count },
      left: { active: left?.active, epoch: left?.epoch },
    };
    expect(result).toEqual({
      empty: 0, count: 2,
      own: { installation: A, principal: 'local_writer:writer-a', adapter: 'generic', epoch: 1, active: true, policy: POLICY, issued: 0, acknowledged: 0, desired: null,
        count: 1, brain: true, dates: true },
      otherPrincipal: null, otherKind: null, otherAdapter: null,
      issued: { issued: 1, desired: 'v1' },
      rejoined: { epoch: 2, issued: 0, desired: null, count: 2, active: true },
      rebound: { epoch: 7, policy: { ...POLICY, source_ids: ['default'] }, count: 2 },
      left: { active: false, epoch: 7 },
    });
    return result;
  });

  parityTest('a batch is reused for the same view, advances for a new one, reads only under its installation and epoch, and keeps the newest', {
    methods: ['lockSharedSkillBrainId', 'enrollSharedSkillMember', 'issueSharedSkillDeliveryBatch', 'readSharedSkillDeliveryBatch',
      'acknowledgeSharedSkillDeliveryBatch', 'readSharedSkillMember', 'transaction'],
  }, async (engine) => {
    await enroll(engine, A, 'writer-a');
    await enroll(engine, B, 'writer-b');
    const one = await engine.issueSharedSkillDeliveryBatch(issueSpec({}));
    const again = await engine.issueSharedSkillDeliveryBatch(issueSpec({ issuedSequence: 1 }));
    const two = await engine.issueSharedSkillDeliveryBatch(issueSpec({ issuedSequence: 1, viewToken: 'v2' }));
    const read = await engine.transaction(tx => tx.readSharedSkillDeliveryBatch(one.batch.token, A, 1));
    await engine.acknowledgeSharedSkillDeliveryBatch({ token: two.batch.token, evidence: { stage: 'installed', revisions: [] }, installationId: A,
      advance: { sequence: 2, viewToken: 'v2' } });
    await engine.acknowledgeSharedSkillDeliveryBatch({ token: one.batch.token, evidence: { stage: 'fetched', revisions: [] }, installationId: A,
      advance: { sequence: 1, viewToken: 'v1' } });
    const acked = await engine.readSharedSkillDeliveryBatch(two.batch.token, A, 1);
    const member = await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-a' });
    // Retention: two batches kept, so the third issue drops the oldest.
    const three = await engine.issueSharedSkillDeliveryBatch(issueSpec({ issuedSequence: 2, viewToken: 'v3', retainedBatches: 2 }));
    const readable = async (token: string) => (await engine.readSharedSkillDeliveryBatch(token, A, 1)) !== undefined;
    const kept = [await readable(one.batch.token), await readable(two.batch.token), await readable(three.batch.token)];
    // A batch under the next epoch prunes every batch of the previous one.
    const next = await engine.issueSharedSkillDeliveryBatch(issueSpec({ epoch: 2, issuedSequence: 0 }));
    let refused: unknown = null;
    // retainedBatches 1 would prune `next`; the refusal rolls the prune back with the batch.
    try { await engine.issueSharedSkillDeliveryBatch(issueSpec({ epoch: 2, issuedSequence: 1, viewToken: 'v9', retainedBatches: 1, revisions: ['brain/default/x/pack/skill@missing'] })); }
    catch (error) { refused = { code: (error as { code?: string }).code, retained: (error as Error).message.includes('revision_unavailable: delivery revision is no longer retained') }; }
    const kept2 = await engine.readSharedSkillDeliveryBatch(next.batch.token, A, 2);
    const after = await engine.readSharedSkillMember({ installationId: A, principalKind: 'local_writer', principalId: 'writer-a' });
    const afterRefusal = { view: kept2?.view_token ?? null, revisions: kept2?.revisions ?? null, acked: kept2?.acknowledged_at ?? null,
      issued: after?.issued_sequence, desired: after?.desired_view, acknowledged: after?.acknowledged_sequence };
    const result = {
      one: { created: one.created, seq: one.issuedSequence, batch: one.batch.sequence, epoch: one.batch.epoch, token: UUID.test(one.batch.token) },
      again: { created: again.created, seq: again.issuedSequence, same: again.batch.token === one.batch.token },
      two: { created: two.created, seq: two.issuedSequence, batch: two.batch.sequence, view: two.batch.view_token },
      read: read && { view: read.view_token, auth: read.authority_digest, revisions: read.revisions, acked: read.acknowledged_at, evidence: read.evidence,
        installation: read.installation_id, issued: read.issued_at instanceof Date },
      // Access cuts: the right token under another installation or another epoch.
      otherInstallation: await engine.readSharedSkillDeliveryBatch(one.batch.token, B, 1) ?? null,
      otherEpoch: await engine.readSharedSkillDeliveryBatch(one.batch.token, A, 2) ?? null,
      unknown: await engine.readSharedSkillDeliveryBatch(UNKNOWN, A, 1) ?? null,
      acked: { at: acked?.acknowledged_at instanceof Date, evidence: acked?.evidence },
      member: { issued: member?.issued_sequence, acknowledged: member?.acknowledged_sequence, view: member?.acknowledged_view },
      three: three.issuedSequence,
      kept,
      next: { seq: next.issuedSequence, previous: await engine.readSharedSkillDeliveryBatch(three.batch.token, A, 1) ?? null },
      refused, afterRefusal,
    };
    expect(result).toEqual({
      one: { created: true, seq: 1, batch: 1, epoch: 1, token: true },
      again: { created: false, seq: 1, same: true },
      two: { created: true, seq: 2, batch: 2, view: 'v2' },
      read: { view: 'v1', auth: 'auth', revisions: [], acked: null, evidence: null, installation: A, issued: true },
      otherInstallation: null, otherEpoch: null, unknown: null,
      acked: { at: true, evidence: { stage: 'installed', revisions: [] } },
      // GREATEST keeps the higher acknowledged sequence; the view is the last one written.
      member: { issued: 2, acknowledged: 2, view: 'v1' },
      three: 3,
      kept: [false, true, true],
      next: { seq: 1, previous: null },
      refused: { code: '23503', retained: true },
      afterRefusal: { view: 'v1', revisions: [], acked: null, issued: 1, desired: 'v1', acknowledged: 2 },
    });
    return result;
  });

  parityTest('a batch older than 24 hours is outside the replay window and the next issue drops it', {
    methods: ['lockSharedSkillBrainId', 'enrollSharedSkillMember', 'issueSharedSkillDeliveryBatch', 'readSharedSkillDeliveryBatch', 'transaction'],
    // Stopped on Rust by design (its rust-tally.tsv stopped count): a test-setup limit, not a user-facing output. Ageing
    // a batch needs raw SQL because the engines have no clock seam; the gbrain-store unit test
    // `delivery_batch_outside_the_replay_window_is_unread_and_pruned` proves the Rust arm.
    requires: 'raw_sql',
  }, async (engine) => {
    await enroll(engine, A, 'writer-a');
    const old = await engine.issueSharedSkillDeliveryBatch(issueSpec({}));
    await engine.executeRaw(`UPDATE shared_skill_delivery_batches SET issued_at=now()-interval '25 hours' WHERE token=$1::uuid`, [old.batch.token]);
    const stale = await engine.readSharedSkillDeliveryBatch(old.batch.token, A, 1) ?? null;
    const fresh = await engine.issueSharedSkillDeliveryBatch(issueSpec({ issuedSequence: 1 }));
    const [left] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM shared_skill_delivery_batches WHERE token=$1::uuid', [old.batch.token]);
    const result = { stale, reissued: fresh.created && fresh.issuedSequence === 2, pruned: Number(left!.n) === 0 };
    expect(result).toEqual({ stale: null, reissued: true, pruned: true });
    return result;
  });

  parityTest('join, sync with an acknowledgment, replay, leave and re-join run end to end', {
    methods: ['readSharedSkillCatalogIdentity', 'listSharedSkillCatalogHeads', 'listSharedSkillFollowSources', 'lockSharedSkillBrainId', 'readSharedSkillMember',
      'countSharedSkillMembers', 'enrollSharedSkillMember', 'rebindSharedSkillMember', 'leaveSharedSkillMember', 'issueSharedSkillDeliveryBatch',
      'readSharedSkillDeliveryBatch', 'acknowledgeSharedSkillDeliveryBatch', 'readSharedSkillServingEpoch', 'readPersistenceBrainId', 'insertLocalWriterRow',
      'readLocalWriterRow', 'readLocalWriterMemberGrant', 'transaction'],
  }, (engine, backend) => inFreshHome(async () => {
    await installSingletons(engine, backend);
    await registerServeLocalWriters(engine);
    const join1 = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
    const id = join1.ok?.installation_id;
    const ack = (r: any, evidence: Record<string, unknown> = { stage: 'installed', revisions: [] }) =>
      ({ batch_token: r.ok.batch_token, view_token: r.ok.view_token, evidence });
    const sync = (epoch: number, acknowledgment?: unknown) => answer(engine, 'sync_brain_skills', { installation_id: id, enrollment_epoch: epoch, ...(acknowledgment ? { acknowledgment } : {}) });
    const sync1 = await sync(1, ack(join1));
    const replay = await sync(1, ack(join1));
    const downgrade = await sync(1, ack(join1, { stage: 'fetched', revisions: [] }));
    const unknown = await sync(1, { batch_token: UNKNOWN, view_token: join1.ok.view_token, evidence: { stage: 'installed', revisions: [] } });
    const wrongView = await sync(1, { ...ack(join1), view_token: 'not-the-view' });
    const unapproved = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: false } });
    const staleLeave = await answer(engine, 'leave_brain', { installation_id: id, enrollment_epoch: 2 });
    const leave = await answer(engine, 'leave_brain', { installation_id: id, enrollment_epoch: 1 });
    const afterLeave = await sync(1);
    const join2 = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
    // A batch from the left epoch never acknowledges under the new one.
    const oldBatch = await sync(2, ack(join1));
    const narrowed = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: true, source_ids: ['default'] } });
    const widened = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
    const result = {
      join1: shape(join1), sync1: shape(sync1), sameBatch: sync1.ok?.batch_token === join1.ok.batch_token, replay: shape(replay),
      downgrade, unknown, wrongView, unapproved, staleLeave,
      leave: leave.ok && { status: leave.ok.status, epoch: leave.ok.enrollment_epoch, same: leave.ok.installation_id === id },
      afterLeave, join2: shape(join2), sameInstallation: join2.ok?.installation_id === id, newBatch: join2.ok?.batch_token !== join1.ok.batch_token,
      oldBatch, narrowed: shape(narrowed), widened,
    };
    const visible = (epoch: number, sequence: number, installation: string, ackState: string | null) => ({ status: 'catalog_visible', complete: true, epoch, sequence,
      skills: 0, blocked: 0, installation, ack: ackState, ids: true });
    expect(result).toEqual({
      join1: visible(1, 1, 'unverified', null), sync1: visible(1, 1, 'self_reported', 'recorded'), sameBatch: true, replay: visible(1, 1, 'self_reported', 'replayed'),
      downgrade: { code: 'invalid_acknowledgment' }, unknown: { code: 'acknowledgment_unavailable' }, wrongView: { code: 'invalid_acknowledgment' },
      unapproved: { code: 'follow_approval_required' }, staleLeave: { code: 'membership_inactive' },
      leave: { status: 'left', epoch: 1, same: true },
      afterLeave: { code: 'membership_inactive' }, join2: visible(2, 1, 'unverified', null), sameInstallation: true, newBatch: true,
      oldBatch: { code: 'acknowledgment_unavailable' }, narrowed: visible(3, 1, 'unverified', null), widened: { code: 'follow_approval_required' },
    });
    return result;
  }));

  parityTest('a stored policy and head bind a source end to end; get_skill reads the revision and a new batch leases it', {
    methods: ['readSharedSkillCatalogIdentity', 'listSharedSkillCatalogHeads', 'listSharedSkillFollowSources', 'lockSharedSkillBrainId', 'readSharedSkillMember',
      'countSharedSkillMembers', 'enrollSharedSkillMember', 'issueSharedSkillDeliveryBatch', 'readSharedSkillDeliveryBatch',
      'readSharedSkillServingEpoch', 'readPersistenceBrainId', 'insertLocalWriterRow', 'readLocalWriterRow', 'readLocalWriterMemberGrant', 'readSourceMembership', 'readSharedSkillPolicyRow', 'writeSharedSkillPolicy', 'readSharedSkillRevision', 'transaction'],
  }, (engine, backend) => inFreshHome(async () => {
    await installSingletons(engine, backend);
    await registerServeLocalWriters(engine);
    const policy = { version: 1 as const, enabled: true, classes: ['prose' as const], audiences: ['readers'], requirements: [], allow_follow: true };
    const set = await setSharedSkillPolicy(local(engine), 'default', policy, null);
    let stale: unknown = null;
    try { await setSharedSkillPolicy(local(engine), 'default', policy, null); }
    catch (error) { stale = (error as { code?: string }).code; }
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    await seedRevision(engine, backend, skillRevision(incarnation, set.policy_epoch));
    const heads = await engine.listSharedSkillCatalogHeads({ sourceIds: null, limit: 101, sourceId: null, sourceIncarnation: null, packId: null, name: null, hidePrivate: true });
    const head = heads[0] as any;
    const key = { sourceId: 'default', incarnation, packId: 'pack', name: 'notes', revision: REVISION };
    const stored = await engine.readSharedSkillRevision(key);
    const join = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
    const detail = await getSharedSkill(local(engine), { source_id: 'default', name: 'notes' });
    // The lease: a batch that names the retained revision issues; one that names an unknown revision is refused.
    const brainId = await engine.readPersistenceBrainId();
    const item = `${brainId}/default/${incarnation}/pack/notes@${REVISION}`;
    const installationId = join.ok.installation_id as string;
    const leased = await engine.issueSharedSkillDeliveryBatch(issueSpec({ installationId, issuedSequence: 1, viewToken: 'v-leased', revisions: [item] }));
    let unknown: unknown = null;
    try { await engine.issueSharedSkillDeliveryBatch(issueSpec({ installationId, issuedSequence: 2, viewToken: 'v-unknown', revisions: [item.replace(REVISION, OTHER_REVISION)] })); }
    catch (error) { unknown = (error as { code?: string }).code; }
    const result = {
      set: UUID.test(set.policy_epoch), stale,
      get: await getSharedSkillPolicy(local(engine), 'default').then(g => ({ ...g, source_incarnation: g.source_incarnation === incarnation,
        policy_epoch: g.policy_epoch === set.policy_epoch })),
      row: await engine.readSharedSkillPolicyRow('default', incarnation, false).then(r => r && { epoch: r.epoch === set.policy_epoch, policy: r.policy }),
      heads: heads.map((h: any) => ({ source: h.source_id, incarnation: h.source_incarnation === incarnation, pack: h.pack_id, name: h.name, revision: h.revision,
        deleted: h.deleted, policyEpoch: h.policy_epoch === set.policy_epoch, current: h.current_policy, currentEpoch: h.current_epoch === set.policy_epoch,
        updated: h.updated_at instanceof Date, description: h.metadata?.description })),
      head: head && { files: 'files' in head },
      stored: stored && { revision: stored.revision, deleted: stored.deleted, files: stored.files.map(f => f.path), description: stored.metadata.description },
      otherRevision: await engine.readSharedSkillRevision({ ...key, revision: OTHER_REVISION }) ?? null,
      otherSource: await engine.readSharedSkillRevision({ ...key, sourceId: 'missing' }) ?? null,
      join: shape(join),
      followed: join.ok.skills.map((s: any) => `${s.source_id}/${s.pack_id}/${s.name}@${s.revision}`),
      detail: { revision: (detail as any).revision, files: (detail as any).files.map((f: any) => f.path), description: (detail as any).description },
      leased: { created: leased.created, revisions: JSON.stringify((await engine.readSharedSkillDeliveryBatch(leased.batch.token, installationId, 1))?.revisions) === JSON.stringify([item]) },
      unknown,
    };
    expect(result).toEqual({
      set: true, stale: 'revision_conflict',
      get: { schema_version: 2, source_id: 'default', source_incarnation: true, publication_enabled: false, policy_epoch: true, policy },
      row: { epoch: true, policy },
      heads: [{ source: 'default', incarnation: true, pack: 'pack', name: 'notes', revision: REVISION, deleted: false, policyEpoch: true, current: policy, currentEpoch: true,
        updated: true, description: 'Take notes.' }],
      head: { files: false },
      stored: { revision: REVISION, deleted: false, files: ['skills/notes/SKILL.md'], description: 'Take notes.' },
      otherRevision: null, otherSource: null,
      join: { status: 'catalog_visible', complete: true, epoch: 1, sequence: 1, skills: 1, blocked: 0, installation: 'unverified', ack: null, ids: true },
      followed: [`default/pack/notes@${REVISION}`],
      detail: { revision: REVISION, files: ['skills/notes/SKILL.md'], description: 'Take notes.' },
      leased: { created: true, revisions: true },
      unknown: '23503',
    });
    return result;
  }));

  parityTest('a malformed uuid fails with 22P02; writeSharedSkillRevision refuses on a brain without shared publication', {
    methods: ['readSharedSkillRevision', 'readSharedSkillDeliveryBatch', 'writeSharedSkillRevision', 'readSourceMembership', 'declarePersistence', 'transaction'],
  }, async (engine, backend) => {
    await installSingletons(engine, backend);
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const code = async (run: () => Promise<unknown>) => {
      try { await run(); return null; }
      catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message.split('\n')[0] }; }
    };
    const result = {
      revision: await code(() => engine.readSharedSkillRevision({ sourceId: 'default', incarnation, packId: 'pack', name: 'notes', revision: 'not-a-uuid' })),
      incarnation: await code(() => engine.readSharedSkillRevision({ sourceId: 'default', incarnation: 'not-a-uuid', packId: 'pack', name: 'notes', revision: REVISION })),
      batch: await code(() => engine.readSharedSkillDeliveryBatch('not-a-uuid', A, 1)),
      installation: await code(() => engine.readSharedSkillDeliveryBatch(UNKNOWN, 'not-a-uuid', 1)),
      publish: await code(() => engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.writeSharedSkillRevision(skillRevision(incarnation, 'epoch'));
      })),
      stored: await engine.readSharedSkillRevision({ sourceId: 'default', incarnation, packId: 'pack', name: 'notes', revision: REVISION }) ?? null,
    };
    const malformed = { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' };
    expect(result).toEqual({ revision: malformed, incarnation: malformed, batch: malformed, installation: malformed,
      publish: { code: '42501', message: 'writer_not_quiesced: shared publication is disabled' }, stored: null });
    return result;
  });

  parityTest('put_skill publishes one revision after activation: the receipt, get_skill and join_brain agree, and a replay returns the same receipt', {
    methods: ['readSourceMembership', 'writeSharedSkillPolicy', 'readSharedSkillPolicyRow', 'readSharedSkillRevision', 'writeSharedSkillRevision',
      'listSharedSkillCatalogHeads', 'transaction'],
  }, (engine, backend) => inFreshHome(() => withCanonicalRoot(engine, backend, async () => {
    await installSingletons(engine, backend);
    await registerServeLocalWriters(engine);
    const activated = await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await engine.setConfig('mcp.publish_skills', 'true');
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const policy = { version: 1 as const, enabled: true, classes: ['prose' as const], audiences: ['readers'], requirements: [], allow_follow: true };
    await setSharedSkillPolicy(local(engine), 'default', policy, null);
    const params = { request_id: 'f0000000-0000-4000-8000-0000000000d1', expected_revision: null, source_id: 'default', source_incarnation: incarnation,
      pack_id: 'pack', name: 'notes', files: [{ path: 'skills/notes/SKILL.md', content: BODY, file_class: 'prose' }] };
    const ctx = { ...local(engine), sourceId: 'default' } as OperationContext;
    const put = await submitSharedSkillMutation(ctx, 'put_skill', params);
    const replay = await submitSharedSkillMutation(ctx, 'put_skill', params);
    const skill = await getSharedSkill(local(engine), { name: 'notes' });
    const join = await answer(engine, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } });
    const result = { activated, receipt: generic(put), replay: JSON.stringify(replay) === JSON.stringify(put),
      revision: (put as { revision: string }).revision === (skill as { revision?: string }).revision,
      skill: generic(skill), join: shape(join), followed: join.ok.skills.map((s: any) => `${s.source_id}/${s.pack_id}/${s.name}`) };
    expect(result.activated).toEqual({ activated: true, protocol_version: 2, filesystem_sources: 1 });
    expect(result.receipt).toMatchObject({ status: 'published', state: 'committed', delivery: 'canonical_committed', name: 'notes', pack_id: 'pack' });
    expect(result.replay).toBe(true);
    expect(result.followed).toEqual(['default/pack/notes']);
    return result;
  })));

  parityTest('a second put_skill of the same skill publishes against the canonical files the first wrote, with the same answer and SKILL.md', {
    methods: ['readSourceMembership', 'writeSharedSkillPolicy', 'readSharedSkillPolicyRow', 'readSharedSkillRevision', 'writeSharedSkillRevision',
      'listSharedSkillCatalogHeads', 'transaction'],
  }, (engine, backend) => inFreshHome(() => withCanonicalRoot(engine, backend, async (root) => {
    await installSingletons(engine, backend);
    await registerServeLocalWriters(engine);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await engine.setConfig('mcp.publish_skills', 'true');
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const policy = { version: 1 as const, enabled: true, classes: ['prose' as const], audiences: ['readers'], requirements: [], allow_follow: true };
    await setSharedSkillPolicy(local(engine), 'default', policy, null);
    const ctx = { ...local(engine), sourceId: 'default' } as OperationContext;
    const put = (requestId: string, expected: string | null, body: string) => submitSharedSkillMutation(ctx, 'put_skill', { request_id: requestId,
      expected_revision: expected, source_id: 'default', source_incarnation: incarnation, pack_id: 'pack', name: 'notes',
      files: [{ path: 'skills/notes/SKILL.md', content: body, file_class: 'prose' }] });
    // The canonical root is a temp directory, so these reads see runtime output, not repo source.
    const tempDir = root;
    const tempRead = (rel: string) => (existsSync(join(tempDir, rel)) ? readFileSync(join(tempDir, rel), 'utf8') : null);
    const disk = () => {
      const manifest = tempRead('skillpack.json');
      return { skill: tempRead('skills/notes/SKILL.md'), manifest: manifest === null ? null : Object.keys(JSON.parse(manifest)).sort() };
    };
    const first = await put('f0000000-0000-4000-8000-0000000000d2', null, BODY);
    const afterFirst = disk();
    const second = await refusal(() => put('f0000000-0000-4000-8000-0000000000d3', (first as { revision: string }).revision, `${BODY}Again.\n`));
    const skill = await getSharedSkill(local(engine), { name: 'notes' });
    const result = { first: generic(first), afterFirst, second: generic(second), afterSecond: disk(),
      head: (second as { ok?: { revision?: string } }).ok?.revision === (skill as { revision?: string }).revision };
    expect(result.afterFirst.skill).toBe(BODY);
    expect(result.second).toMatchObject({ ok: { status: 'published', state: 'committed', delivery: 'canonical_committed', name: 'notes' } });
    expect(result.afterSecond.skill).toBe(`${BODY}Again.\n`);
    expect(result.head).toBe(true);
    return result;
  })));

  parityTest('a queued write request makes activation refuse writer_not_quiesced; once it is cancelled, activation passes', {
    methods: ['readSourceMembership', 'transaction'],
  }, (engine, backend) => inFreshHome(() => withCanonicalRoot(engine, backend, async () => {
    await installSingletons(engine, backend);
    await registerServeLocalWriters(engine);
    const source = (await engine.readSourceMembership('default'))!;
    const ctx = { ...local(engine), sourceId: 'default' } as OperationContext;
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/queued');
    const requestId = 'f0000000-0000-4000-8000-0000000000d2';
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'notes/queued', requestId, callerIntent: { body: 'queued' }, intent: { body: 'queued' } });
    const refused = await refusal(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true }));
    const unconfirmed = await refusal(() => activateSharedSkillPersistence(engine, {}));
    await cancelWriteRequest(engine, authority.principal, requestId);
    const passed = await refusal(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true }));
    expect(refused).toMatchObject({ code: 'writer_not_quiesced' });
    expect((refused as { suggestion: string }).suggestion).toContain(`Blocking request ${requestId} (put_page, queued) for source default, page notes/queued.`);
    expect(passed).toEqual({ ok: { activated: true, protocol_version: 2, filesystem_sources: 1 } });
    return { refused, unconfirmed, passed };
  })));
});
