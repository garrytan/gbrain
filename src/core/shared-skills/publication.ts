import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { hostFix, readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { catalogFix, policyFix, skillHeadFix } from './fixes.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence } from '../ops/context.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from '../persistence/authority.ts';
import { admitWrite, assertReplayIntent, getWriteRequest, intentDigest } from '../persistence/journal.ts';
import { initializeLocalPersistence, pageMutationSource, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { assertSharedSkillPersistence } from '../persistence/protocol.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from '../persistence/service.ts';
import { digest, requireUuid, sha256, stableJson } from '../persistence/digest.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteAuthority, WriteRequest } from '../persistence/model.ts';
import { localHostId } from '../persistence/identity.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { requestAttribution } from '../persistence/attribution.ts';
import { normalizeSkillFiles, skillMetadata, skillName, skillPath } from './manifest.ts';
import { assertSkillCapability, assertStoredSkillCapability, publicationEnabled, readSharedSkillPolicy, setSharedSkillPolicy } from './policy.ts';
import { SHARED_SKILL_LIMITS, type SharedSkillFile, type SharedSkillPolicy, type SharedSkillPutInput, type SkillMetadata, type StoredSkillFile, type StoredSkillRevision } from './model.ts';
import { assertSharedSkillRetentionCapacity, pruneSharedSkillRevisionsInTransaction, sharedSkillRetentionCapacity, sharedSkillRetentionStatus } from './retention.ts';

interface PackRow { pack_id: string; revision: string; manifest: Record<string, unknown>; manifest_hash: string; }
type HeadKey = Pick<StoredSkillRevision, 'name' | 'revision' | 'deleted'>;
interface PackSkill { name: string; revision: string; files: SharedSkillFile[]; }
interface PublicationIntent {
  pack_id: string; name: string; expected_revision: string | null; policy_epoch: string;
  affected: Array<{ name: string; revision: string | null }>;
  expected_pack_revision: string | null; manifest_before_hash: string | null; original_manifest: Record<string, unknown>;
  before_hashes: Record<string, string | null>;
  proposals: Array<{ name: string; files: StoredSkillFile[]; metadata: SkillMetadata; expected_revision: string | null }>;
  extra_files: Record<string, string>;
}
interface HostAdoption {
  skills: SharedSkillPutInput[];
  initial_files?: Record<string, string>;
  expected_hashes?: Record<string, string | null>;
  mode?: 'proposal';
}
type SkillAuthority = WriteAuthority & { skillSlugsUsed?: string[]; skillAdoptionPreconditions?: Record<string, string | null>; skillAdoptionInventory?: Record<string, string | null> };
const DOCTOR_FIX = readFix('Shows the brain host\'s storage and catalog health so the inconsistency can be reported with evidence.', { argv: ['gbrain', 'doctor', '--json'] });
function ownerStatusFix(sourceId: string, ctx?: OperationContext): Action {
  const argv = ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'];
  const why = `Shows source ${sourceId}'s designated canonical owner, its binding and any pending recovery; claiming, moving or rebinding ownership is a deliberate operator decision.`;
  return ctx ? hostFix(ctx, argv, why) : readFix(why, { argv });
}
function inventoryError(code: 'catalog_unavailable' | 'revision_conflict', message: string, sourceId: string): OperationError {
  return code === 'revision_conflict'
    ? opError(code, message, `Source ${sourceId}'s sealed pack inventory disagrees with its current skill heads, so nothing was published. If another publication just committed, list the catalog again and resubmit with a new request_id; if it repeats, run gbrain doctor --json on the brain host and report it.`, { fix: catalogFix(sourceId) })
    : opError(code, message, `Source ${sourceId}'s sealed shared-skill inventory is missing or inconsistent, so nothing was published. Run gbrain doctor --json on the brain host and report the result to the user; never hand-edit skillpack.json to repair it.`, { fix: DOCTOR_FIX });
}
function precondition(value: unknown, read: Action): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw opError('revision_required', 'Supply expected_revision (null for creation) from the canonical catalog.',
      'Pass expected_revision as the skill\'s current revision UUID from get_skill (schema_version 2), or null when creating a new skill.', { fix: read });
  }
  return value;
}
function canonicalRead(root: string, relative: string): Buffer | null {
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) return null;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !stat.isFile() && !stat.isDirectory()) {
      throw opError('local_conflict', 'A canonical skill path contains a link or special file.',
        `Replace the link or special file on the path to ${relative} in the canonical checkout with regular files on the brain host, then publish again; publication never follows links out of the canonical root.`);
    }
  }
  const stat = lstatSync(cursor);
  if (!stat.isFile() || stat.size > SHARED_SKILL_LIMITS.bundleBytes) {
    throw opError('local_conflict', 'Canonical skill file is unavailable or exceeds the bound.',
      `Restore ${relative} in the canonical checkout on the brain host as a regular file of at most ${SHARED_SKILL_LIMITS.bundleBytes} bytes, then publish again.`);
  }
  return readFileSync(cursor);
}
async function sourceRoot(engine: BrainEngine, sourceId: string, incarnation: string, ctx?: OperationContext) {
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding || binding.source_incarnation !== incarnation || binding.state !== 'active' || !binding.owner_host_id) {
    throw opError('owner_unavailable', 'Shared skills require an active designated canonical source owner.',
      `Source ${sourceId} has no active designated canonical owner at this incarnation, so nothing was published. The brain host's operator inspects it with gbrain sources writer status --source ${sourceId} --json; claiming ownership is their decision.`,
      { fix: ownerStatusFix(sourceId, ctx) });
  }
  if (binding.owner_host_id !== localHostId() || !binding.local_path) {
    throw opError('owner_unavailable', 'The designated owner must prepare this publication.',
      `Source ${sourceId}'s canonical owner is another host (or has no local checkout here), so publish through that host or a connection to its gbrain server. gbrain sources writer status --source ${sourceId} --json names the owner.`,
      { fix: ownerStatusFix(sourceId, ctx) });
  }
  const aliases = await engine.executeRaw<{ source_id: string }>(`SELECT b.source_id FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
    WHERE b.worktree_id=$1::uuid AND b.relative_path=$2 AND b.source_id<>$3 AND NOT s.archived`, [binding.worktree_id, binding.relative_path, sourceId]);
  if (aliases.length) {
    throw opError('source_root_conflict', 'Multiple active sources alias this canonical skill root; resolve ownership before publishing.',
      `Sources ${aliases.map(row => row.source_id).join(', ')} share source ${sourceId}'s canonical skill root. The brain host's operator archives or rebinds the extra sources before anything publishes; gbrain sources writer status --source ${sourceId} --json shows the bindings.`,
      { fix: ownerStatusFix(sourceId, ctx) });
  }
  const root = resolve(binding.local_path, binding.relative_path);
  if (realpathSync(root) !== root) {
    throw opError('local_conflict', 'Canonical source root contains a symlink.',
      `Source ${sourceId}'s registered checkout resolves through a symlink. The brain host's operator re-registers the source at its real path before anything publishes; gbrain sources writer status --source ${sourceId} --json shows the binding.`,
      { fix: ownerStatusFix(sourceId, ctx) });
  }
  return { binding, root };
}
async function headKeys(engine: BrainEngine, sourceId: string, incarnation: string, packId: string): Promise<HeadKey[]> {
  return engine.executeRaw<HeadKey>(`SELECT name,revision,deleted FROM shared_skill_heads
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 ORDER BY name LIMIT $4`,
  [sourceId, incarnation, packId, SHARED_SKILL_LIMITS.catalogSkills + 1]);
}
function packInventory(pack: PackRow | undefined, keys: HeadKey[], sourceId: string): PackSkill[] {
  if (!pack) {
    if (keys.length) throw inventoryError('catalog_unavailable', 'Skill heads have no sealed pack inventory.', sourceId);
    return [];
  }
  const projection = pack.manifest.shared_skills as { schema_version?: unknown; skills?: unknown } | undefined;
  if (projection?.schema_version !== 2 || !Array.isArray(projection.skills) || keys.length > SHARED_SKILL_LIMITS.catalogSkills) {
    throw inventoryError('catalog_unavailable', 'The sealed pack inventory is missing or exceeds its bound.', sourceId);
  }
  const active = new Map(keys.filter(key => !key.deleted).map(key => [key.name, key.revision]));
  const names = new Set<string>();
  const inventory: PackSkill[] = [];
  for (const entry of projection.skills as PackSkill[]) {
    if (!entry || typeof entry.name !== 'string' || names.has(entry.name) || active.get(entry.name) !== entry.revision) {
      throw inventoryError('revision_conflict', 'The sealed pack inventory does not match its current skill heads.', sourceId);
    }
    names.add(entry.name);
    if (!Array.isArray(entry.files) || entry.files.length < 1 || entry.files.length > SHARED_SKILL_LIMITS.files ||
      !entry.files.some(file => file?.path === `skills/${entry.name}/SKILL.md`)) {
      throw inventoryError('catalog_unavailable', 'The sealed pack file inventory is incomplete.', sourceId);
    }
    const paths = new Set<string>();
    const files = entry.files.map(file => {
      if (!file || typeof file.path !== 'string' || paths.has(file.path) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || !['prose', 'reference', 'asset', 'script'].includes(file.file_class) || typeof file.media_type !== 'string' ||
        !Array.isArray(file.audience) || file.audience.some(value => typeof value !== 'string') ||
        !Array.isArray(file.depends_on) || file.depends_on.some(value => typeof value !== 'string')) {
        throw inventoryError('catalog_unavailable', 'The sealed pack file inventory is malformed.', sourceId);
      }
      paths.add(file.path);
      return { path: file.path, file_class: file.file_class, audience: file.audience, media_type: file.media_type,
        size: file.size, sha256: file.sha256, depends_on: file.depends_on };
    });
    inventory.push({ name: entry.name, revision: entry.revision, files });
  }
  if (names.size !== active.size) throw inventoryError('revision_conflict', 'The sealed pack inventory omits current skill heads.', sourceId);
  return inventory;
}
async function heads(engine: BrainEngine, sourceId: string, incarnation: string, packId: string, names: string[]): Promise<StoredSkillRevision[]> {
  if (!names.length) return [];
  return engine.executeRaw<StoredSkillRevision>(`SELECT r.* FROM shared_skill_heads h JOIN shared_skill_revisions r
    ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
    WHERE h.source_id=$1 AND h.source_incarnation=$2::uuid AND h.pack_id=$3 AND h.name=ANY($4::text[]) ORDER BY h.name`, [sourceId, incarnation, packId, names]);
}
function validateDisclosure(files: StoredSkillFile[], metadata: SkillMetadata, policy: SharedSkillPolicy, legacy: boolean, sourceId: string) {
  if (files.some(f => !policy.classes.includes(f.file_class) || f.audience.some(a => !policy.audiences.includes(a)))) {
    throw opError('approval_required', 'The file class or audience exceeds the owner-approved publication policy.',
      `Keep every file's file_class within [${policy.classes.join(', ')}] and audience within [${policy.audiences.join(', ')}], then resubmit; or ask the user whether the publisher should widen source ${sourceId}'s policy with set_skill_policy. Never widen it on your own.`,
      { fix: policyFix(sourceId) });
  }
  if (!legacy && metadata.requirements.some(r => !policy.requirements.includes(r))) {
    throw opError('requirements_changed', 'The runtime requirements exceed the owner-approved publication policy.',
      `Drop the runtime requirements outside [${policy.requirements.join(', ')}] and resubmit, or ask the user whether the publisher should approve them in source ${sourceId}'s policy with set_skill_policy.`,
      { fix: policyFix(sourceId) });
  }
}
function affectedSkills(current: PackSkill[], name: string, files: StoredSkillFile[]): PackSkill[] {
  const changedShared = new Map(files.filter(f => f.path.startsWith('skills/conventions/')).map(({ content: _content, ...file }) => [file.path, stableJson(file)]));
  return current.filter(row => row.name === name || row.files.some(file => changedShared.has(file.path) && changedShared.get(file.path) !== stableJson(file)));
}
function rebuildDependentClosure(name: string, previous: StoredSkillFile[], replacements: Map<string, StoredSkillFile>): StoredSkillFile[] {
  const available = new Map(previous.map(file => [file.path, file]));
  for (const [path, file] of replacements) if (path.startsWith('skills/conventions/')) available.set(path, file);
  const visited = new Map<string, StoredSkillFile>();
  const heights = new Map<string, number>();
  const walk = (path: string, ancestors: Set<string>): number => {
    if (ancestors.has(path) || ancestors.size > SHARED_SKILL_LIMITS.closureDepth) {
      throw opError('invalid_params', 'The shared edit creates a dependency cycle or exceeds closure depth.',
        `Remove the depends_on cycle through ${path}, or flatten the chain under skill ${name} to at most ${SHARED_SKILL_LIMITS.closureDepth} levels, then resubmit with a new request_id.`);
    }
    const height = heights.get(path);
    if (height !== undefined) {
      if (ancestors.size + height > SHARED_SKILL_LIMITS.closureDepth) {
        throw opError('invalid_params', 'The shared edit exceeds dependency depth.',
          `Flatten depends_on so skill ${name}'s dependency chain is at most ${SHARED_SKILL_LIMITS.closureDepth} levels deep, then resubmit with a new request_id.`);
      }
      return height;
    }
    const file = available.get(path);
    if (!file) {
      throw opError('invalid_params', 'The shared edit introduces a dependency absent from another affected skill; use a declared shared dependency or a skill-local fork.',
        `Skill ${name} would depend on ${path}, which it does not include. Keep that file in skills/conventions/ for every skill that shares it, or fork it under skills/${name}/ and point depends_on there, then resubmit with a new request_id.`);
    }
    visited.set(path, file);
    const maximum = file.depends_on.reduce((maximum, dependency) => Math.max(maximum, 1 + walk(dependency, new Set([...ancestors, path]))), 0);
    heights.set(path, maximum);
    return maximum;
  };
  walk(`skills/${name}/SKILL.md`, new Set());
  return normalizeSkillFiles(name, [...visited.values()].map(file => ({ ...file, content: file.content, encoding: 'base64' })));
}
export async function submitSharedSkillMutation(ctx: OperationContext, operation: 'put_skill' | 'delete_skill', params: Record<string, unknown>, adoption?: HostAdoption): Promise<Record<string, unknown>> {
  assertPersistenceAccepting(ctx.engine);
  assertSkillCapability(ctx, 'skill_editor', operation);
  if (adoption && ctx.remote !== false) {
    throw opError('permission_denied', 'Pack adoption requires trusted host authority.',
      'Only the gbrain CLI on the brain host adopts canonical packs (gbrain init and the shared-content migration do it); a remote connection publishes individual skills with put_skill instead.');
  }
  const sourceId = pageMutationSource(ctx, params, operation);
  const name = skillName(params.name);
  const packId = skillName(params.pack_id, 'pack_id');
  if (ctx.remote !== false && typeof params.request_id !== 'string') {
    throw opError('invalid_params', 'Remote publication requires a durable request_id.',
      `Pass request_id as a new UUID (for example ${randomUUID()}) and keep it: reuse it only to resubmit this identical ${operation}, so a lost response never publishes twice.`);
  }
  if (ctx.remote !== false && typeof params.source_incarnation !== 'string') {
    throw opError('invalid_params', 'Remote publication must bind the source_incarnation.',
      `Pass source_incarnation for source ${sourceId} as list_skills (schema_version 2) reports it, so the publication cannot land on a recreated source.`,
      { fix: catalogFix(sourceId) });
  }
  const expected = precondition(params.expected_revision, skillHeadFix(sourceId, packId, name));
  const requestId = params.request_id === undefined ? randomUUID() : requireUuid(String(params.request_id));
  const slug = `skills/${name}/SKILL.md`;
  enforceClientSlugFence(ctx, slug, operation); enforceSubagentSlugFence(ctx, slug, operation);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const callerIntent: Record<string, unknown> = { ...params, expected_revision: expected, ...(adoption ? { adoption } : {}) }; delete callerIntent.request_id;
  const prior = await getWriteRequest(ctx.engine, principal, requestId);
  if (prior) {
    await submissionAuthority(ctx, prior.operation, prior.source_id, prior.source_incarnation, prior.slug);
    await authorizeStoredRequest(ctx.engine, prior);
    await assertStoredSkillCapability(ctx.engine, prior.authority, 'skill_editor');
    for (const target of (prior.authority as SkillAuthority).skillSlugsUsed ?? [prior.slug]) await authorizeWrite(ctx.engine, prior.authority, prior.operation, target);
    assertReplayIntent(prior, intentDigest({ operation, sourceId, slug, callerIntent }));
    return writeResponse(await waitForWrite(ctx.engine, prior, ctx.config, ctx.writeWaitMs));
  }
  await assertSharedSkillPersistence(ctx.engine);
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived || params.source_incarnation !== undefined && params.source_incarnation !== source.incarnation) {
    throw opError('source_changed', 'The publication source is no longer active at this incarnation.',
      `Source ${sourceId} was archived or recreated since this skill was read, so nothing was published. List the catalog again for its current source_incarnation and revisions, then resubmit with a new request_id.`,
      { fix: catalogFix(sourceId) });
  }
  const { binding, root } = await sourceRoot(ctx.engine, sourceId, source.incarnation, ctx);
  const authority: SkillAuthority = await submissionAuthority(ctx, operation, sourceId, source.incarnation, slug);
  await assertStoredSkillCapability(ctx.engine, authority, 'skill_editor');
  const [pack] = await ctx.engine.executeRaw<PackRow>('SELECT * FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [sourceId, source.incarnation]);
  if (pack && pack.pack_id !== packId) {
    throw opError('invalid_params', 'The source has a different canonical pack identity.',
      `Source ${sourceId}'s canonical pack is ${pack.pack_id}; pass pack_id ${pack.pack_id}, or publish pack ${packId} to a different source.`,
      { fix: catalogFix(sourceId) });
  }
  const keys = await headKeys(ctx.engine, sourceId, source.incarnation, packId);
  const inventory = packInventory(pack, keys, sourceId);
  const proposedNames = [...new Set([name, ...(adoption?.skills ?? []).map(input => skillName(input.name))])];
  const current = await heads(ctx.engine, sourceId, source.incarnation, packId, proposedNames);
  const old = current.find(r => r.name === name);
  if ((old?.revision ?? null) !== expected) {
    throw opError('revision_conflict', 'The skill changed since the supplied revision.',
      `Read ${packId}/${name} again, reapply the change to its current revision (null if it no longer exists), and resubmit with a new request_id.`,
      { fix: skillHeadFix(sourceId, packId, name) });
  }
  if (operation === 'delete_skill' && (!old || old.deleted)) {
    throw opError('skill_not_found', 'There is no active skill to delete.',
      `${packId}/${name} on source ${sourceId} has no active head (already deleted or never published), so there is nothing to delete.`,
      { fix: catalogFix(sourceId) });
  }
  const files = operation === 'put_skill' ? normalizeSkillFiles(name, params.files) : [];
  const metadata = operation === 'put_skill' ? skillMetadata(name, files, params) : old!.metadata;
  if (ctx.remote !== false && old && operation === 'put_skill') {
    if (old.metadata.private && !metadata.private || files.some(file => {
      const previous = old.files.find(prior => prior.path === file.path);
      return previous && (previous.file_class !== file.file_class || file.audience.some(audience => !previous.audience.includes(audience)));
    })) {
      throw opError('approval_required', 'Widening an existing skill disclosure or file class requires a trusted owner-reviewed import, not editor authority.',
        `Keep ${packId}/${name}'s existing private flag, file_class and audience values and resubmit; if the wider disclosure is intended, ask the user to have the owner publish it through import_skill_proposal from the CLI on the brain host.`,
        { fix: skillHeadFix(sourceId, packId, name) });
    }
  }
  const proposals = (adoption?.skills ?? [{ name, files: params.files, expected_revision: expected, ...params }]).map(input => {
    const proposedName = skillName(input.name);
    if (operation === 'delete_skill') return { name, files: [], metadata, expected_revision: expected };
    const proposedFiles = normalizeSkillFiles(proposedName, input.files);
    return { name: proposedName, files: proposedFiles, metadata: skillMetadata(proposedName, proposedFiles, { ...input }), expected_revision: precondition(input.expected_revision, skillHeadFix(sourceId, packId, proposedName)) };
  });
  if (new Set(proposals.map(p => p.name)).size !== proposals.length) {
    throw opError('invalid_params', 'Duplicate adoption skill identities.', `List each skill of pack ${packId} once in the adoption inventory, then adopt again.`);
  }
  const policy = await readSharedSkillPolicy(ctx.engine, sourceId, source.incarnation, await publicationEnabled(ctx));
  validateDisclosure(files, metadata, policy.policy, policy.epoch === 'legacy-prose' || policy.epoch === 'consent-required', sourceId);
  if (ctx.remote !== false && ['legacy-prose', 'consent-required'].includes(policy.epoch) && metadata.requirements.some(r => !old?.metadata.requirements.includes(r))) {
    throw opError('requirements_changed', 'New runtime requirements require separate publisher approval.',
      `Source ${sourceId} has no explicit version 1 publication policy yet, so new runtime requirements need the publisher's approval first. Drop them and resubmit, or ask the user whether the publisher should approve a policy with set_skill_policy.`,
      { fix: policyFix(sourceId) });
  }
  for (const proposal of proposals) {
    if ((current.find(r => r.name === proposal.name)?.revision ?? null) !== proposal.expected_revision) {
      throw opError('revision_conflict', 'An adopted skill changed after inventory.',
        `${packId}/${proposal.name} changed after the adoption inventory was read; read the pack again and adopt from the fresh inventory.`,
        { fix: skillHeadFix(sourceId, packId, proposal.name) });
    }
    validateDisclosure(proposal.files, proposal.metadata, policy.policy, policy.epoch === 'legacy-prose' || policy.epoch === 'consent-required', sourceId);
  }
  const affected: PublicationIntent['affected'] = [...new Map(proposals.flatMap(proposal => affectedSkills(inventory, proposal.name, proposal.files))
    .map(entry => [entry.name, { name: entry.name, revision: entry.revision }])).values()];
  for (const proposal of proposals) if (!affected.some(entry => entry.name === proposal.name)) {
    affected.push({ name: proposal.name, revision: keys.find(key => key.name === proposal.name)?.revision ?? null });
  }
  authority.skillSlugsUsed = affected.map(r => `skills/${r.name}/SKILL.md`).sort();
  if (adoption) authority.skillAdoptionPreconditions = Object.fromEntries(proposals.map(p => [p.name, p.expected_revision]));
  if (adoption?.expected_hashes) authority.skillAdoptionInventory = { ...adoption.expected_hashes };
  for (const target of authority.skillSlugsUsed) await authorizeWrite(ctx.engine, authority, operation, target);
  const dependents = affected.filter(target => !proposedNames.includes(target.name)).map(target => target.name);
  current.push(...await heads(ctx.engine, sourceId, source.incarnation, packId, dependents));
  if (affected.some(target => (current.find(head => head.name === target.name)?.revision ?? null) !== target.revision)) {
    throw opError('revision_conflict', 'An affected skill changed while preparing admission.',
      `A skill that shares files with ${packId}/${name} changed while this publication was being admitted, so nothing was accepted. Read ${packId}/${name} again and resubmit with a new request_id.`,
      { fix: skillHeadFix(sourceId, packId, name) });
  }
  const manifestBytes = canonicalRead(root, 'skillpack.json');
  if (!pack && manifestBytes && (!adoption || adoption.mode === 'proposal')) {
    throw opError('approval_required', 'An unadopted skillpack already exists on disk. A trusted host must adopt its complete reviewed inventory before individual skill publication.',
      `Source ${sourceId}'s checkout has a skillpack.json that was never adopted. The brain host's operator reviews and adopts the whole pack through the shared-content migration (preview its per-source actions with the command in fix), then individual skills can publish.`,
      { fix: hostFix(ctx, ['gbrain', 'apply-migrations', '--migration', '0.53.0', '--dry-run', '--json'], `Previews the shared-content migration's remaining per-source stages, including adoption of source ${sourceId}'s existing pack; it changes nothing.`) });
  }
  let manifest: Record<string, unknown> = {};
  const manifestInput = manifestBytes?.toString('utf8') ?? adoption?.initial_files?.['skillpack.json'];
  if (manifestInput) {
    try { manifest = JSON.parse(manifestInput); }
    catch {
      throw opError('local_conflict', 'The canonical skillpack manifest is malformed.',
        `skillpack.json in source ${sourceId}'s canonical checkout is not valid JSON. Fix or restore it from Git on the brain host, then publish again.`);
    }
    if (manifest.name !== packId || manifest.brain_resident !== true) {
      throw opError('local_conflict', 'Canonical manifest identity disagrees with publication.',
        `skillpack.json in source ${sourceId}'s checkout must name pack ${packId} and set brain_resident: true. Publish with the pack_id the manifest declares, or have the brain host's operator correct the manifest.`);
    }
  }
  if (!pack && adoption && manifestInput) {
    if (!Array.isArray(manifest.skills) || manifest.skills.some(path => typeof path !== 'string' || !/^skills\/[a-z0-9][a-z0-9_-]*$/.test(path)) ||
      manifest.skills.some(path => !proposals.some(proposal => path === `skills/${proposal.name}`))) {
      throw opError('approval_required', 'Initial adoption must include every skill declared in the reviewed manifest.',
        `Include every skills/ entry declared in pack ${packId}'s skillpack.json in the adoption (or remove undeclared entries from the reviewed manifest), then adopt again.`);
    }
  }
  const manifestHash = manifestBytes ? sha256(manifestBytes) : null;
  if (pack && manifestHash !== pack.manifest_hash && adoption?.expected_hashes?.['skillpack.json'] !== manifestHash) {
    throw opError('local_conflict', 'The canonical manifest has unpublished edits.',
      `skillpack.json in source ${sourceId}'s checkout was edited outside gbrain. Restore the published manifest, or publish the reviewed edit through import_skill_proposal from the CLI on the brain host with its current SHA-256 in expected_hashes, then publish again.`);
  }
  const beforeHashes: Record<string, string | null> = {};
  const allProposedFiles = proposals.flatMap(p => p.files);
  const sharedFiles = new Map<string, StoredSkillFile>();
  for (const file of allProposedFiles) {
    const other = sharedFiles.get(file.path);
    if (other && stableJson(other) !== stableJson(file)) {
      throw opError('invalid_params', 'A shared dependency must have identical pinned content and policy in every skill.',
        `Give ${file.path} the same content, file_class, audience and depends_on in every skill that includes it, then resubmit.`);
    }
    sharedFiles.set(file.path, file);
  }
  const extraFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(adoption?.initial_files ?? {})) {
    if (path === 'skillpack.json' || allProposedFiles.some(file => file.path === path && Buffer.from(file.content, 'base64').toString('utf8') === content)) continue;
    if (!['README.md', 'LICENSE', 'NOTICE', 'PROVENANCE.md', 'provenance.json'].includes(path) || typeof content !== 'string' || Buffer.byteLength(content) > SHARED_SKILL_LIMITS.fileBytes) {
      throw opError('invalid_params', 'Only declared skill files and bounded pack README/license/provenance artifacts may be initialized.',
        `Limit initial_files to declared skill files plus README.md, LICENSE, NOTICE, PROVENANCE.md and provenance.json of at most ${SHARED_SKILL_LIMITS.fileBytes} bytes each; declare any other file in a skill bundle.`);
    }
    extraFiles[path] = content;
  }
  const touched = new Set([...allProposedFiles.map(f => f.path), ...current.filter(r => affected.some(p => p.name === r.name)).flatMap(r => r.files.map(f => f.path)), ...Object.keys(extraFiles)]);
  for (const [path, expectedHash] of Object.entries(adoption?.expected_hashes ?? {})) {
    if (path !== 'skillpack.json') skillPath(path);
    if (expectedHash !== null && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) {
      throw opError('invalid_params', 'Reviewed file hashes must be lowercase SHA-256 or null for an absent file.',
        `Set expected_hashes[${JSON.stringify(path)}] to the lowercase 64-character SHA-256 of the file's current bytes, or null if the file does not exist.`);
    }
    const disk = canonicalRead(root, path);
    if ((disk === null ? null : sha256(disk)) !== expectedHash) {
      throw opError('local_conflict', 'The reviewed inventory changed before publication.',
        `${path} in source ${sourceId}'s checkout changed after its hash was reviewed. Review the current file, recompute its SHA-256 in expected_hashes, and submit again.`);
    }
  }
  if (adoption?.mode === 'proposal' && [...touched, 'skillpack.json'].some(path => !Object.hasOwn(adoption.expected_hashes ?? {}, path))) {
    throw opError('invalid_params', 'A reviewed proposal must supply current hashes for every affected file and skillpack.json.',
      `Add expected_hashes entries (current SHA-256, or null when absent) for ${[...touched, 'skillpack.json'].filter(path => !Object.hasOwn(adoption.expected_hashes ?? {}, path)).join(', ')}, then submit again.`);
  }
  const sealedFiles = new Map(inventory.flatMap(entry => entry.files).map(file => [file.path, file]));
  for (const entry of current) if (!entry.deleted) for (const file of entry.files) sealedFiles.set(file.path, file);
  for (const path of touched) {
    const disk = canonicalRead(root, path);
    beforeHashes[path] = disk === null ? null : sha256(disk);
    const sealed = sealedFiles.get(path);
    const reviewed = adoption?.expected_hashes !== undefined && Object.hasOwn(adoption.expected_hashes, path) && adoption.expected_hashes[path] === beforeHashes[path];
    if (sealed && beforeHashes[path] !== sealed.sha256 && !reviewed) {
      throw opError('local_conflict', 'A canonical file has unpublished edits; use import_skill_proposal with the reviewed current file hashes.',
        `${path} in source ${sourceId}'s checkout has edits that were never published. Restore the published bytes, or publish the reviewed edit through import_skill_proposal from the CLI on the brain host with the file's current SHA-256 in expected_hashes, then resubmit.`);
    }
    const proposedHash = allProposedFiles.find(f => f.path === path)?.sha256 ?? (extraFiles[path] === undefined ? undefined : sha256(extraFiles[path]));
    if (!sealed && disk !== null && (!adoption || proposedHash !== beforeHashes[path] && !reviewed)) {
      throw opError('local_conflict', 'Publication would overwrite an unadopted file.',
        `${path} already exists in source ${sourceId}'s checkout but was never adopted. Ask the user whether to move it aside or adopt it on the brain host before publishing over it; nothing was written.`);
    }
  }
  const { skills: _skills, shared_skills: _sharedSkills, ...manifestMetadata } = manifest;
  const intent: PublicationIntent = { pack_id: packId, name, expected_revision: expected, policy_epoch: policy.epoch,
    affected: affected.map(r => ({ name: r.name, revision: r.revision ?? null })), expected_pack_revision: pack?.revision ?? null,
    manifest_before_hash: manifestBytes ? sha256(manifestBytes) : null, original_manifest: manifestMetadata, before_hashes: beforeHashes, proposals, extra_files: extraFiles };
  const row = await admitWrite(ctx.engine, { principal, operation, sourceId, sourceIncarnation: source.incarnation, slug, requestId,
    targetKind: 'skill_bundle', protocolVersion: 2, callerIntent, intent: intent as unknown as Record<string, unknown>, authority,
    worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  return writeResponse(await waitForWrite(ctx.engine, row, ctx.config, ctx.writeWaitMs));
}

export async function prepareSharedSkillMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  if (!['put_skill', 'delete_skill'].includes(row.operation) || row.target_kind !== 'skill_bundle' || row.protocol_version !== 2 || !row.intent) {
    throw opError('unsupported_mutation_protocol', 'Unsupported shared skill publication target.',
      `Write request ${row.request_id} is not a shared-skill publication this gbrain can prepare; it was probably accepted by another gbrain version. Run gbrain upgrade on every host that serves this brain; the request stays journaled for inspection.`);
  }
  const intent = row.intent as unknown as PublicationIntent;
  skillName(intent.name); skillName(intent.pack_id, 'pack_id');
  await assertSharedSkillPersistence(engine);
  await authorizeStoredRequest(engine, row);
  await assertStoredSkillCapability(engine, row.authority, 'skill_editor');
  const { root } = await sourceRoot(engine, row.source_id, row.source_incarnation);
  const [currentPack] = await engine.executeRaw<PackRow>('SELECT * FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [row.source_id, row.source_incarnation]);
  const keys = await headKeys(engine, row.source_id, row.source_incarnation, intent.pack_id);
  const inventory = packInventory(currentPack, keys, row.source_id);
  const changedAfterAdmission = (message: string) => opError('revision_conflict', message,
    `${intent.pack_id}/${intent.name} or a skill sharing its files changed after request ${row.request_id} was accepted, so it did not publish. Read the skill again, reapply the change, and resubmit with a new request_id.`,
    { fix: skillHeadFix(row.source_id, intent.pack_id, intent.name) });
  const current = await heads(engine, row.source_id, row.source_incarnation, intent.pack_id, intent.affected.map(target => target.name));
  if ((currentPack?.revision ?? null) !== intent.expected_pack_revision || intent.affected.some(target => (current.find(head => head.name === target.name)?.revision ?? null) !== target.revision)) {
    throw changedAfterAdmission('The pack or a skill in its closure changed after admission.');
  }
  const proposals = intent.proposals;
  const replacement = new Map(proposals.flatMap(p => p.files).map(f => [f.path, f]));
  const revisions = intent.affected.map(target => {
    const old = current.find(r => r.name === target.name);
    const proposed = proposals.find(p => p.name === target.name);
    const files = proposed ? proposed.files : rebuildDependentClosure(target.name, old!.files, replacement);
    const metadata = { ...(proposed ? proposed.metadata : old!.metadata), file_policy: files.map(f => ({ file_class: f.file_class, audience: f.audience })) };
    return { name: target.name, revision: randomUUID(), metadata,
      deleted: target.name === intent.name && row.operation === 'delete_skill',
      files };
  });
  const revisionByName = new Map(revisions.map(r => [r.name, r]));
  const next = [...inventory.filter(entry => !revisionByName.has(entry.name)), ...revisions.filter(entry => !entry.deleted).map(entry => ({
    name: entry.name, revision: entry.revision, files: entry.files.map(({ content: _content, ...file }) => file),
  }))];
  const allFiles = new Set(next.flatMap(entry => entry.files.map(file => file.path)));
  const changedFiles = new Map<string, StoredSkillFile | null>();
  for (const file of proposals.flatMap(p => p.files)) changedFiles.set(file.path, file);
  for (const file of current.filter(r => revisions.some(p => p.name === r.name)).flatMap(r => r.files)) if (!allFiles.has(file.path)) changedFiles.set(file.path, null);
  const manifest = { ...intent.original_manifest, name: intent.pack_id, brain_resident: true,
    skills: next.map(entry => `skills/${entry.name}`).sort(), shared_skills: { schema_version: 2, skills: next.sort((a, b) => a.name.localeCompare(b.name)) } };
  const manifestContent = `{\n${Object.entries(manifest).map(([key, value]) =>
    key === 'shared_skills'
      ? `  "shared_skills": {"schema_version":2,"skills":[\n${manifest.shared_skills.skills.map(skill => `    ${JSON.stringify(skill)}`).join(',\n')}\n  ]}`
      : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')}\n}\n`;
  const packRevision = randomUUID();
  let prunedRevisions = 0;
  const totalBytes = Buffer.byteLength(manifestContent) + [...changedFiles.values()].reduce((sum, file) => sum + (file?.size ?? 0), 0) + Object.values(intent.extra_files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  if (totalBytes > SHARED_SKILL_LIMITS.bundleBytes || changedFiles.size + Object.keys(intent.extra_files).length + 1 > SHARED_SKILL_LIMITS.files) {
    throw opError('invalid_params', 'The complete canonical publication exceeds the file-set bound.',
      `Request ${row.request_id} would write ${changedFiles.size + Object.keys(intent.extra_files).length + 1} files and ${totalBytes} bytes; one publication may write at most ${SHARED_SKILL_LIMITS.files} files and ${SHARED_SKILL_LIMITS.bundleBytes} bytes. Split the shared-conventions edit into smaller changes and resubmit each with a new request_id.`);
  }
  return {
    target: 'skill_bundle', sourceExclusive: true, observedRevision: intent.expected_revision,
    files: [...changedFiles].map(([path, file]) => ({ path: join(root, path), root, content: file ? Buffer.from(file.content, 'base64') : null,
      expectedBeforeHash: intent.before_hashes[path] ?? null })).concat([{ path: join(root, 'skillpack.json'), root,
        content: Buffer.from(manifestContent), expectedBeforeHash: intent.manifest_before_hash },
        ...Object.entries(intent.extra_files).map(([path, content]) => ({ path: join(root, path), root, content: Buffer.from(content), expectedBeforeHash: intent.before_hashes[path] ?? null }))]),
    async validate(tx) {
      await assertStoredSkillCapability(tx, row.authority, 'skill_editor', true);
      for (const target of intent.affected) await authorizeWrite(tx, row.authority, row.operation, `skills/${target.name}/SKILL.md`, true);
      const ctx = { engine: tx, config } as OperationContext;
      const policy = await readSharedSkillPolicy(tx, row.source_id, row.source_incarnation, await publicationEnabled(ctx), true);
      if (policy.epoch !== intent.policy_epoch) {
        throw opError('approval_required', 'Publication policy changed after this request was accepted.',
          `Source ${row.source_id}'s publication policy changed after request ${row.request_id} was accepted, so it did not publish. Review the current policy, then resubmit with a new request_id if the skill still fits it.`,
          { fix: policyFix(row.source_id) });
      }
      for (const revision of revisions) validateDisclosure(revision.files, revision.metadata, policy.policy, policy.epoch === 'legacy-prose' || policy.epoch === 'consent-required', row.source_id);
      const [pack] = await tx.executeRaw<Pick<PackRow, 'revision'>>('SELECT revision FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid FOR UPDATE', [row.source_id, row.source_incarnation]);
      if ((pack?.revision ?? null) !== intent.expected_pack_revision) throw changedAfterAdmission('The pack changed after this request was accepted.');
      for (const target of [...intent.affected].sort((a, b) => a.name.localeCompare(b.name))) {
        const [head] = await tx.executeRaw<{ revision: string }>(`SELECT revision FROM shared_skill_heads
          WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 AND name=$4 FOR UPDATE`, [row.source_id, row.source_incarnation, intent.pack_id, target.name]);
        if ((head?.revision ?? null) !== target.revision) throw changedAfterAdmission('A skill in the dependency closure changed.');
      }
      prunedRevisions = await withCoordinatedWrite(tx, [row.source_id], () => pruneSharedSkillRevisionsInTransaction(tx, row.source_id, row.source_incarnation), requestAttribution(row));
      const capacity = await sharedSkillRetentionCapacity(tx, row.source_id, row.source_incarnation);
      const [incoming] = await tx.executeRaw<{ bytes: number | string }>(`SELECT COALESCE(SUM(octet_length(r.metadata::text)+octet_length(r.files::text)),0) AS bytes
        FROM jsonb_to_recordset($1::text::jsonb) AS r(metadata jsonb,files jsonb)`, [JSON.stringify(revisions)]);
      assertSharedSkillRetentionCapacity(capacity, revisions.length, Number(incoming.bytes), !row.authority.remote);
    },
    async apply(tx) {
      for (const revision of revisions) {
        await tx.executeRaw(`INSERT INTO shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision,metadata,files,deleted,policy_epoch,request_id)
          VALUES($1,$2::uuid,$3,$4,$5::uuid,$6::text::jsonb,$7::text::jsonb,$8,$9,$10::uuid)`,
        [row.source_id, row.source_incarnation, intent.pack_id, revision.name, revision.revision, JSON.stringify(revision.metadata), JSON.stringify(revision.files), revision.deleted, intent.policy_epoch, row.id]);
        await tx.executeRaw(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,deleted,policy_epoch)
          VALUES($1,$2::uuid,$3,$4,$5::uuid,$6::text::jsonb,$7,$8) ON CONFLICT(source_id,source_incarnation,pack_id,name)
          DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata,deleted=excluded.deleted,policy_epoch=excluded.policy_epoch,updated_at=now()`,
        [row.source_id, row.source_incarnation, intent.pack_id, revision.name, revision.revision, JSON.stringify(revision.metadata), revision.deleted, intent.policy_epoch]);
      }
      await tx.executeRaw(`INSERT INTO shared_skill_packs(source_id,source_incarnation,pack_id,revision,manifest,manifest_hash)
        VALUES($1,$2::uuid,$3,$4::uuid,$5::text::jsonb,$6) ON CONFLICT(source_id,source_incarnation)
        DO UPDATE SET revision=excluded.revision,manifest=excluded.manifest,manifest_hash=excluded.manifest_hash`,
      [row.source_id, row.source_incarnation, intent.pack_id, packRevision, JSON.stringify(manifest), sha256(manifestContent)]);
      const primary = revisions.find(r => r.name === intent.name)!;
      const retained = !row.authority.remote ? await sharedSkillRetentionStatus(tx, row.source_id, row.source_incarnation) : undefined;
      return { status: primary.deleted ? 'deleted' : 'published', source_id: row.source_id, source_incarnation: row.source_incarnation,
        pack_id: intent.pack_id, name: intent.name, revision: primary.revision,
        affected_skills: revisions.map(r => ({ name: r.name, revision: r.revision })), delivery: 'canonical_committed',
        ...(retained ? { retention: { ...retained, pruned_revisions: prunedRevisions } } : {}) };
    },
  };
}

export interface AdoptSharedSkillpackOptions {
  request_id?: string;
  policy?: SharedSkillPolicy;
  expected_policy_epoch?: string | null;
  pack_id?: string;
  skills?: SharedSkillPutInput[];
  initial_files?: Record<string, string>;
  expected_hashes?: Record<string, string | null>;
}
export async function importSharedSkillProposal(ctx: OperationContext, params: Record<string, unknown>) {
  if (ctx.remote !== false) {
    throw opError('permission_denied', 'Reviewed skill proposals require the trusted local operator.',
      'Only the gbrain CLI on the brain host imports reviewed proposals; the person there runs the command in fix with the reviewed parameters.', {
        fix: { ...hostFix(ctx, ['gbrain', 'call', 'import_skill_proposal', '<params_json>'], 'Imports the reviewed canonical files under the trusted local operator; remote editors cannot widen disclosure.'),
          inputs: [{ name: 'params_json', how: 'The same put_skill parameters plus expected_hashes (current SHA-256 per affected file and skillpack.json), as one JSON object.' }] },
      });
  }
  const { expected_hashes: hashes, ...input } = params;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.keys(hashes).length > SHARED_SKILL_LIMITS.files * 2) {
    throw opError('invalid_params', 'A reviewed proposal requires a bounded expected_hashes object.',
      `Pass expected_hashes as an object mapping each affected file path and skillpack.json to its current lowercase SHA-256 (null for an absent file), with at most ${SHARED_SKILL_LIMITS.files * 2} entries.`);
  }
  return submitSharedSkillMutation(ctx, 'put_skill', input, { mode: 'proposal', skills: [input as unknown as SharedSkillPutInput], expected_hashes: hashes as Record<string, string | null> });
}
export async function adoptSharedSkillpack(ctx: OperationContext, sourceId: string, options: AdoptSharedSkillpackOptions = {}) {
  if (ctx.remote !== false) {
    throw opError('permission_denied', 'Canonical pack adoption is a trusted host operation.',
      'Only the gbrain CLI on the brain host adopts canonical packs (gbrain init and the shared-content migration do it); a remote connection publishes individual skills with put_skill instead.');
  }
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) {
    throw opError('source_changed', 'The adoption source is not active.',
      `Source ${sourceId} is archived or not registered; adopt the pack into an active source.`,
      { fix: readFix('Lists the registered sources and whether each is archived.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  }
  const { root } = await sourceRoot(ctx.engine, sourceId, source.incarnation, ctx);
  if (options.policy) await setSharedSkillPolicy(ctx, sourceId, options.policy, options.expected_policy_epoch);
  const manifestBytes = canonicalRead(root, 'skillpack.json');
  let manifest: Record<string, unknown> = {};
  const manifestInput = manifestBytes?.toString() ?? options.initial_files?.['skillpack.json'];
  if (manifestInput) {
    try { manifest = JSON.parse(manifestInput); } catch {
      throw opError('local_conflict', 'The source manifest is malformed.',
        `skillpack.json in source ${sourceId}'s checkout is not valid JSON. Fix or restore it from Git, then adopt again.`);
    }
    if (manifest.brain_resident !== true) {
      throw opError('approval_required', 'The existing manifest is not approved as a brain-resident pack.',
        `skillpack.json in source ${sourceId}'s checkout does not set brain_resident: true. Ask the user whether this pack should become a shared brain-resident pack; only after they agree, set brain_resident: true in the manifest and adopt again.`);
    }
  }
  const packId = skillName(options.pack_id ?? manifest.name, 'pack_id');
  const existing = await headKeys(ctx.engine, sourceId, source.incarnation, packId);
  const exclusions = manifest.excluded_from_install;
  if (exclusions !== undefined && (!Array.isArray(exclusions) || exclusions.some(name => typeof name !== 'string'))) {
    throw opError('approval_required', 'Unknown pack exclusion intent requires review.',
      `excluded_from_install in source ${sourceId}'s skillpack.json must be a list of skill names or skills/ paths. Review what it should exclude with the user, correct the manifest, and adopt again.`);
  }
  const inputs: SharedSkillPutInput[] = options.skills ?? (Array.isArray(manifest.skills) ? manifest.skills : []).map((path: unknown) => {
    const relative = skillPath(path);
    if (!/^skills\/[a-z0-9][a-z0-9_-]*$/.test(relative)) {
      throw opError('local_conflict', 'An existing skill path needs explicit migration review.',
        `skillpack.json in source ${sourceId} declares ${relative}, which is not a top-level skills/ directory with a lowercase name. Review the move with the user, relocate it under skills/ and update the manifest, then adopt again.`);
    }
    const name = skillName(relative.slice('skills/'.length));
    const content = canonicalRead(root, `${relative}/SKILL.md`);
    if (!content) {
      throw opError('local_conflict', 'A declared skill is missing; the import is incomplete.',
        `${relative}/SKILL.md is declared in source ${sourceId}'s skillpack.json but missing from its checkout. Restore it, or remove the entry from the manifest, then adopt again.`);
    }
    return { pack_id: packId, name, expected_revision: existing.find(r => r.name === name)?.revision ?? null,
      ...((exclusions as string[] | undefined)?.some(value => value === name || value === relative) ? { private: true } : {}),
      files: [{ path: `${relative}/SKILL.md`, content: content.toString('utf8'), file_class: 'prose' as const }] };
  });
  if (!inputs.length) {
    throw opError('invalid_params', 'No declared skill bundle is available to adopt.',
      `Source ${sourceId}'s skillpack.json declares no skills. Add its skills/ entries to the manifest (or pass the skills explicitly), then adopt again.`);
  }
  const seed = digest({ request: options.request_id ?? inputs.map(({ expected_revision: _revision, ...input }) => input), sourceId, incarnation: source.incarnation, packId });
  const requestId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
  await initializeLocalPersistence(ctx);
  const prior = await getWriteRequest(ctx.engine, await requestPrincipalForContext(ctx), requestId);
  let expectedHashes = options.expected_hashes;
  if (prior && !options.skills) {
    const accepted = (prior.authority as SkillAuthority).skillAdoptionPreconditions;
    if (!accepted) {
      throw opError('idempotency_conflict', 'The original adoption preconditions are unavailable.',
        `Request ${requestId} was accepted without its adoption preconditions, so replaying it is unsafe. Inspect that receipt before adopting source ${sourceId}'s pack again.`,
        { fix: readFix(`Shows request ${requestId}'s state and outcome before anything is resubmitted.`, { argv: ['gbrain', 'write-request', '--', requestId] }) });
    }
    for (const input of inputs) if (Object.hasOwn(accepted, input.name)) input.expected_revision = accepted[input.name];
    const acceptedInventory = (prior.authority as SkillAuthority).skillAdoptionInventory;
    if (expectedHashes && acceptedInventory) {
      const [pack] = await ctx.engine.executeRaw<PackRow>('SELECT * FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [sourceId, source.incarnation]);
      const changed = Object.keys(expectedHashes).filter(path => expectedHashes![path] !== acceptedInventory[path]);
      if (changed.length === 1 && changed[0] === 'skillpack.json' && pack?.manifest_hash === expectedHashes['skillpack.json']) {
        expectedHashes = { ...expectedHashes, 'skillpack.json': acceptedInventory['skillpack.json'] };
      }
    }
  }
  const input = inputs[0];
  const receipts = [await submitSharedSkillMutation(ctx, 'put_skill', { ...input, pack_id: packId, source_id: sourceId,
    source_incarnation: source.incarnation, request_id: requestId }, { skills: inputs, initial_files: options.initial_files, expected_hashes: expectedHashes })];
  return { schema_version: 2 as const, source_id: sourceId, source_incarnation: source.incarnation, pack_id: packId, receipts };
}
