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
 */

import type { BrainEngine } from '../core/engine.ts';
import { normalizeAliasList } from '../core/search/alias-normalize.ts';
import { writeDerivedAliases } from '../core/mentions/pass.ts';
import { readMentionPolicy } from '../core/mentions/policy.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { maintenanceAttribution } from '../core/persistence/attribution.ts';
import { withCoordinatedWrite } from '../core/persistence/context.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReindexAliasesResult {
  scanned: number;
  pages_with_aliases: number;
  aliases_written: number;
  dry_run: boolean;
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
    try {
      if (aliasNorms.length) await engine.setPageAliases(ref.slug, ref.source_id, aliasNorms);
      const derived = await derivedWrite(ref.source_id, tx => writeDerivedAliases(tx, ref.source_id,
        { slug: ref.slug, title: page.title, type: page.type, compiled_truth: page.compiled_truth, timeline: page.timeline, frontmatter: page.frontmatter as Record<string, unknown> | undefined }, { policy: mentionPolicy }));
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
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const verb = dryRun ? 'would write' : 'wrote';
    console.log(`reindex --aliases: scanned ${scanned} pages, ${verb} ${aliasesWritten} aliases across ${pagesWithAliases} pages.`);
  }
  return result;
}
