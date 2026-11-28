import { createHash, randomUUID } from 'node:crypto';
import type { OperationContext, OpErrorOpts } from '../ops/contract.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { hostFix, readFix } from '../ops/op-fix.ts';
import type { RegistryCode } from '../error-registry.ts';
import type { Principal } from '../persistence/model.ts';
import { harnessAdapter } from '../harness/registry.ts';
import { listSharedSkills } from './catalog.ts';
import { memberAuthority } from './membership-authority.ts';
import { initializeLocalPersistence } from '../persistence/page-mutations.ts';
import { stableJson } from '../persistence/digest.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import { publicationEnabled, readSharedSkillPolicy } from './policy.ts';
import { SHARED_SKILLS_DELIVERY_LIMITS, sharedSkillKey, type DeliveryEvidence, type FollowPolicy, type MembershipSnapshot, type SkillDeliveryEntry } from './membership-types.ts';

interface BoundPolicy {
  source_ids: string[] | null;
  sources: Record<string, string>;
  requirements: Record<string, { capabilities: string[]; policy_epoch: unknown }>;
}
interface Member {
  installation_id: string;
  principal_kind: string;
  principal_id: string;
  brain_id: string;
  adapter: string;
  epoch: number;
  active: boolean;
  follow_policy: BoundPolicy;
  issued_sequence: number;
  acknowledged_sequence: number;
  desired_view: string | null;
  acknowledged_view: string | null;
  join_count: number;
  join_window: Date | string;
}
interface Batch {
  token: string;
  epoch: number;
  sequence: number;
  view_token: string;
  authority_digest: string;
  revisions: string[];
  acknowledged_at: unknown;
  evidence: DeliveryEvidence | null;
}
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const revisionKey = (skill: SkillDeliveryEntry) => `${sharedSkillKey(skill)}@${skill.revision}`;
const fail = (code: RegistryCode, message: string, suggestion: string, opts: OpErrorOpts = {}): never => { throw opError(code, message, suggestion, opts); };
const catalogFix = readFix('Lists the shared skills this connection can see now, read-only.',
  { argv: ['gbrain', 'skills', '--schema-version', '2', '--json'], mcp: { tool: 'list_skills', arguments: { schema_version: 2 } } });
const syncFix = (installationId: string, epoch: number) => readFix('Reads a fresh complete view and batch for this enrollment; no acknowledgment is recorded.',
  { argv: ['gbrain', 'sync-brain-skills', '--installation-id', installationId, '--enrollment-epoch', String(epoch), '--json'],
    mcp: { tool: 'sync_brain_skills', arguments: { installation_id: installationId, enrollment_epoch: epoch } } });

async function catalog(ctx: OperationContext): Promise<{ brain_id: string; view_token: string; skills: SkillDeliveryEntry[] }> {
  let cursor: string | undefined;
  let view: string | undefined;
  let brain: string | undefined;
  let metadataBytes = 2;
  const skills: SkillDeliveryEntry[] = [];
  for (let page = 0; page < Math.ceil(SHARED_SKILLS_DELIVERY_LIMITS.skills / 100); page++) {
    const result = await listSharedSkills(ctx, { limit: 100, ...(cursor ? { cursor } : {}) });
    if (result.schema_version !== 2 || !Array.isArray(result.skills) || (view !== undefined && result.view_token !== view)) {
      fail('catalog_unavailable', 'A complete bounded catalog is required; no local deletion or cursor advancement is safe.',
        'The catalog changed or came back incomplete while it was read, so nothing was delivered or deleted. Call sync_brain_skills again for a fresh complete view, and keep cached skills unused until it succeeds.',
        { fix: catalogFix });
    }
    view = result.view_token; brain = result.brain_id;
    skills.push(...result.skills.map(skill => ({ ...skill, brain_id: result.brain_id })) as SkillDeliveryEntry[]);
    metadataBytes += Buffer.byteLength(JSON.stringify(result.skills));
    if (skills.length > SHARED_SKILLS_DELIVERY_LIMITS.skills || metadataBytes > SHARED_SKILLS_DELIVERY_LIMITS.metadataBytes) {
      fail('catalog_capacity_exceeded', `Delivery snapshots support at most ${SHARED_SKILLS_DELIVERY_LIMITS.skills} skills and ${SHARED_SKILLS_DELIVERY_LIMITS.metadataBytes} metadata bytes. Narrow the authorized source view; existing delivery state was preserved.`,
        'Follow fewer sources (follow_policy.source_ids) or ask the brain host\'s operator to narrow the sources this connection is granted; existing delivery state is unchanged.', { fix: catalogFix });
    }
    cursor = result.next_cursor;
    if (!cursor) return { brain_id: brain, view_token: view, skills };
  }
  return fail('catalog_capacity_exceeded', `Delivery snapshots support at most ${SHARED_SKILLS_DELIVERY_LIMITS.skills} skills. Narrow the authorized source view; existing delivery state was preserved.`,
    'Follow fewer sources (follow_policy.source_ids) or ask the brain host\'s operator to narrow the sources this connection is granted; existing delivery state is unchanged.', { fix: catalogFix });
}

function normalizePolicy(policy: FollowPolicy, adapter: string): string[] | null {
  if (policy?.approved !== true) fail('follow_approval_required', 'Approve following this brain’s published skills or continue with memory only.',
    'Ask the user whether this installation should follow the brain\'s published skills (their instructions get installed in the harness). Only after they agree, join with follow_policy {"approved": true}; otherwise keep using memory only.',
    { fix: { argv: ['gbrain', 'join-brain', '--adapter', adapter, '--follow-policy', '{"approved":true}', '--json'],
      mcp: { tool: 'join_brain', arguments: { adapter, follow_policy: { approved: true } } }, consent: ['persistent_install'], actor: 'agent', requires_exclusive: false,
      why: 'Enrolls this installation to follow approved shared skills; the user decides whether instructions are installed.' } });
  if (policy.source_ids === undefined) return null;
  if (!Array.isArray(policy.source_ids) || policy.source_ids.length > 64 || policy.source_ids.some(s => typeof s !== 'string' || !s || s.length > 128)) fail('invalid_params', 'Invalid follow source list.',
    'Send follow_policy.source_ids as up to 64 non-empty source ids of at most 128 characters each, or omit it to follow every source this connection can see.', { fix: catalogFix });
  return [...new Set(policy.source_ids)].sort();
}

async function bindPolicy(ctx: OperationContext, sourceIds: string[] | null): Promise<BoundPolicy> {
  const sources: Record<string, string> = {};
  const requirements: BoundPolicy['requirements'] = {};
  const scope = sourceScopeOpts(ctx);
  const allowed = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null);
  const rows = await ctx.engine.executeRaw<{ id: string; incarnation: string }>(`SELECT id,incarnation FROM sources
    WHERE NOT archived AND ($1::text[] IS NULL OR id=ANY($1::text[])) AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY id LIMIT 65`, [allowed, sourceIds]);
  if (rows.length > 64) fail('invalid_params', 'Narrow the enrollment to at most 64 sources.',
    'This connection can see more than 64 sources: name at most 64 of them in follow_policy.source_ids.', { fix: catalogFix });
  const published = await publicationEnabled(ctx);
  for (const source of rows) {
    if (sourceIds && !sourceIds.includes(source.id)) continue;
    const { policy, epoch } = await readSharedSkillPolicy(ctx.engine, source.id, source.incarnation, published);
    if (!policy.enabled || !policy.allow_follow) continue;
    sources[source.id] = source.incarnation;
    requirements[`${source.id}/${source.incarnation}`] = { capabilities: [...policy.requirements].sort(), policy_epoch: epoch };
  }
  return { source_ids: sourceIds, sources, requirements };
}

/**
 * #6797: what an approved join on an active enrollment renews. A source already bound, at the same incarnation, whose
 * current policy asks for no capability the binding lacks takes its current policy epoch and capabilities. A new source,
 * a new capability or a new incarnation keeps the old pin (its skills stay blocked) until the owner approves a new
 * enrollment, so a replayed follow approval (`--refresh-skills`) never grants more than the user approved.
 */
function renewPins(bound: BoundPolicy, current: BoundPolicy, sourceIds: string[] | null): BoundPolicy {
  const sources: Record<string, string> = {};
  const requirements: BoundPolicy['requirements'] = {};
  for (const [id, incarnation] of Object.entries(bound.sources)) {
    if (sourceIds && !sourceIds.includes(id)) continue;
    const key = `${id}/${incarnation}`;
    const pinned = bound.requirements[key];
    if (!pinned) continue;
    const now = current.sources[id] === incarnation ? current.requirements[key] : undefined;
    sources[id] = incarnation;
    requirements[key] = now && now.capabilities.every(capability => pinned.capabilities.includes(capability)) ? now : pinned;
  }
  return { source_ids: sourceIds, sources, requirements };
}

function filtered(member: Member, skills: SkillDeliveryEntry[]) {
  const accepted: SkillDeliveryEntry[] = [];
  const blocked: SkillDeliveryEntry[] = [];
  for (const skill of skills) {
    const policy = member.follow_policy;
    if (policy.source_ids && !policy.source_ids.includes(skill.source_id)) continue;
    const requirement = policy.requirements[`${skill.source_id}/${skill.source_incarnation}`];
    if (skill.usable !== true || skill.delivery !== 'complete' || skill.allow_follow !== true || policy.sources[skill.source_id] !== skill.source_incarnation || !requirement ||
      requirement.policy_epoch !== skill.policy_epoch || !Array.isArray(skill.requirements) || skill.requirements.some(r => !requirement.capabilities.includes(String(r)))) blocked.push(skill);
    else accepted.push(skill);
  }
  return { accepted, blocked };
}

const notMember = 'Use the installation_id that join_brain returned to this same connection. With no enrollment yet, joining needs the user\'s follow approval first.';
async function ownMember(ctx: OperationContext, id: string, principal: Principal): Promise<Member> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) fail('membership_not_found', 'No active membership for this principal.', `installation_id must be a UUID. ${notMember}`);
  const [member] = await ctx.engine.executeRaw<Member>(`SELECT * FROM shared_skill_members WHERE installation_id=$1::uuid
    AND principal_kind=$2 AND principal_id=$3 FOR UPDATE`, [id, principal.kind, principal.id]);
  if (!member) fail('membership_not_found', 'No active membership for this principal.', `This connection has no membership ${id}. ${notMember}`);
  return member;
}

async function issue(ctx: OperationContext, member: Member, authorityDigest: string, snapshot: Awaited<ReturnType<typeof catalog>>,
  acknowledgment?: MembershipSnapshot['acknowledgment']): Promise<MembershipSnapshot> {
  if (snapshot.brain_id !== member.brain_id) fail('membership_inactive', 'The persistent brain identity changed; this enrollment cannot be reused.',
    `This brain now has identity ${snapshot.brain_id}, not the ${member.brain_id} installation ${member.installation_id} enrolled with. Leave locally, then join again after the user approves following this brain.`,
    { docs: 'docs/guides/shared-brain-skills.md#recover-the-same-brain-identity' });
  const { accepted, blocked } = filtered(member, snapshot.skills);
  const view = digest([snapshot.view_token, member.epoch, member.follow_policy]);
  const revisions = accepted.map(revisionKey).sort();
  await ctx.engine.executeRaw(`DELETE FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid
    AND (epoch<>$2 OR issued_at < now()-interval '24 hours')`, [member.installation_id, member.epoch]);
  const [prior] = await ctx.engine.executeRaw<Batch>(`SELECT * FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid AND epoch=$2
    AND view_token=$3 AND authority_digest=$4 AND sequence=$5 ORDER BY sequence DESC LIMIT 1`, [member.installation_id, member.epoch, view, authorityDigest, member.issued_sequence]);
  let batch = prior;
  if (!batch) {
    const sequence = Number(member.issued_sequence) + 1;
    batch = { token: randomUUID(), epoch: Number(member.epoch), sequence, view_token: view, authority_digest: authorityDigest, revisions, acknowledged_at: null, evidence: null };
    try {
      await ctx.engine.executeRaw(`INSERT INTO shared_skill_delivery_batches(token,installation_id,epoch,sequence,view_token,authority_digest,revisions)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::text::jsonb)`, [batch.token, member.installation_id, member.epoch, sequence, view, authorityDigest, JSON.stringify(revisions)]);
    } catch (error) {
      if ((error as { code?: string }).code === '23503' && (error as Error).message.includes('revision_unavailable: delivery revision is no longer retained')) {
        throw new OperationError('catalog_unavailable', 'A delivery revision changed before its retention lease was committed.', 'Retry a fresh authorized sync. Preserve the current cache; no delivery state was advanced.');
      }
      throw error;
    }
    await ctx.engine.executeRaw('UPDATE shared_skill_members SET issued_sequence=$2,desired_view=$3 WHERE installation_id=$1::uuid', [member.installation_id, sequence, view]);
    member.issued_sequence = sequence;
  }
  await ctx.engine.executeRaw(`DELETE FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid AND token NOT IN
    (SELECT token FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid AND epoch=$2 ORDER BY sequence DESC LIMIT $3)`,
  [member.installation_id, member.epoch, SHARED_SKILLS_DELIVERY_LIMITS.retainedBatches]);
  await ctx.engine.executeRaw(`UPDATE shared_skill_members SET last_seen_at=now() WHERE installation_id=$1::uuid AND last_seen_at<now()-interval '1 minute'`, [member.installation_id]);
  return { schema_version: 2, status: blocked.length ? 'requirements_changed' : 'catalog_visible', complete: true, brain_id: member.brain_id,
    installation_id: member.installation_id, enrollment_epoch: Number(member.epoch), view_token: view, batch_token: batch.token,
    sequence: Number(batch.sequence), skills: accepted, blocked_skills: blocked, ...(acknowledgment ? { acknowledgment } : {}),
    delivery: { transport: 'verified', installation: Number(member.acknowledged_sequence) === Number(member.issued_sequence) && member.issued_sequence > 0 ? 'self_reported' : 'unverified', native: 'unverified', freshness: 'advisory_refresh' } };
}

export async function joinBrain(ctx: OperationContext, params: { adapter: string; follow_policy: FollowPolicy; installation_id?: never }): Promise<MembershipSnapshot> {
  if (params.installation_id !== undefined) fail('invalid_params', 'Installation identities are assigned by the server.',
    'Omit installation_id from join_brain; its result carries the server-assigned installation_id and enrollment_epoch.');
  const adapter = harnessAdapter(params.adapter).id;
  const sourceIds = normalizePolicy(params.follow_policy, adapter);
  await initializeLocalPersistence(ctx);
  return ctx.engine.transaction(async engine => {
    const tx = { ...ctx, engine };
    const authority = await memberAuthority(tx, 'join_brain');
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    if (!brain) fail('catalog_unavailable', 'Persistent brain identity is unavailable.',
      'The brain host has not initialized its persistent identity, so nobody can enroll yet. The brain host\'s operator checks it with doctor.',
      { fix: hostFix(ctx, ['gbrain', 'doctor', '--json'], 'Reports the brain\'s persistence identity and what initializes it.') });
    const snapshot = await catalog(authority.ctx);
    const [existing] = await engine.executeRaw<Member>('SELECT * FROM shared_skill_members WHERE principal_kind=$1 AND principal_id=$2 AND adapter=$3 FOR UPDATE', [authority.principal.kind, authority.principal.id, adapter]);
    let member = existing;
    if (member?.active) {
      const prior = member.follow_policy.source_ids;
      if (prior && (!sourceIds || sourceIds.some(s => !prior.includes(s)))) fail('follow_approval_required', 'An active membership can only narrow its follow policy; leave and approve a new enrollment to widen it.',
        `Installation ${member.installation_id} follows only ${prior.join(', ')}. To follow more, ask the user to approve the wider policy, then leave_brain and join_brain again with it.`);
      const renewed = renewPins(member.follow_policy, await bindPolicy(authority.ctx, sourceIds), sourceIds);
      if (stableJson(renewed) !== stableJson(member.follow_policy)) {
        await engine.executeRaw(`UPDATE shared_skill_members SET follow_policy=$2::text::jsonb,epoch=epoch+1,issued_sequence=0,acknowledged_sequence=0,desired_view=NULL,acknowledged_view=NULL WHERE installation_id=$1::uuid`, [member.installation_id, JSON.stringify(renewed)]);
        member = await ownMember(tx, member.installation_id, authority.principal);
      }
    } else {
      if (member && new Date(member.join_window).getTime() > Date.now() - 3_600_000 && member.join_count >= 10) fail('rate_limited', 'Enrollment rate limit reached for this principal and adapter.',
        `This connection joined ten times within an hour on adapter ${adapter}. Wait until ${new Date(new Date(member.join_window).getTime() + 3_600_000).toISOString()}, then join once.`);
      const [count] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM shared_skill_members');
      if (!member && Number(count.n) >= 4096) fail('rate_limited', 'Brain membership quota reached.',
        'The brain holds 4096 shared-skills memberships. Ask the brain host\'s operator to retire stale installations before this one joins.');
      const policy = await bindPolicy(authority.ctx, sourceIds);
      const id = member?.installation_id ?? randomUUID();
      await engine.executeRaw(`INSERT INTO shared_skill_members(installation_id,principal_kind,principal_id,adapter,brain_id,follow_policy)
        VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::text::jsonb) ON CONFLICT(installation_id) DO UPDATE SET active=true,
        epoch=shared_skill_members.epoch+1,follow_policy=EXCLUDED.follow_policy,issued_sequence=0,acknowledged_sequence=0,desired_view=NULL,acknowledged_view=NULL,joined_at=now(),
        join_count=CASE WHEN shared_skill_members.join_window<now()-interval '1 hour' THEN 1 ELSE shared_skill_members.join_count+1 END,
        join_window=CASE WHEN shared_skill_members.join_window<now()-interval '1 hour' THEN now() ELSE shared_skill_members.join_window END`,
      [id, authority.principal.kind, authority.principal.id, adapter, brain.brain_id, JSON.stringify(policy)]);
      member = await ownMember(tx, id, authority.principal);
    }
    return issue(tx, member, authority.digest, snapshot);
  });
}

export async function syncBrain(ctx: OperationContext, params: { installation_id: string; enrollment_epoch: number;
  acknowledgment?: { batch_token: string; view_token: string; evidence: DeliveryEvidence } }): Promise<MembershipSnapshot> {
  return ctx.engine.transaction(async engine => {
    const tx = { ...ctx, engine };
    const authority = await memberAuthority(tx, 'sync_brain_skills');
    const member = await ownMember(tx, params.installation_id, authority.principal);
    if (!member.active || Number(member.epoch) !== params.enrollment_epoch) fail('membership_inactive', 'Membership was left or superseded; delayed delivery cannot reactivate it.',
      member.active ? `Installation ${member.installation_id} is at enrollment epoch ${member.epoch}, not ${params.enrollment_epoch}. Re-join under the recorded follow policy so the receipt and router adopt the current epoch; for bootstrap-managed wiring that is gbrain bootstrap harness --refresh-skills on the harness host.`
        : `Installation ${member.installation_id} left this brain. Following again needs the user's follow approval and a new join; keep cached skills unused.`,
      { docs: 'docs/guides/shared-brain-skills.md#membership-inactive-after-a-re-enrollment' });
    const snapshot = await catalog(authority.ctx);
    let acknowledgment: MembershipSnapshot['acknowledgment'];
    const ack = params.acknowledgment;
    if (ack) {
      if (!/^[0-9a-f-]{36}$/i.test(ack.batch_token) || Buffer.byteLength(JSON.stringify(ack)) > SHARED_SKILLS_DELIVERY_LIMITS.acknowledgmentBytes || !['installed', 'fetched'].includes(ack.evidence?.stage) ||
        !Array.isArray(ack.evidence?.revisions) || ack.evidence.revisions.length > SHARED_SKILLS_DELIVERY_LIMITS.skills) fail('invalid_acknowledgment', 'Invalid or oversized delivery acknowledgment.',
        `Send acknowledgment as {batch_token, view_token, evidence: {stage: "installed" or "fetched", revisions}} copied from the last sync_brain_skills result, within ${SHARED_SKILLS_DELIVERY_LIMITS.acknowledgmentBytes} bytes.`,
        { fix: syncFix(member.installation_id, Number(member.epoch)) });
      const [batch] = await engine.executeRaw<Batch>(`SELECT * FROM shared_skill_delivery_batches WHERE token=$1::uuid AND installation_id=$2::uuid AND epoch=$3
        AND issued_at>=now()-interval '24 hours' FOR UPDATE`, [ack.batch_token, member.installation_id, member.epoch]);
      if (!batch) throw new OperationError('acknowledgment_unavailable', 'This batch is unknown or outside the retained replay window.', 'Sync without acknowledgment to obtain a fresh batch, then verify installation before acknowledging it. No delivery state was advanced.');
      if (batch.view_token !== ack.view_token || batch.authority_digest !== authority.digest) fail('invalid_acknowledgment', 'The batch does not belong to this current authorized enrollment.',
        'Authority or the view changed since that batch was issued. Sync without an acknowledgment for a fresh batch, install it, then acknowledge that batch_token and view_token.',
        { fix: syncFix(member.installation_id, Number(member.epoch)) });
      const revisions = ack.evidence.revisions.map(s => revisionKey(s as SkillDeliveryEntry)).sort();
      if (JSON.stringify(revisions) !== JSON.stringify(batch.revisions)) fail('invalid_acknowledgment', 'Only the complete issued revision set can be acknowledged.',
        `List all ${batch.revisions.length} revisions the batch issued (the skills of that sync result) in evidence.revisions, not a subset or a different set.`);
      if (ack.evidence.native && (ack.evidence.native.source !== 'self_report' || ack.evidence.stage !== 'installed' ||
        !ack.evidence.revisions.some(s => s.revision === ack.evidence.native!.revision) ||
        ['adapter_version', 'host_version', 'session_id', 'revision'].some(k => typeof (ack.evidence.native as any)[k] !== 'string' || !(ack.evidence.native as any)[k].length || (ack.evidence.native as any)[k].length > 200))) fail('invalid_acknowledgment', 'Native evidence must identify its self-reported provenance and issued revision.',
        'Send evidence.native with source "self_report", stage "installed", one issued revision, and adapter_version, host_version, session_id and revision strings of 1-200 characters; or omit evidence.native.');
      if (batch.acknowledged_at && digest(batch.evidence) === digest(ack.evidence)) {
        acknowledgment = 'replayed';
      } else {
        if (batch.acknowledged_at && !(batch.evidence?.stage === 'fetched' && ack.evidence.stage === 'installed')) fail('invalid_acknowledgment', 'A recorded acknowledgment may only advance from fetched to installed.',
          `This batch already has a ${String(batch.evidence?.stage)} acknowledgment. Resend that evidence unchanged, or sync again for a new batch.`,
          { fix: syncFix(member.installation_id, Number(member.epoch)) });
        await engine.executeRaw('UPDATE shared_skill_delivery_batches SET acknowledged_at=now(),evidence=$2::text::jsonb WHERE token=$1::uuid', [batch.token, JSON.stringify(ack.evidence)]);
        const currentView = digest([snapshot.view_token, member.epoch, member.follow_policy]);
        acknowledgment = batch.view_token === currentView && Number(batch.sequence) === Number(member.issued_sequence) ? 'recorded' : 'historical';
        if (ack.evidence.stage === 'installed' && acknowledgment === 'recorded') {
          await engine.executeRaw(`UPDATE shared_skill_members SET acknowledged_sequence=GREATEST(acknowledged_sequence,$2),acknowledged_view=$3 WHERE installation_id=$1::uuid`, [member.installation_id, batch.sequence, batch.view_token]);
          member.acknowledged_sequence = Number(batch.sequence);
        }
      }
    }
    return issue(tx, member, authority.digest, snapshot, acknowledgment);
  });
}

export async function leaveBrain(ctx: OperationContext, params: { installation_id: string; enrollment_epoch: number }) {
  return ctx.engine.transaction(async engine => {
    const tx = { ...ctx, engine };
    const authority = await memberAuthority(tx, 'leave_brain');
    const member = await ownMember(tx, params.installation_id, authority.principal);
    if (Number(member.epoch) !== params.enrollment_epoch) fail('membership_inactive', 'This enrollment epoch has already been superseded.',
      `Installation ${member.installation_id} is at enrollment epoch ${member.epoch}; a leave for epoch ${params.enrollment_epoch} cannot end the newer enrollment. Leave with the enrollment_epoch from the latest join_brain or sync_brain_skills result.`,
      { docs: 'docs/guides/shared-brain-skills.md#membership-inactive-after-a-re-enrollment' });
    await engine.executeRaw('UPDATE shared_skill_members SET active=false WHERE installation_id=$1::uuid', [member.installation_id]);
    return { installation_id: member.installation_id, enrollment_epoch: Number(member.epoch), status: 'left',
      native_harness_verified: false, local_cleanup: 'unverified', credentials_revoked: false };
  });
}
