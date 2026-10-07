import { AsyncLocalStorage } from 'node:async_hooks';
import { describeFixes } from '../fence-repair/report.ts';
import { basename, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { importFromContent } from '../import-file.ts';
import { readCommittedBlob } from './revision.ts';
import { parseMarkdown } from '../markdown.ts';
import { prepareCanonicalProjections } from '../persistence/canonical-projections.ts';
import { digest } from '../persistence/digest.ts';
import type { ResolvedPack } from '../schema-pack/registry.ts';
import type { CompanyBrainPlan, InspectionEntry } from './types.ts';
import type { SourceIngestionCheckpoint } from './receipts.ts';
import { companyBrainProfile, companyBrainPolicyFingerprint, type CompanyBrainProfile } from './policy.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
export { companyBrainProfile, type CompanyBrainProfile } from './policy.ts';

function statusFix(sourceId: string): Action {
  return readFix(`Shows source ${sourceId}'s registration, ingestion receipt, and outstanding phase.`, { argv: ['gbrain', 'sources', 'status', '--json'] });
}

function resumeCommand(sourceId: string): string {
  return `gbrain sync --source ${sourceId} --no-embed --no-pull`;
}

export async function getCompanyBrainProfile(engine: BrainEngine, sourceId: string): Promise<CompanyBrainProfile | null> {
  const [source] = await engine.executeRaw<{ config: unknown; incarnation: string }>('SELECT config,incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) return null;
  const profile = companyBrainProfile(source.config);
  if (!profile) {
    const [receipt] = await engine.executeRaw("SELECT id FROM source_ingestion_receipts WHERE source_id=$1 AND source_incarnation=$2::uuid AND profile='company-brain' LIMIT 1", [sourceId, source.incarnation]);
    if (receipt) {
      throw opError('profile_incompatible', 'The durable company approval has no source policy. Reconnect explicitly; sync cannot fall back to an unrestricted profile.',
        `Source ${sourceId} has a company-brain receipt but no stored source policy. Check its status; reconnecting means previewing removal with gbrain sources remove ${sourceId} --dry-run and connecting again, a destructive step the user approves. Do not edit stored policy fields.`,
        { fix: statusFix(sourceId) });
    }
  }
  return profile;
}

export interface CompanyBrainSyncContext {
  sourceId: string;
  sourceIncarnation: string;
  receiptId: string;
  plan: CompanyBrainPlan;
  entries: ReadonlyMap<string, InspectionEntry>;
  pack: ResolvedPack;
  policyFingerprint: string;
  failureCode?: string;
  protect(checkpoints: SourceIngestionCheckpoint[]): Promise<void>;
}
const active = new AsyncLocalStorage<CompanyBrainSyncContext>();
export const withCompanyBrainSync = <T>(context: CompanyBrainSyncContext, run: () => T): T => active.run(context, run);
export function currentCompanyBrainSync(sourceId?: string): CompanyBrainSyncContext | undefined {
  const context = active.getStore();
  return context?.sourceId === sourceId ? context : undefined;
}

export async function withCompanyBrainSource<T>(engine: BrainEngine, sourceId: string | undefined, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const context = currentCompanyBrainSync(sourceId);
  if (!context) return run(engine);
  return engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ incarnation: string; local_path: string; config: unknown }>('SELECT incarnation,local_path,config FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [sourceId!]);
    const profile = source ? companyBrainProfile(source.config) : null;
    if (!source || source.incarnation !== context.sourceIncarnation || !profile || source.local_path !== profile.repository.root || profile.receiptId !== context.receiptId ||
      companyBrainPolicyFingerprint(profile, sourceId!) !== context.policyFingerprint) {
      throw opError('source_changed', 'The source incarnation or approved ingestion changed before publication.',
        `Another connect or sync changed source ${sourceId}'s registration or approval while this import ran, so this page was not published. Check the receipt, then resume with ${resumeCommand(sourceId!)}.`,
        { fix: statusFix(sourceId!) });
    }
    return run(tx);
  });
}

export function softDeleteSyncPages(engine: BrainEngine, slugs: string[], opts: { sourceId: string }): Promise<string[]> {
  return withCompanyBrainSource(engine, opts.sourceId, tx => maintenanceTransaction(tx, inner => inner.softDeletePages(slugs, opts)));
}

export async function readCompanyBrainPlan(engine: BrainEngine, receiptId: string): Promise<CompanyBrainPlan> {
  const [row] = await engine.executeRaw<{ completed_keys: CompanyBrainPlan[] }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='company-brain-plan' AND fingerprint=$1", [receiptId]);
  if (!row?.completed_keys?.[0]) {
    throw opError('checkpoint_missing', 'The approved source plan is missing; do not restart from a different revision.',
      `Receipt ${receiptId}'s approved plan checkpoint is gone, so gbrain will not resume from another revision. Check the source status; starting over needs a removal preview and a new reviewed connection, which the user approves.`,
      { fix: readFix(`Shows which source holds receipt ${receiptId} and its outstanding phase.`, { argv: ['gbrain', 'sources', 'status', '--json'] }) });
  }
  return row.completed_keys[0];
}

export async function importCompanyBrainFile(engine: BrainEngine, filePath: string, sourceId: string) {
  const context = currentCompanyBrainSync(sourceId);
  if (!context?.plan.revision) {
    throw opError('plan_stale', 'An approved committed source plan is required.',
      `This import of source ${sourceId} ran outside an approved company-brain sync. Run ${resumeCommand(sourceId)} so the approved plan governs it.`,
      { fix: statusFix(sourceId) });
  }
  const path = relative(context.plan.revision.root, filePath).split('\\').join('/');
  const entry = context.entries.get(path);
  if (!entry?.page || entry.disposition !== 'included') {
    throw opError('plan_stale', 'The import path is outside the approved selection.',
      `${path} is not in source ${sourceId}'s approved selection. Changing the selection needs a new inspection and a separately approved connection.`,
      { fix: statusFix(sourceId) });
  }
  const content = (await readCommittedBlob(context.plan.revision, entry, context.plan.limits)).toString('utf8');
  const pack = context.pack;
  const parsed = parseMarkdown(content, entry.page.slug, { activePack: pack.manifest });
  const snapshot = await engine.readPageSnapshot(entry.page.slug, { sourceId });
  const canonical = (page: Pick<typeof parsed, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) => ({ type: page.type, title: page.title, body: page.compiled_truth,
    timeline: page.timeline ?? '', frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() });
  return importFromContent(engine, entry.page.slug, content, { sourceId, noEmbed: true, remote: false,
    activePack: pack.manifest, filename: basename(path).replace(/\.mdx?$/i, ''), sourcePath: path,
    prepare: async ready => {
      const tags = [...(snapshot?.tags ?? []), ...ready.parsedPage.tags];
      if (digest(canonical(parsed, parsed.tags)) !== digest(canonical(ready.parsedPage, tags))) {
        // #6188 (UC3): a fence Tier 1 would normalize is named by location; the repository commit is the only fix.
        const fences = ready.result.fences_normalized ?? [];
        throw opError('source_writeback_required', fences.length ? `Canonical preparation would normalize a facts or takes fence (${describeFixes(fences)}); this profile never writes repository files.`
          : 'Canonical preparation requires a source-content correction; this profile never writes repository files.',
          fences.length ? `${path} has a facts or takes fence gbrain would normalize (${describeFixes(fences)}), and this profile never edits repository files. Fix the fence in the repository and commit, then resume with ${resumeCommand(sourceId)}.`
            : `${path} would change when published canonically (for example normalized frontmatter or tags), and this profile never edits repository files. Review the needed correction with the user, commit it, then resume with ${resumeCommand(sourceId)}.`);
      }
      if (ready.slug !== entry.page!.slug || ready.observedRevision !== (snapshot?.revision ?? null)) {
        throw opError('revision_conflict', 'The approved file no longer names the same page revision.',
          `Page ${entry.page!.slug} in source ${sourceId} changed after this sync read it, so nothing was published for it. Resume with ${resumeCommand(sourceId)} to import against the current revision.`,
          { fix: statusFix(sourceId) });
      }
      const project = await prepareCanonicalProjections(engine, ready.parsedPage, ready.slug, sourceId, snapshot, 'immutable');
      await withCompanyBrainSource(engine, sourceId, async tx => { await ready.apply(tx); await project(tx); });
      return ready.result;
    } }).catch(error => {
      if (error instanceof OperationError) context.failureCode = error.code;
      throw error;
    });
}
