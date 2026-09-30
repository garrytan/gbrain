import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isThinClient } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { checkedContentRoot, inventorySkillpack, sameInventory, type PackInventory } from './setup-files.ts';
import { contentSetupKey, installPackagedSharedSkills, setupSharedBrainContent, type SharedContentReceipt } from './setup.ts';
import type { DatabaseContentExportReceipt } from './migration-export.ts';
import { inspectSharedMemberMigration, type SharedMemberMigration } from './migration-members.ts';
import { sharedSkillSourcePolicy } from './setup-source-policy.ts';

export type MigrationPublication = 'disabled' | 'prose_only' | 'consent_required';
export interface SharedMigrationStage {
  stage: 'inventory' | 'ownership' | 'projection' | 'policy' | 'members';
  status: 'complete' | 'action_required' | 'conflict' | 'planned';
  reason?: string;
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

export async function legacyPublication(ctx: OperationContext): Promise<MigrationPublication> {
  const dbValue = await ctx.engine.getConfig('mcp.publish_skills');
  const value = dbValue === null ? ctx.config.mcp?.publish_skills : dbValue;
  if (value === false || value === 'false') return 'disabled';
  if (value === true || value === 'true') return 'prose_only';
  return 'consent_required';
}

export async function runSharedSkillsMigration(ctx: OperationContext, options: { dryRun?: boolean } = {}): Promise<SharedMigrationReport> {
  if (ctx.remote !== false) throw new OperationError('permission_denied', 'Shared-skills migration requires the trusted local host.');
  const dryRun = options.dryRun ?? ctx.dryRun;
  const report: SharedMigrationReport = { version: 1, brain_id: null, dry_run: dryRun, status: dryRun ? 'planned' : 'complete', sources: [], pending_actions: [], permission_changes: [] };
  if (isThinClient(ctx.config)) {
    report.status = 'action_required';
    report.pending_actions.push('Canonical-content migration belongs on the host. Reconnect this client after upgrading its adapter; no host repository or local grants were created.');
    return report;
  }
  const [brain] = await ctx.engine.executeRaw<{ brain_id: string; enabled: boolean; skill_bundles_enabled: boolean }>(
    'SELECT brain_id,enabled,skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
  if (!brain) throw new OperationError('writer_not_initialized', 'Apply the shared-skills schema before migrating content.');
  report.brain_id = brain.brain_id;
  const publication = await legacyPublication(ctx);
  const roots = await ctx.engine.executeRaw<{ id: string; incarnation: string; local_path: string | null }>('SELECT id,incarnation,local_path FROM sources WHERE NOT archived ORDER BY id');
  const fallback = await ctx.engine.getConfig('sync.repo_path');
  for (const source of roots) {
    const sourcePolicy = await sharedSkillSourcePolicy(ctx.engine, source.id).catch(error => ({ mode: 'preserve_files' as const,
      reason: error instanceof OperationError ? `${error.code}: ${error.message}` : 'profile_incompatible: the source writeback policy could not be verified; no repository changes were attempted.' }));
    const contentCheckpoint = await ctx.engine.getConfig(contentSetupKey(source.id, source.incarnation));
    if (contentCheckpoint && !dryRun && sourcePolicy.mode === 'content') {
      let content: SharedContentReceipt;
      try { content = JSON.parse(contentCheckpoint); }
      catch { throw new OperationError('local_conflict', 'A content setup checkpoint is malformed; preserve it for review.'); }
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
    const pending = async (stage: SharedMigrationStage['stage'], reason: string, conflict = false) => {
      row.status = conflict ? 'conflict' : 'action_required';
      row.stages.push({ stage, status: row.status, reason });
      await persist();
    };
    if (sourcePolicy.mode === 'preserve_files') {
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
      if (!existsSync(row.root)) throw new OperationError('local_conflict', 'The registered canonical root is missing.');
      row.inventory = inventorySkillpack(row.root);
      if (prior && (prior.source_incarnation !== source.incarnation || prior.root !== row.root)) throw new OperationError('local_conflict', 'The source root changed since migration inventory.');
      if (prior?.inventory && (!row.inventory || !sameInventory(prior.inventory.hashes, row.inventory.hashes))) {
        const original = { ...prior.inventory.hashes }, current = { ...row.inventory?.hashes };
        delete original['skillpack.json']; delete current['skillpack.json'];
        const [sealed] = await ctx.engine.executeRaw<{ manifest_hash: string }>('SELECT manifest_hash FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [source.id, source.incarnation]);
        if (!row.inventory || !sameInventory(original, current) || sealed?.manifest_hash !== row.inventory.hashes['skillpack.json']) {
          row.inventory = prior.inventory;
          throw new OperationError('local_conflict', 'Files changed since migration inventory; preserve edits and review the checkpoint before retrying.');
        }
      }
    } catch (error) {
      await pending('inventory', error instanceof OperationError ? error.message : 'The source pack cannot be inventoried safely; inspect its manifest and declared files.', true);
      continue;
    }
    row.stages.push({ stage: 'inventory', status: 'complete' });
    await persist();
    if (!row.inventory && sourcePolicy.mode === 'explicit_pack_required') {
      await pending('projection', sourcePolicy.reason);
      continue;
    }
    if (!brain.enabled || !brain.skill_bundles_enabled) {
      await pending('ownership', 'writer_not_quiesced: stop/exclude older filesystem writers and skill servers, claim the canonical root, then explicitly activate the shared-skill writer protocol.');
      continue;
    }
    const binding = await getWorktreeBinding(ctx.engine, source.id);
    if (!binding || binding.state !== 'active' || !binding.owner_host_id || !binding.local_path || resolve(join(binding.local_path, binding.relative_path)) !== row.root) {
      await pending('ownership', 'writer_registration_required: register the active canonical owner for this exact source root before adoption.');
      continue;
    }
    row.stages.push({ stage: 'ownership', status: 'complete' });
    await persist();
    if (!row.inventory) {
      if (existsSync(join(row.root, 'skills')) && readdirSync(join(row.root, 'skills')).length) {
        await pending('projection', 'Unmanifested source-local skills require reviewed adoption; no files or private markers were replaced.', true);
        continue;
      }
      if (!dryRun) {
        try {
          await installPackagedSharedSkills(ctx, source.id, ['README.md', 'LICENSE'].filter(path => existsSync(join(row.root!, path))));
          row.inventory = inventorySkillpack(row.root);
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
    if (!row.inventory) throw new OperationError('catalog_unavailable', 'Committed pack inventory could not be verified.');
    if (!dryRun) {
      try {
        const [pack] = await ctx.engine.executeRaw<{ manifest_hash: string }>('SELECT manifest_hash FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [source.id, source.incarnation]);
        const sealed = await ctx.engine.executeRaw<{ name: string; files: Array<{ path: string; sha256: string }> }>(`SELECT r.name,r.files FROM shared_skill_heads h JOIN shared_skill_revisions r
          ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
          WHERE h.source_id=$1 AND h.source_incarnation=$2::uuid AND NOT r.deleted`, [source.id, source.incarnation]);
        const complete = pack?.manifest_hash === row.inventory.hashes['skillpack.json'] && row.inventory.names.every(name =>
          sealed.some(skill => skill.name === name && skill.files.some(file => file.path === `skills/${name}/SKILL.md` && file.sha256 === row.inventory!.hashes[file.path])));
        if (!complete) {
          const { adoptSharedSkillpack } = await import('./catalog.ts');
          const result = await adoptSharedSkillpack(ctx, source.id, { expected_hashes: row.inventory.hashes });
          if (result.receipts.some(receipt => (receipt.write_request as { state?: string } | undefined)?.state !== 'committed')) throw new OperationError('publication_pending', 'The catalog adoption is accepted but not fully committed. Retry the durable requests before marking this stage complete.');
        }
        row.inventory = inventorySkillpack(row.root);
      } catch (error) {
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
        complete = entries.length <= 256 && entries.every(name => !existsSync(join(hostDir, name, 'SKILL.md')) || declared.has(name));
      } catch { complete = false; }
    }
    if (!complete) report.pending_actions.push('Host-global catalog assignment is pending. Review a dedicated content pack root with skillpack.json (brain_resident:true) and declared skills; never register the application checkout. After approval, register it with `gbrain sources add shared-skills --path <reviewed-pack-root> --force --no-federated`. Inspect `gbrain sources writer status --json` before deliberate ownership changes; follow skills/migrations/v0.53.0.0.md for action-specific --admin-intent and reviewed --expected-state claim/activation steps. Quiescence is a separate prerequisite, not administration authority. Preview `gbrain apply-migrations --migration 0.53.0 --dry-run --json`, then apply with --yes only when those stages are approved. Original files and grants are unchanged; unmanifested or undeclared skills require explicit review.');
  }
  report.status = report.sources.some(row => row.status === 'conflict') ? 'conflict'
    : report.sources.some(row => row.status === 'action_required') || report.pending_actions.length ? 'action_required' : dryRun ? 'planned' : 'complete';
  if (!dryRun) await ctx.engine.setConfig('shared_skills.migration.v1', JSON.stringify(report));
  return report;
}
