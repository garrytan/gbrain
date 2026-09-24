import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { stableJson } from '../persistence/digest.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { gbrainPath } from '../config.ts';
import { privateWrite } from '../agent-install/state.ts';
import { runManagedSourceLifecycle } from '../persistence/source-lifecycle.ts';
import { assertTopologyCommitted } from '../persistence/managed-sources.ts';
import { activateSharedSkillPersistence } from '../persistence/skill-activation.ts';
import { flushTopologyDirectory } from '../persistence/topology-filesystem.ts';
import { assertExportProjectionRoundtrip } from './migration-projection.ts';
import { registerLocalWriter } from '../persistence/identity.ts';
import { checkedContentRoot, sameInventory, setupHash } from './setup-files.ts';
import { installPackagedSharedSkills } from './setup.ts';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { slugifyPath } from '../sync.ts';
import { assertPackagedSkillSource } from './setup-source-policy.ts';
import { approvedSchemaIdentity, loadActivePackForEngine, type ApprovedSchemaIdentity } from '../schema-pack/engine-resolution.ts';

export interface DatabaseContentExportOptions {
  root: string;
  sourceId: string;
  dryRun?: boolean;
  confirmQuiesced?: boolean;
  backup?: 'operator_verified' | 'acknowledged_unprotected';
}
export interface DatabaseContentExportReceipt {
  version: 1;
  brain_id: string;
  source_id: string;
  source_incarnation: string;
  root: string;
  staging_root: string;
  request_id: string;
  stage: 'inventory' | 'exported' | 'bound' | 'complete';
  status: 'planned' | 'action_required' | 'complete' | 'conflict';
  database_retained: true;
  backup: 'operator_verified' | 'acknowledged_unprotected' | 'choice_required';
  validation: 'parsed_markdown_and_raw_hashes';
  files: Record<string, string>;
  pages: number;
  conflicts: Array<{ slug: string; reason: string }>;
  pending_actions: string[];
  root_identity?: { device: number; inode: number };
  schema_policy?: { schema: ApprovedSchemaIdentity; source_config_sha256: string };
}

function exportPath(page: Page): string {
  const path = page.source_path ?? `${page.slug}.md`;
  if (path.length > 1024 || !path.endsWith('.md') || isAbsolute(path) || path.normalize('NFC') !== path || /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /^(skills|\.git|\.gbrain)(\/|$)/i.test(path)) {
    throw new OperationError('unsupported_export_data', 'An unsafe, reserved or non-Markdown source path requires a format-specific export.');
  }
  return path;
}

async function exportInventory(engine: BrainEngine, sourceId: string) {
  const activePack = await loadActivePackForEngine(engine, { sourceId, remote: false });
  const [source] = await engine.executeRaw<{ config: unknown; incarnation: string }>('SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The export source is no longer active.');
  const schemaPolicy = { schema: approvedSchemaIdentity(activePack), source_config_sha256: setupHash(stableJson({ config: source.config, incarnation: source.incarnation })) };
  const files: Record<string, string> = {}, conflicts: DatabaseContentExportReceipt['conflicts'] = [];
  const pages = await engine.listPages({ sourceId, limit: 5001, sort: 'slug' });
  if (pages.length > 5000) throw new OperationError('export_limit', 'This migration is bounded to 5,000 active pages per source; split or use a reviewed bulk export.');
  let bytes = 0;
  const names = new Set<string>();
  for (const page of pages) {
    try {
      const path = exportPath(page);
      if (names.has(path.toLowerCase())) throw new OperationError('unsupported_export_data', 'Canonical paths collide after case normalization.');
      names.add(path.toLowerCase());
      const tags = await engine.getTags(page.slug, { sourceId });
      if (page.frontmatter.type !== undefined && page.frontmatter.type !== page.type || page.frontmatter.title !== undefined && page.frontmatter.title !== page.title) {
        throw new OperationError('unsupported_export_data', 'Stored frontmatter disagrees with the authoritative page title or type.');
      }
      const frontmatter = { ...page.frontmatter, slug: page.slug, tags };
      const content = serializeMarkdown(frontmatter, page.compiled_truth, page.timeline, { type: page.type, title: page.title, tags });
      const parsed = parseMarkdown(content, path, { validate: true, expectedSlug: slugifyPath(path), activePack: activePack.manifest });
      const expectedFrontmatter = { ...page.frontmatter };
      for (const key of ['slug', 'type', 'title', 'tags']) delete expectedFrontmatter[key];
      if (parsed.errors?.length || parsed.slug !== page.slug || parsed.type !== page.type || parsed.title !== page.title ||
        parsed.compiled_truth !== page.compiled_truth || parsed.timeline !== page.timeline ||
        stableJson([...parsed.tags].sort()) !== stableJson([...tags].sort()) ||
        stableJson(parsed.frontmatter) !== stableJson(expectedFrontmatter)) {
        throw new OperationError('unsupported_export_data', 'The existing Markdown parser cannot round-trip this page without changing its fields.');
      }
      await assertExportProjectionRoundtrip(engine, parsed, page.id, sourceId);
      files[path] = content;
      const raw = await engine.getRawData(page.slug, undefined, { sourceId, includeDeleted: true });
      if (raw.length) {
        const data = Object.fromEntries(raw.map(row => [row.source, row.data]));
        if (Object.keys(data).length !== raw.length) throw new OperationError('unsupported_export_data', 'Raw-data sidecar keys are ambiguous.');
        const sidecar = JSON.stringify(data, null, 2) + '\n';
        if (stableJson(JSON.parse(sidecar)) !== stableJson(data)) throw new OperationError('unsupported_export_data', 'Raw data cannot round-trip through JSON.');
        files[join(dirname(path), '.raw', path.split('/').at(-1)!.slice(0, -3) + '.json')] = sidecar;
      }
      bytes += Buffer.byteLength(content) + raw.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.data)), 0);
      if (Buffer.byteLength(content) > 5_000_000 || bytes > 64 * 1024 * 1024) throw new OperationError('export_limit', 'The canonical export exceeds its 5 MB page or 64 MiB source bound.');
    } catch (error) {
      conflicts.push({ slug: page.slug, reason: error instanceof OperationError ? error.message : 'This page cannot be exported losslessly.' });
    }
  }
  return { files, conflicts, pages: pages.length, schemaPolicy };
}

function verifyFiles(root: string, hashes: Record<string, string>, exact = false): void {
  checkedContentRoot(root);
  for (const [path, hash] of Object.entries(hashes)) {
    const absolute = join(root, path);
    checkedContentRoot(dirname(absolute));
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || setupHash(readFileSync(absolute)) !== hash) throw new OperationError('local_conflict', 'An exported file was changed; no file or database row will be replaced.');
  }
  if (exact) {
    const visit = (directory: string, prefix: string) => {
      for (const name of readdirSync(directory)) {
        const path = prefix ? `${prefix}/${name}` : name, stat = lstatSync(join(directory, name));
        if (stat.isSymbolicLink()) throw new OperationError('local_conflict', 'An export directory contains an unexpected symlink.');
        if (stat.isDirectory()) visit(join(directory, name), path);
        else if (!hashes[path]) throw new OperationError('local_conflict', 'An export directory contains unowned files; it will not be adopted.');
      }
    };
    visit(root, '');
  }
}

export async function exportDatabaseContent(ctx: OperationContext, options: DatabaseContentExportOptions): Promise<DatabaseContentExportReceipt> {
  if (ctx.remote !== false) throw new OperationError('permission_denied', 'DB-only export is a trusted host action.');
  const root = checkedContentRoot(options.root);
  const [brain] = await ctx.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; local_path: string | null }>('SELECT incarnation,local_path FROM sources WHERE id=$1 AND NOT archived', [options.sourceId]);
  if (!brain || !source) throw new OperationError('source_changed', 'The selected brain/source is not active.');
  await assertPackagedSkillSource(ctx.engine, options.sourceId);
  if (!options.dryRun && options.confirmQuiesced && ((await ctx.engine.executeRaw('SELECT id FROM gbrain_cycle_locks LIMIT 1')).length ||
    (await ctx.engine.executeRaw("SELECT id FROM persistence_requests WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL LIMIT 1")).length)) {
    throw new OperationError('writer_not_quiesced', 'Active maintenance locks or durable writes remain; finish or recover them before exporting.');
  }
  const key = `shared_skills.export.v1.${options.sourceId}.${source.incarnation}`;
  const saved = await ctx.engine.getConfig(key);
  let prior: DatabaseContentExportReceipt | null = null;
  try { if (saved) prior = JSON.parse(saved); } catch { throw new OperationError('local_conflict', 'The export checkpoint is malformed.'); }
  if (prior && (prior.version !== 1 || prior.root !== root || prior.brain_id !== brain.brain_id || prior.source_incarnation !== source.incarnation)) throw new OperationError('local_conflict', 'The export checkpoint targets a different root or identity.');
  if (prior?.root_identity && !existsSync(root)) throw new OperationError('local_conflict', 'The verified exported root is missing. Restore it; migration will not silently create a replacement.');
  const fallback = options.sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null;
  if ((source.local_path || fallback) && (!prior || resolve(source.local_path || fallback!) !== root)) throw new OperationError('local_conflict', 'The source already has a canonical root; this export never moves it.');
  if (existsSync(root) && !prior) throw new OperationError('local_conflict', 'Choose an absent export destination; existing directories are never overwritten.');
  const inventory = await exportInventory(ctx.engine, options.sourceId);
  const hashes = Object.fromEntries(Object.entries(inventory.files).map(([path, content]) => [path, setupHash(content)]));
  const receipt: DatabaseContentExportReceipt = prior ?? {
    version: 1, brain_id: brain.brain_id, source_id: options.sourceId, source_incarnation: source.incarnation, root,
    staging_root: `${root}.gbrain-export-${randomUUID()}`, request_id: randomUUID(), stage: 'inventory', status: 'planned',
    database_retained: true, backup: options.backup ?? 'choice_required', validation: 'parsed_markdown_and_raw_hashes',
    files: hashes, pages: inventory.pages, conflicts: [], pending_actions: [],
    schema_policy: inventory.schemaPolicy,
  };
  receipt.conflicts = inventory.conflicts;
  if (prior && stableJson(prior.schema_policy ?? null) !== stableJson(inventory.schemaPolicy)) receipt.conflicts.push({ slug: '*', reason: 'The source schema or ingestion policy changed since the export checkpoint. Revalidate the original policy before resuming; the root was not rebound.' });
  if (prior && !sameInventory(prior.files, hashes)) receipt.conflicts.push({ slug: '*', reason: 'Database content changed since the export checkpoint. Preserve the existing export and choose a reviewed recovery path.' });
  receipt.pending_actions = [];
  if (!options.confirmQuiesced) receipt.pending_actions.push('Stop all memory/file writers and old skill servers, then pass --confirm-quiesced.');
  if (!options.backup) receipt.pending_actions.push('Verify an operational backup and pass --backup-confirmed, or explicitly choose --acknowledge-no-backup. Markdown is not a full database backup.');
  receipt.backup = options.backup ?? receipt.backup;
  if (receipt.conflicts.length || options.dryRun || receipt.pending_actions.length) {
    receipt.status = receipt.conflicts.length ? 'conflict' : options.dryRun ? 'planned' : 'action_required';
    return receipt;
  }
  const lock = await acquireNativeLock(gbrainPath('persistence', 'locks', `export-${brain.brain_id}-${source.incarnation}.lock`), { timeoutMs: 1000 });
  if (!lock) throw new OperationError('writer_lock_unavailable', 'Another export is using this source checkpoint.');
  try {
    await ctx.engine.setConfig(key, JSON.stringify(receipt));
    if (!existsSync(root)) {
      if (!existsSync(receipt.staging_root)) mkdirSync(receipt.staging_root, { recursive: true, mode: 0o700 });
      checkedContentRoot(receipt.staging_root);
      for (const [path, content] of Object.entries(inventory.files)) {
        const target = join(receipt.staging_root, path);
        if (existsSync(target)) {
          verifyFiles(receipt.staging_root, { [path]: hashes[path] });
          continue;
        }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        checkedContentRoot(dirname(target));
        privateWrite(target, content);
      }
      verifyFiles(receipt.staging_root, hashes, true);
      const enclosing = spawnSync('git', ['-C', receipt.staging_root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 15_000 });
      if (enclosing.status === 0) throw new OperationError('local_conflict', 'The export would claim an enclosing Git worktree. Choose a destination outside existing repositories.');
      const current = await exportInventory(ctx.engine, options.sourceId);
      if (current.conflicts.length || stableJson(current.schemaPolicy) !== stableJson(receipt.schema_policy) || !sameInventory(hashes, Object.fromEntries(Object.entries(current.files).map(([path, content]) => [path, setupHash(content)])))) throw new OperationError('local_conflict', 'The database content, source schema or ingestion policy changed while exporting; writers were not quiesced.');
      renameSync(receipt.staging_root, root);
      flushTopologyDirectory(dirname(root));
    }
    verifyFiles(root, hashes, receipt.stage === 'inventory');
    const stat = statSync(root);
    if (receipt.root_identity && (receipt.root_identity.device !== stat.dev || receipt.root_identity.inode !== stat.ino)) throw new OperationError('local_conflict', 'The exported root was replaced after validation.');
    receipt.root_identity = { device: stat.dev, inode: stat.ino };
    receipt.stage = 'exported'; receipt.status = 'action_required';
    await ctx.engine.setConfig(key, JSON.stringify(receipt));
    await assertPackagedSkillSource(ctx.engine, options.sourceId);
    const verified = await exportInventory(ctx.engine, options.sourceId);
    if (verified.conflicts.length || stableJson(verified.schemaPolicy) !== stableJson(receipt.schema_policy) || !sameInventory(hashes, Object.fromEntries(Object.entries(verified.files).map(([path, content]) => [path, setupHash(content)])))) throw new OperationError('local_conflict', 'The database content, source schema or ingestion policy changed before source binding.');
    await registerLocalWriter(ctx.engine, 'cli');
    assertTopologyCommitted(await runManagedSourceLifecycle(ctx.engine, { operation: 'claim', sourceId: options.sourceId, path: root,
      expectedIncarnation: source.incarnation, requestId: receipt.request_id }));
    receipt.stage = 'bound';
    await ctx.engine.setConfig(key, JSON.stringify(receipt));
    const [protocol] = await ctx.engine.executeRaw<{ skill_bundles_enabled: boolean }>('SELECT skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
    if (!protocol.skill_bundles_enabled) await activateSharedSkillPersistence(ctx.engine, { confirmQuiesced: true });
    await installPackagedSharedSkills(ctx, options.sourceId, Object.keys(hashes));
    receipt.stage = 'complete'; receipt.status = 'complete';
    receipt.pending_actions = ['Operational database state is retained and still needs backup. Publication consent, grants and client-native activation are unchanged.'];
    await ctx.engine.setConfig(key, JSON.stringify(receipt));
    return receipt;
  } catch (error) {
    receipt.status = error instanceof OperationError && error.code === 'local_conflict' ? 'conflict' : 'action_required';
    receipt.pending_actions = [error instanceof OperationError ? `${error.code}: ${error.message}` : 'Export was interrupted; preserve staged files and rerun with the same root and source.'];
    await ctx.engine.setConfig(key, JSON.stringify(receipt));
    throw error;
  } finally { await lock.release(); }
}
