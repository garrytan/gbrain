import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isThinClient } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { getWorktreeBinding, readPersistenceBrain } from '../persistence/ownership.ts';
import { checkedContentRoot, inventorySkillpack, sameInventory, type PackInventory } from './setup-files.ts';
import { contentSetupKey, installPackagedSharedSkills, setupSharedBrainContent, type SharedContentReceipt } from './setup.ts';
import type { DatabaseContentExportReceipt } from './migration-export.ts';
import { inspectSharedMemberMigration, type SharedMemberMigration } from './migration-members.ts';
import { sharedSkillSourcePolicyOrPreserve } from './setup-source-policy.ts';
import { INVENTORY_LIMIT_CEILINGS, readInventoryLimits, type InventoryLimits } from './inventory-limits.ts';
import { SHARED_SKILL_LIMITS } from './model.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { isRustBrain, isRustClient, rustHeads, rustPublicationFlag, rustSource } from './rust-publication.ts';

export type MigrationPublication = 'disabled' | 'prose_only' | 'consent_required';
export interface SharedMigrationStage {
  stage: 'inventory' | 'ownership' | 'projection' | 'policy' | 'members';
  status: 'complete' | 'action_required' | 'conflict' | 'planned';
  reason?: string;
  /** A conflict's stable code, for readers that must not parse `reason`. */
  code?: string;
}
export interface SharedSourceMigration {
  source_id: string;
  source_incarnation: string;
  root: string | null;
  inventory: PackInventory | null;
  publication: MigrationPublication;
  stages: SharedMigrationStage[];
  status: 'complete' | 'action_required' | 'conflict' | 'planned';
  member_installations?: SharedMemberMigration[];
  parked?: SharedSourceParked;
  /** The source's policy could not be read, so the migration preserved its files without inspecting them. */
  policy_unverified?: true;
}
/**
 * A source whose pack exceeds an inventory bound. Later runs skip it without
 * re-inventorying (the migration completes instead of going partial) until the
 * configured bounds change, the source opts out, or
 * `gbrain sources shared-skills <id> on` releases it.
 */
export interface SharedSourceParked {
  limit: string;
  limits: InventoryLimits;
  reason: string;
  parked_at: string;
}
export interface SharedMigrationReport {
  version: 1;
  brain_id: string | null;
  dry_run: boolean;
  status: 'complete' | 'action_required' | 'conflict' | 'planned';
  sources: SharedSourceMigration[];
  pending_actions: string[];
  permission_changes: readonly [];
  content_export?: DatabaseContentExportReceipt;
}

export function migrationCheckpointKey(sourceId: string, incarnation: string): string {
  return `shared_skills.migration.v1.${sourceId}.${incarnation}`;
}

const sameLimits = (a: InventoryLimits, b: InventoryLimits): boolean =>
  (Object.keys(INVENTORY_LIMIT_CEILINGS) as Array<keyof InventoryLimits>).every(name => a[name] === b[name]);

export function parkedReason(sourceId: string, parked: SharedSourceParked): string {
  const ceiling = INVENTORY_LIMIT_CEILINGS[parked.limit.split('.').pop() as keyof InventoryLimits];
  return `payload_too_large: ${parked.reason} Parked: this source is skipped, not retried, and the rest of the migration completes. `
    + `Raise the bound (gbrain config set ${parked.limit} <n>, at most ${ceiling}), opt the source out (gbrain sources shared-skills ${sourceId} off), `
    + `or shrink the pack and release it (gbrain sources shared-skills ${sourceId} on); then run gbrain apply-migrations --migration 0.53.0 --yes. `
    + 'See docs/guides/shared-brain-skills.md#oversized-skill-packs.';
}

/** The digest an operator echoes to accept a reviewed inventory change (#5476): the sorted path/hash list. */
export function inventoryDigest(hashes: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(hashes).sort().map(path => [path, hashes[path]]))).digest('hex');
}

function changedInventoryPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}

export async function legacyPublication(ctx: OperationContext): Promise<MigrationPublication> {
  const dbValue = await ctx.engine.getConfig('mcp.publish_skills');
  const value = dbValue === null ? ctx.config.mcp?.publish_skills : dbValue;
  if (value === false || value === 'false') return 'disabled';
  if (value === true || value === 'true') return 'prose_only';
  return 'consent_required';
}

type SourceRoot = { id: string; incarnation: string; local_path: string | null };
type SealedSkill = { name: string; files: Array<{ path: string; sha256: string }> };

/**
 * The live (not archived) sources in byte order of id, with incarnation and registered root, from one typed read (no
 * SQL here), so the same code serves every engine, a Rust brain's owner and its clients included. One read keeps each
 * root paired with its own incarnation, and it parses no source config, so a malformed config stays that source's own
 * policy matter.
 */
async function liveSourceRoots(engine: OperationContext['engine']): Promise<SourceRoot[]> {
  return (await engine.listOnboardingSources(null)).map(row => ({ id: row.id, incarnation: row.incarnation, local_path: row.local_path }));
}

/**
 * Whether this host owns `root` as source `source`'s canonical root. A SQL brain needs the source's active worktree
 * binding at that path; a Rust brain has no worktree owners, so its canonical root is the live source's registered
 * path at this incarnation that no other live source shares (the check publication.ts makes before it publishes).
 */
async function ownsRoot(engine: OperationContext['engine'], source: SourceRoot, root: string): Promise<boolean> {
  if (isRustBrain(engine)) {
    const rust = await rustSource(engine, source.id);
    return !!rust && !rust.archived && rust.incarnation === source.incarnation && !!rust.local_path
      && resolve(rust.local_path) === root && rust.aliases.length === 0;
  }
  const binding = await getWorktreeBinding(engine, source.id);
  return !!binding && binding.state === 'active' && !!binding.owner_host_id && !!binding.local_path
    && resolve(join(binding.local_path, binding.relative_path)) === root;
}

/** The sealed pack's manifest hash for a source incarnation, or undefined without a pack. */
async function sealedManifestHash(engine: OperationContext['engine'], sourceId: string, incarnation: string): Promise<string | undefined> {
  return (await engine.readSharedSkillPackRow(sourceId, incarnation))?.manifest_hash;
}

/**
 * The live head revisions of a source incarnation (name and files), for the skills `names` declares. On a Rust brain the
 * store keeps one pack per source incarnation, so the heads read are that pack's. Like the catalog adoption that
 * follows these reads (catalog.ts, publication.ts), a Rust brain answers them in the process that owns the brain.
 */
async function sealedSkills(engine: OperationContext['engine'], sourceId: string, incarnation: string, names: string[]): Promise<SealedSkill[]> {
  if (isRustBrain(engine)) {
    const pack = await engine.readSharedSkillPackRow(sourceId, incarnation);
    if (!pack || names.length === 0) return [];
    return (await rustHeads(engine, sourceId, incarnation, pack.pack_id, names))
      .filter(revision => !revision.deleted)
      .map(revision => ({ name: revision.name, files: revision.files as SealedSkill['files'] }));
  }
  return engine.executeRaw<SealedSkill>(`SELECT r.name,r.files FROM shared_skill_heads h JOIN shared_skill_revisions r
          ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
          WHERE h.source_id=$1 AND h.source_incarnation=$2::uuid AND NOT r.deleted`, [sourceId, incarnation]);
}

export async function runSharedSkillsMigration(ctx: OperationContext, options: { dryRun?: boolean; acceptReviewedInventory?: Record<string, string> } = {}): Promise<SharedMigrationReport> {
  if (ctx.remote !== false) {
    throw opError('permission_denied', 'Shared-skills migration requires the trusted local host.',
      'The shared-skills migration runs only from gbrain apply-migrations on the brain host; a remote connection cannot run it.');
  }
  const dryRun = options.dryRun ?? ctx.dryRun;
  const report: SharedMigrationReport = { version: 1, brain_id: null, dry_run: dryRun, status: dryRun ? 'planned' : 'complete', sources: [], pending_actions: [], permission_changes: [] };
  if (isThinClient(ctx.config)) {
    report.status = 'action_required';
    report.pending_actions.push('Canonical-content migration belongs on the host. Reconnect this client after upgrading its adapter; no host repository or local grants were created.');
    return report;
  }
  // #6482: the shared fail-closed read; a missing singleton is `storage_error` with the writer-status probe, never "unmanaged".
  const brain = await readPersistenceBrain(ctx.engine);
  report.brain_id = brain.brain_id;
  const publication = await legacyPublication(ctx);
  const limits = await readInventoryLimits(ctx.engine);
  const roots = await liveSourceRoots(ctx.engine);
  const fallback = await ctx.engine.getConfig('sync.repo_path');
  for (const source of roots) {
    const sourcePolicy = await sharedSkillSourcePolicyOrPreserve(ctx.engine, source.id);
    const contentCheckpoint = await ctx.engine.getConfig(contentSetupKey(source.id, source.incarnation));
    if (contentCheckpoint && !dryRun && sourcePolicy.mode === 'content') {
      let content: SharedContentReceipt;
      try { content = JSON.parse(contentCheckpoint); }
      catch {
        throw opError('local_conflict', 'A content setup checkpoint is malformed; preserve it for review.',
          `The content setup checkpoint for source ${source.id} is not valid JSON. Show it to the user and ask how to proceed; do not delete it.`,
          { fix: readFix('Prints the saved content setup checkpoint.', { argv: ['gbrain', 'config', 'get', contentSetupKey(source.id, source.incarnation)] }) });
      }
      if (content.owned_root && content.stage !== 'complete') {
        const resumed = await setupSharedBrainContent({ ...ctx, sourceId: source.id }, { sourceId: source.id });
        if (resumed.root) source.local_path = resumed.root;
      }
    }
    const key = migrationCheckpointKey(source.id, source.incarnation);
    const row: SharedSourceMigration = { source_id: source.id, source_incarnation: source.incarnation,
      root: source.local_path || (source.id === 'default' ? fallback : null), inventory: null, publication, stages: [], status: dryRun ? 'planned' : 'complete' };
    report.sources.push(row);
    const persist = async () => { if (!dryRun) await ctx.engine.setConfig(key, JSON.stringify(row)); };
    const pending = async (stage: SharedMigrationStage['stage'], reason: string, conflictCode?: string) => {
      row.status = conflictCode ? 'conflict' : 'action_required';
      row.stages.push({ stage, status: row.status, reason, ...(conflictCode ? { code: conflictCode } : {}) });
      await persist();
    };
    // A client of a Rust brain's owner cannot read the owner-only skill store. That is host action named by its code,
    // never a conflict: a conflict ends the run partial, and partial runs count toward the wedge.
    const ownerOnly = async (stage: SharedMigrationStage['stage'], unchecked: string) => {
      row.status = 'action_required';
      row.stages.push({ stage, status: 'action_required', code: 'owner_unavailable', reason: `owner_unavailable: this run is a client of the process that owns this Rust brain `
        + `(such as gbrain serve, a sync or an import), and only the owner reads its shared-skill store, so source ${source.id}'s ${unchecked} was not checked and nothing changed. `
        + 'Run gbrain apply-migrations again when no other gbrain process holds this brain.' });
      await persist();
    };
    if (sourcePolicy.mode === 'preserve_files') {
      if (sourcePolicy.unverified) row.policy_unverified = true;
      row.member_installations = await inspectSharedMemberMigration(ctx.engine, source.id, source.incarnation);
      await pending('projection', sourcePolicy.reason);
      continue;
    }
    if (!row.root) {
      if (sourcePolicy.mode === 'explicit_pack_required') {
        await pending('projection', sourcePolicy.reason);
        continue;
      }
      await pending('inventory', 'db_only_export_required: preview gbrain apply-migrations --migration 0.53.0 --export-db-only --content-root <new-root> --export-source ' + source.id + ' --dry-run --json; approve quiescence and backup choice before exporting. Memory stays available.');
      continue;
    }
    const checkpoint = await ctx.engine.getConfig(key);
    let prior: SharedSourceMigration | null = null;
    try {
      if (checkpoint) prior = JSON.parse(checkpoint);
      row.root = checkedContentRoot(row.root);
      if (!existsSync(row.root)) {
        throw opError('local_conflict', 'The registered canonical root is missing.',
          `Source ${source.id}'s registered root ${row.root} does not exist. Restore it (from its Git remote or backup), then run the migration again.`);
      }
      if (prior?.parked && prior.root === row.root && sameLimits(prior.parked.limits, limits)) {
        row.inventory = prior.inventory;
        row.parked = prior.parked;
        await pending('inventory', parkedReason(source.id, row.parked));
        continue;
      }
      row.inventory = inventorySkillpack(row.root, limits);
      if (prior && (prior.source_incarnation !== source.incarnation || prior.root !== row.root)) {
        // #5569: an inventory that never completed has nothing to preserve, so it is taken again at the current root.
        if (prior.stages?.some(stage => stage.stage === 'inventory' && stage.status === 'complete')) {
          throw opError('local_conflict', 'The source root changed since migration inventory.',
            `Source ${source.id} was recreated or moved since its migration inventory was taken; review the checkpoint with the user before continuing the migration.`);
        }
        prior = null;
      }
      if (prior?.inventory && (!row.inventory || !sameInventory(prior.inventory.hashes, row.inventory.hashes))) {
        const original = { ...prior.inventory.hashes }, current = { ...row.inventory?.hashes };
        delete original['skillpack.json']; delete current['skillpack.json'];
        const digest = row.inventory ? inventoryDigest(row.inventory.hashes) : null;
        const accepted = digest !== null && options.acceptReviewedInventory?.[source.id] === digest;
        const filesDiffer = !row.inventory || !sameInventory(original, current);
        // Only the sealed manifest hash tells a skillpack.json edit the sealed publication made from a local one, and a
        // client of a Rust brain's owner cannot read it: that one case waits for the owner. A difference on disk is a
        // conflict without it. The deferral keeps the reviewed inventory and its completed stage (the moved-root guard).
        const client = isRustClient(ctx.engine);
        if (client && !filesDiffer && !accepted) {
          row.inventory = prior.inventory;
          row.stages.push(...(prior.stages ?? []).filter(stage => stage.stage === 'inventory' && stage.status === 'complete'));
          await ownerOnly('inventory', 'skillpack.json change');
          continue;
        }
        const reviewed = prior.inventory;
        // A sealed read that fails keeps the inventory taken before the edit, so a retry still compares against it.
        const sealed = client ? null : { manifest_hash: await sealedManifestHash(ctx.engine, source.id, source.incarnation)
          .catch((error: unknown) => { row.inventory = reviewed; throw error; }) };
        if ((filesDiffer || (sealed !== null && sealed.manifest_hash !== row.inventory!.hashes['skillpack.json'])) && !accepted) {
          const changed = changedInventoryPaths(prior.inventory.hashes, row.inventory?.hashes ?? {});
          row.inventory = prior.inventory;
          throw opError('local_conflict', `Files changed since migration inventory; preserve edits and review the checkpoint before retrying. Changed: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ` and ${changed.length - 20} more` : ''}.`
            + (digest ? ` After the user reviews these changes, accept exactly this inventory with gbrain apply-migrations --migration 0.53.0 --accept-reviewed-inventory ${source.id}=${digest} --yes.` : ''),
            `Skill files under ${row.root} changed since the migration inventory. Keep the edits and review them with the user; only after they agree, accept the reviewed inventory with the command in the message (a later edit changes the digest and is refused again).`);
        }
      }
      // A-NEW-4: one canonical adoption writes one SKILL.md per declared skill plus skillpack.json.
      if (row.inventory && row.inventory.names.length + 1 > SHARED_SKILL_LIMITS.packFiles) {
        await pending('inventory', `payload_too_large: source ${source.id} declares ${row.inventory.names.length} skills, but one canonical adoption publishes at most ${SHARED_SKILL_LIMITS.packFiles} files (one SKILL.md per skill plus skillpack.json). `
          + `Split the pack across sources or remove skills from skillpack.json, then run gbrain apply-migrations --migration 0.53.0 --yes. See docs/guides/shared-brain-skills.md#oversized-skill-packs.`);
        continue;
      }
    } catch (error) {
      // A typed capability refusal is a stop for the whole migration, not this source's pending row.
      rethrowCapabilityRefusal(error);
      if (error instanceof OperationError && error.code === 'payload_too_large' && error.detail) {
        row.inventory = prior?.inventory ?? null;
        row.parked = { limit: error.detail, limits, reason: error.message, parked_at: prior?.parked?.parked_at ?? new Date().toISOString() };
        await pending('inventory', parkedReason(source.id, row.parked));
        continue;
      }
      await pending('inventory', error instanceof OperationError ? error.message : 'The source pack cannot be inventoried safely; inspect its manifest and declared files.',
        error instanceof OperationError ? error.code : 'local_conflict');
      continue;
    }
    row.stages.push({ stage: 'inventory', status: 'complete' });
    await persist();
    if (!row.inventory && sourcePolicy.mode === 'explicit_pack_required') {
      await pending('projection', sourcePolicy.reason);
      continue;
    }
    if (isRustClient(ctx.engine)) {
      await ownerOnly('ownership', 'shared-skill activation and owner');
      continue;
    }
    if (!(isRustBrain(ctx.engine) ? (await rustPublicationFlag(ctx.engine)).skill_bundles_enabled : brain.enabled && brain.skill_bundles_enabled)) {
      await pending('ownership', 'writer_not_quiesced: stop/exclude older filesystem writers and skill servers, claim the canonical root, then explicitly activate the shared-skill writer protocol.');
      continue;
    }
    if (!await ownsRoot(ctx.engine, source, row.root)) {
      await pending('ownership', 'writer_registration_required: register the active canonical owner for this exact source root before adoption.');
      continue;
    }
    row.stages.push({ stage: 'ownership', status: 'complete' });
    await persist();
    if (!row.inventory) {
      if (existsSync(join(row.root, 'skills')) && readdirSync(join(row.root, 'skills')).length) {
        await pending('projection', 'Unmanifested source-local skills require reviewed adoption; no files or private markers were replaced.', 'shared_skills_unmanifested');
        continue;
      }
      if (!dryRun) {
        try {
          await installPackagedSharedSkills(ctx, source.id, ['README.md', 'LICENSE'].filter(path => existsSync(join(row.root!, path))));
          row.inventory = inventorySkillpack(row.root, limits);
        } catch (error) {
          await pending('projection', error instanceof OperationError ? `${error.code}: ${error.message}` : 'Pack initialization failed; inspect the canonical receipt before retrying.');
          continue;
        }
      } else {
        row.stages.push({ stage: 'projection', status: 'planned', reason: 'Add the release-pinned self-contained memory pack through the canonical publisher, preserving existing README/license and publication consent.' });
        await pending('members', 'Client follow approval and native activation remain pending; no editor rights will be added.');
        continue;
      }
    }
    if (!row.inventory) {
      throw opError('catalog_unavailable', 'Committed pack inventory could not be verified.',
        `Source ${source.id}'s pack inventory is missing, so its catalog adoption cannot be checked. Inspect the per-source stages with gbrain apply-migrations --migration 0.53.0 --dry-run --json.`);
    }
    if (!dryRun) {
      try {
        const pack = { manifest_hash: await sealedManifestHash(ctx.engine, source.id, source.incarnation) };
        const sealed = await sealedSkills(ctx.engine, source.id, source.incarnation, row.inventory.names);
        const complete = pack?.manifest_hash === row.inventory.hashes['skillpack.json'] && row.inventory.names.every(name =>
          sealed.some(skill => skill.name === name && skill.files.some(file => file.path === `skills/${name}/SKILL.md` && file.sha256 === row.inventory!.hashes[file.path])));
        if (!complete) {
          const { adoptSharedSkillpack } = await import('./catalog.ts');
          const result = await adoptSharedSkillpack(ctx, source.id, { expected_hashes: row.inventory.hashes });
          const open = result.receipts.map(receipt => receipt.write_request as { state?: string; request_id?: string } | undefined).find(request => request?.state !== 'committed');
          if (open) {
            throw opError('publication_pending', 'The catalog adoption is accepted but not fully committed. Retry the durable requests before marking this stage complete.',
              `Inspect request ${open.request_id ?? 'receipts'} first; rerunning the migration resumes the same durable request (same request_id), never a second adoption.`);
          }
        }
        row.inventory = inventorySkillpack(row.root, limits);
      } catch (error) {
        // A typed capability refusal is a stop for the whole migration, not this source's pending row.
        rethrowCapabilityRefusal(error);
        await pending('projection', error instanceof OperationError ? `${error.code}: ${error.message}` : 'Catalog adoption failed; retry after inspecting the canonical publication receipt.');
        continue;
      }
    }
    row.stages.push({ stage: 'projection', status: dryRun ? 'planned' : 'complete' });
    row.stages.push({ stage: 'policy', status: publication === 'consent_required' ? 'action_required' : 'complete',
      reason: publication === 'disabled' ? 'Explicit publishing opt-out preserved.' : publication === 'prose_only' ? 'Only previously approved SKILL.md prose is eligible; no reference, asset, script or editor permission was added.' : 'Owner publication consent is required.' });
    row.member_installations = await inspectSharedMemberMigration(ctx.engine, source.id, source.incarnation);
    await pending('members', row.member_installations.length
      ? `${row.member_installations.filter(member => member.state === 'delivery_reported').length} of ${row.member_installations.length} known installations report delivery. Inspect each installation’s next_action; native activation and unknown/disconnected installations are not verified.`
      : 'No installation has enrolled for this source. Existing grants are unchanged; approve following and reconnect each intended adapter. Native activation is unverified.');
  }
  const hostDir = await ctx.engine.getConfig('mcp.skills_dir') ?? ctx.config.mcp?.skills_dir;
  if (hostDir) {
    const mapped = report.sources.find(source => source.root && source.inventory && resolve(join(source.root, 'skills')) === resolve(hostDir));
    const declared = new Set(mapped?.inventory?.names);
    let complete = !!mapped;
    if (mapped) {
      try {
        checkedContentRoot(hostDir);
        const entries = readdirSync(hostDir);
        complete = entries.length <= limits.max_files && entries.every(name => !existsSync(join(hostDir, name, 'SKILL.md')) || declared.has(name));
      } catch { complete = false; }
    }
    if (!complete) report.pending_actions.push('Host-global catalog assignment is pending. Review a dedicated content pack root with skillpack.json (brain_resident:true) and declared skills; never register the application checkout. After approval, register it with `gbrain sources add shared-skills --path <reviewed-pack-root> --force --no-federated`. Inspect `gbrain sources writer status --json` before deliberate ownership changes; follow skills/migrations/v0.53.0.0.md for action-specific --admin-intent and reviewed --expected-state claim/activation steps. Quiescence is a separate prerequisite, not administration authority. Preview `gbrain apply-migrations --migration 0.53.0 --dry-run --json`, then apply with --yes only when those stages are approved. Original files and grants are unchanged; unmanifested or undeclared skills require explicit review.');
  }
  report.status = report.sources.some(row => row.status === 'conflict') ? 'conflict'
    : report.sources.some(row => row.status === 'action_required') || report.pending_actions.length ? 'action_required' : dryRun ? 'planned' : 'complete';
  if (!dryRun) await ctx.engine.setConfig('shared_skills.migration.v1', JSON.stringify(report));
  return report;
}
