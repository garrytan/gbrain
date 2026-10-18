/**
 * `gbrain reindex --aliases [--limit N] [--dry-run] [--json] [--source <id>]`
 * (T8 — backfill the free-text alias layer).
 *
 * Import-time projection (T3) covers NEW + changed pages; this backfills the
 * EXISTING pages: each page's frontmatter `aliases:` (origin frontmatter)
 * and, for linkable entity pages, its title subject and declared aliases
 * (origin subject / declared, the same rows import and the mention pass
 * write), including pages that have no frontmatter aliases.
 *
 * Idempotent: each origin's rows are replaced, so re-running is safe and
 * convergent — no op-checkpoint needed (the op is fast, no embedding).
 * Walks listAllPageRefs (cheap (source_id, slug) enumeration) so it's
 * cross-source by default; --source narrows it. On a managed brain the
 * derived rows are written through the coordinated writer.
 *
 * A segmented page (Wave B) derives its aliases from its body read back as
 * strings (`materializedPage`), as its import did. A body over the
 * single-string ceiling is never read as one string: like its streamed
 * import, the page gets its frontmatter and subject aliases only, and is
 * listed in `body_not_scanned`. A per-page refusal is listed in `skipped`
 * and the walk goes on.
 */

import type { BrainEngine } from '../core/engine.ts';
import { normalizeAliasList } from '../core/search/alias-normalize.ts';
import { writeDerivedAliases } from '../core/mentions/pass.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy, type PackTypes } from '../core/mentions/policy.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { maintenanceAttribution } from '../core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../core/persistence/context.ts';
import { createProgress } from '../core/progress.ts';
import { OperationError } from '../core/ops/contract.ts';
import { bodyUnread, isSegmentedPage } from '../core/page-body/page-shape.ts';
import { materializedPage } from '../core/persistence/segmented-apply.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReindexAliasesResult {
  scanned: number;
  pages_with_aliases: number;
  aliases_written: number;
  dry_run: boolean;
  /** Segmented pages over the single-string ceiling whose body was not scanned for declared aliases (present only when there are any). */
  body_not_scanned?: Array<{ slug: string; source_id: string; reason: string }>;
  /** Pages a per-page refusal kept out of the walk (present only when there are any). */
  skipped?: Array<{ slug: string; source_id: string; reason: string; message: string }>;
}

export async function runReindexAliases(engine: BrainEngine, args: string[]): Promise<ReindexAliasesResult> {
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? '', 10) : NaN;
  const sourceIdx = args.indexOf('--source');
  const sourceFilter = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;

  let refs = await engine.listAllPageRefs();
  if (sourceFilter) refs = refs.filter(r => r.source_id === sourceFilter);
  if (Number.isFinite(limit) && limit > 0) refs = refs.slice(0, limit);

  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('reindex.aliases', refs.length);

  let scanned = 0;
  let pagesWithAliases = 0;
  let aliasesWritten = 0;
  const managed = await managedPersistenceEnabled(engine);
  const attribution = managed ? await maintenanceAttribution(engine) : null;
  const derivedWrite = (sourceId: string, fn: (tx: BrainEngine) => Promise<number>) => engine.transaction(tx =>
    attribution ? withCoordinatedWrite(tx, [sourceId], () => fn(tx), attribution) : fn(tx));

  const mentionPolicy = dryRun ? null : await readMentionPolicy(engine);
  const bodyNotScanned: NonNullable<ReindexAliasesResult['body_not_scanned']> = [];
  const skipped: NonNullable<ReindexAliasesResult['skipped']> = [];
  for (const ref of refs) {
    scanned++;
    reporter.tick();
    let page;
    try {
      page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    } catch {
      continue;
    }
    if (!page) continue;
    const aliasNorms = normalizeAliasList((page.frontmatter as Record<string, unknown> | undefined)?.aliases);
    if (dryRun) {
      if (aliasNorms.length) { pagesWithAliases++; aliasesWritten += aliasNorms.length; }
      continue;
    }
    let body: { compiled_truth: string | null; timeline: string | null } = { compiled_truth: '', timeline: '' };
    let pack: PackTypes | null | undefined;
    if (!isSegmentedPage(page)) body = { compiled_truth: page.compiled_truth, timeline: page.timeline };
    else if (mentionPolicy?.enabled) {
      pack = await loadSourcePack(engine, ref.source_id);
      if (linkableTypesFor(pack, mentionPolicy).includes(page.type ?? '')) {
        try {
          const read = await materializedPage(engine, page);
          if (!bodyUnread(read)) body = { compiled_truth: read.compiled_truth, timeline: read.timeline };
          else bodyNotScanned.push({ slug: ref.slug, source_id: ref.source_id,
            reason: 'its body is over the single-string ceiling, so declared aliases are not derived from it (frontmatter and subject aliases are written)' });
        } catch (e) {
          if (!(e instanceof OperationError && e.code === 'page_body_segmented')) throw e;
          skipped.push({ slug: ref.slug, source_id: ref.source_id, reason: e.code, message: e.message });
          continue;
        }
      }
    }
    try {
      if (aliasNorms.length) await engine.setPageAliases(ref.slug, ref.source_id, aliasNorms);
      const derived = await derivedWrite(ref.source_id, tx => writeDerivedAliases(tx, ref.source_id,
        { slug: ref.slug, title: page.title, type: page.type, ...body, frontmatter: page.frontmatter as Record<string, unknown> | undefined },
        { policy: mentionPolicy, ...(pack !== undefined ? { pack } : {}) }));
      if (aliasNorms.length || derived) pagesWithAliases++;
      aliasesWritten += aliasNorms.length + derived;
    } catch (e) {
      reporter.finish();
      throw e; // pre-v110 (no table) or a real write error — surface it.
    }
  }

  reporter.finish();
  const result: ReindexAliasesResult = {
    scanned,
    pages_with_aliases: pagesWithAliases,
    aliases_written: aliasesWritten,
    dry_run: dryRun,
    ...(bodyNotScanned.length ? { body_not_scanned: bodyNotScanned } : {}),
    ...(skipped.length ? { skipped } : {}),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const verb = dryRun ? 'would write' : 'wrote';
    console.log(`reindex --aliases: scanned ${scanned} pages, ${verb} ${aliasesWritten} aliases across ${pagesWithAliases} pages.`);
    for (const page of bodyNotScanned) console.log(`  body not scanned: ${page.source_id}:${page.slug}: ${page.reason}`);
    for (const page of skipped) console.log(`  skipped ${page.source_id}:${page.slug} (${page.reason}): ${page.message}`);
  }
  return result;
}
