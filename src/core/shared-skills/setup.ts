import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gbrainPath, isThinClient } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { claimWorktree, getWorktreeBinding } from '../persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../persistence/skill-activation.ts';
import { checkedContentRoot } from './setup-files.ts';
import { DEFAULT_SHARED_PACK_ID, packagedSharedSkillPolicy, packagedSharedSkills } from './setup-bundle.ts';
import { publicationEnabled, setSharedSkillPolicy } from './policy.ts';
import type { BrainEngine } from '../engine.ts';
import { assertPackagedSkillSource, sharedSkillSourcePolicy } from './setup-source-policy.ts';

export async function isNewContentDatabase(engine: BrainEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ fresh: boolean }>("SELECT to_regclass('public.pages') IS NULL AND to_regclass('public.config') IS NULL AND to_regclass('public.persistence_brain') IS NULL AS fresh");
  return row?.fresh === true;
}

export interface SharedContentOptions {
  sourceId?: string;
  root?: string;
  dbOnly?: boolean;
  git?: 'init' | 'none';
  dryRun?: boolean;
  fresh?: boolean;
}

export interface SharedContentReceipt {
  version: 1;
  brain_id: string | null;
  source_id: string;
  source_incarnation: string | null;
  root: string | null;
  repository_kind: 'git' | 'content_directory' | 'db_only' | 'remote';
  backup: 'not_verified';
  status: 'ready' | 'action_required' | 'planned';
  stage: 'root' | 'owner' | 'pack' | 'complete';
  pending_actions: string[];
  owned_root: boolean;
  root_identity?: { device: number; inode: number };
  fresh_root_activation?: boolean;
}

export function contentSetupKey(sourceId: string, incarnation: string): string {
  return `shared_skills.content.v1.${sourceId}.${incarnation}`;
}

export async function saveContentReceipt(ctx: OperationContext, receipt: SharedContentReceipt): Promise<void> {
  if (receipt.source_incarnation) await ctx.engine.setConfig(contentSetupKey(receipt.source_id, receipt.source_incarnation), JSON.stringify(receipt));
}

export async function setupSharedBrainContent(ctx: OperationContext, options: SharedContentOptions = {}): Promise<SharedContentReceipt> {
  if (ctx.remote !== false) throw new OperationError('permission_denied', 'Content-root setup requires the trusted local host.');
  const receipt: SharedContentReceipt = {
    version: 1, brain_id: null, source_id: options.sourceId ?? ctx.sourceId ?? 'default', source_incarnation: null,
    root: null, repository_kind: 'remote', backup: 'not_verified', status: 'action_required', stage: 'root', pending_actions: [], owned_root: false,
  };
  if (isThinClient(ctx.config)) {
    receipt.pending_actions = ['Manage canonical content on the host brain; this thin client creates no content repository.'];
    return receipt;
  }
  const sourceId = options.sourceId ?? ctx.sourceId;
  const [brain] = await ctx.engine.executeRaw<{ brain_id: string; enabled: boolean; skill_bundles_enabled: boolean }>('SELECT brain_id,enabled,skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
  const [source] = await ctx.engine.executeRaw<{ id: string; incarnation: string; local_path: string | null }>(
    'SELECT id,incarnation,local_path FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!brain || !source) throw new OperationError('source_changed', 'Content setup requires the persistent brain identity and an active selected source.');
  receipt.brain_id = brain.brain_id;
  receipt.source_id = sourceId;
  receipt.source_incarnation = source.incarnation;
  const sourcePolicy = await sharedSkillSourcePolicy(ctx.engine, sourceId);
  if (sourcePolicy.mode !== 'content') {
    receipt.root = source.local_path;
    receipt.repository_kind = source.local_path ? 'content_directory' : 'db_only';
    if (source.local_path) {
      const git = spawnSync('git', ['-C', source.local_path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 15_000 });
      if (git.status === 0 && resolve(git.stdout.trim()) === resolve(source.local_path)) receipt.repository_kind = 'git';
    }
    receipt.pending_actions = [sourcePolicy.reason];
    if (!options.dryRun) await saveContentReceipt(ctx, receipt);
    return receipt;
  }
  const key = contentSetupKey(sourceId, source.incarnation);
  const saved = await ctx.engine.getConfig(key);
  let prior: SharedContentReceipt | null = null;
  if (saved) {
    try { prior = JSON.parse(saved); } catch { throw new OperationError('local_conflict', 'The content setup checkpoint is malformed.'); }
    if (prior?.version !== 1 || prior.brain_id !== brain.brain_id || prior.source_incarnation !== source.incarnation) throw new OperationError('local_conflict', 'The content setup checkpoint does not match this brain.');
  }
  const existingRoot = source.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
  if (options.root && existingRoot && resolve(options.root) !== resolve(existingRoot)) throw new OperationError('local_conflict', 'The selected source already has a different content root; use an explicit source rebind.');
  if (options.dbOnly && existingRoot) throw new OperationError('local_conflict', 'DB-only setup cannot detach an existing canonical source root. Preserve it or use an explicit topology migration.');
  if (options.dbOnly || !options.root && !existingRoot && prior?.repository_kind === 'db_only') {
    receipt.repository_kind = 'db_only';
    receipt.pending_actions = ['Memory remains available. Select a host canonical root and validate a full export/import round trip before shared publication.'];
    if (!options.dryRun) await saveContentReceipt(ctx, receipt);
    return receipt;
  }
  const [pages] = await ctx.engine.executeRaw<{ present: boolean }>('SELECT EXISTS(SELECT 1 FROM pages WHERE source_id=$1) AS present', [sourceId]);
  if (!existingRoot && pages.present) {
    receipt.repository_kind = 'db_only';
    receipt.pending_actions = ['Existing database pages have no canonical root. Export and verify a round trip on the host before adopting a root; no empty replacement was created.'];
    if (!options.dryRun) await saveContentReceipt(ctx, receipt);
    return receipt;
  }
  const root = checkedContentRoot(existingRoot || options.root || prior?.root || gbrainPath('content', brain.brain_id, sourceId));
  receipt.root = root;
  receipt.owned_root = prior?.owned_root ?? (!existingRoot && (!!options.fresh || !!options.root));
  receipt.fresh_root_activation = prior?.fresh_root_activation ?? (!existingRoot && !!options.fresh);
  const gitProbe = existsSync(join(root, '.git')) ? spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 15_000 }) : null;
  receipt.repository_kind = gitProbe?.status === 0 && resolve(gitProbe.stdout.trim()) === root ? 'git' : 'content_directory';
  const existed = existsSync(root);
  if (prior?.root && prior.root !== root) throw new OperationError('local_conflict', 'The canonical root changed after setup began.');
  if (existingRoot && !existed) throw new OperationError('local_conflict', 'The registered content root is missing; restore it rather than creating a replacement.');
  if (!existingRoot && existed && !prior && readdirSync(root).length > 0) throw new OperationError('local_conflict', 'The requested root contains unowned files; register an existing source explicitly instead.');
  if (prior?.owned_root && existed) {
    const stat = statSync(root);
    if (prior.root_identity ? prior.root_identity.device !== stat.dev || prior.root_identity.inode !== stat.ino : readdirSync(root).length > 0) {
      throw new OperationError('local_conflict', 'The owned root changed or gained unverified files after setup was interrupted.');
    }
    receipt.root_identity = { device: stat.dev, inode: stat.ino };
  }
  if (options.dryRun) {
    receipt.status = 'planned';
    receipt.pending_actions = [existingRoot ? 'Preserve the selected existing root and review source-local skill adoption.' : `Create the combined content directory at ${root}.`, options.git === 'init' ? 'Initialize Git only if this root is newly owned and empty.' : 'Git and off-host backup remain unconfigured.'];
    return receipt;
  }
  if (prior?.stage === 'complete') return prior;
  await saveContentReceipt(ctx, receipt);
  if (!existed) {
    if (!receipt.owned_root) {
      receipt.pending_actions = ['Authorize a new owned content root or register an existing source before setup.'];
      await saveContentReceipt(ctx, receipt);
      return receipt;
    }
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    mkdirSync(root, { mode: 0o700 });
  }
  if (receipt.owned_root) {
    const stat = statSync(root);
    receipt.root_identity = { device: stat.dev, inode: stat.ino };
    await saveContentReceipt(ctx, receipt);
  }
  if (options.git === 'init' && receipt.repository_kind !== 'git') {
    if (!receipt.owned_root || readdirSync(root).length !== 0) throw new OperationError('local_conflict', 'Git initialization is allowed only in a newly owned empty content directory.');
    const git = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', timeout: 15_000 });
    if (!git.error && git.status === 0) receipt.repository_kind = 'git';
    else receipt.pending_actions.push('Git initialization was unavailable; install Git and explicitly initialize this content directory later.');
  }
  if (receipt.repository_kind === 'content_directory' && !receipt.pending_actions.length) receipt.pending_actions.push('Optional: initialize Git explicitly; configure an off-host backup separately.');
  if (receipt.owned_root && receipt.repository_kind === 'content_directory') {
    const enclosing = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 15_000 });
    if (enclosing.status === 0 && resolve(enclosing.stdout.trim()) !== root) throw new OperationError('local_conflict', 'The new content directory is inside another Git worktree. Choose a separate root or explicitly initialize Git here; setup will not claim its parent repository.');
  }
  if (!existingRoot) await ctx.engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2 AND incarnation=$3::uuid AND local_path IS NULL', [root, sourceId, source.incarnation]);
  receipt.stage = 'owner';
  await saveContentReceipt(ctx, receipt);
  if (!receipt.owned_root) {
    receipt.pending_actions.push('Preserve existing files. Run the staged shared-skills migration to review ownership, publication policy and source-local skills.');
    await saveContentReceipt(ctx, receipt);
    return receipt;
  }
  if (!receipt.fresh_root_activation && !brain.skill_bundles_enabled) {
    receipt.pending_actions.push('writer_not_quiesced: this is an existing brain. Stop/exclude older writers, claim this root and explicitly activate shared-skill persistence before publication.');
    await saveContentReceipt(ctx, receipt);
    return receipt;
  }
  let binding = await getWorktreeBinding(ctx.engine, sourceId);
  if (!binding) binding = await claimWorktree(ctx.engine, sourceId, root);
  if (binding.state !== 'active' || !binding.owner_host_id) throw new OperationError('owner_unavailable', 'The canonical content owner is not active.');
  if (!brain.skill_bundles_enabled) await activateSharedSkillPersistence(ctx.engine, { confirmQuiesced: true });
  receipt.stage = 'pack';
  await saveContentReceipt(ctx, receipt);
  if (receipt.fresh_root_activation && await publicationEnabled(ctx)) {
    const existingPolicy = await ctx.engine.executeRaw('SELECT epoch FROM shared_skill_policies WHERE source_id=$1 AND source_incarnation=$2::uuid', [sourceId, source.incarnation]);
    if (!existingPolicy.length) {
      ctx.logger.info('Fresh brain setup approves following the packaged memory skills: prose only, existing memory/discovery tools, no scripts, paid services, capture or editor grants.');
      await setSharedSkillPolicy(ctx, sourceId, packagedSharedSkillPolicy(), null);
    }
  }
  await installPackagedSharedSkills(ctx, sourceId);
  receipt.stage = 'complete';
  receipt.status = 'ready';
  await saveContentReceipt(ctx, receipt);
  return receipt;
}

export async function installPackagedSharedSkills(ctx: OperationContext, sourceId: string, preservePaths: string[] = []): Promise<void> {
  await assertPackagedSkillSource(ctx.engine, sourceId);
  const files = packagedSharedSkills();
  for (const path of preservePaths) if (['README.md', 'LICENSE'].includes(path)) delete files[path];
  const { adoptSharedSkillpack } = await import('./catalog.ts');
  const result = await adoptSharedSkillpack(ctx, sourceId, {
    request_id: 'gbrain-default-content-v1', pack_id: DEFAULT_SHARED_PACK_ID,
    initial_files: files,
    skills: JSON.parse(files['skillpack.json']).skills.map((path: string) => ({
      pack_id: DEFAULT_SHARED_PACK_ID, name: path.slice('skills/'.length), expected_revision: null,
      files: [{ path: `${path}/SKILL.md`, content: files[`${path}/SKILL.md`], file_class: 'prose' }],
    })),
  });
  if (result.receipts.some(receipt => (receipt.write_request as { state?: string } | undefined)?.state !== 'committed')) {
    throw new OperationError('publication_pending', 'The default pack was accepted but is not fully committed; rerun init to resume its durable requests.');
  }
}
