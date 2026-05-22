/**
 * v0.20.0 Cathedral II Layer 8 D3 — reconcile-links batch command.
 *
 * Closes the v0.19.0 Layer 6 doc↔impl order-dependency bug. When a
 * markdown guide cites `src/core/sync.ts:42` but the code source
 * hasn't been synced yet, the forward-scan at import time inserts
 * nothing because `addLink`'s inner SELECT drops edges to missing
 * pages. The guide and the code eventually both exist, but the edge
 * never materialized.
 *
 * D3 fixes this batch-style: walk every markdown page, re-run
 * `extractCodeRefs`, and call `addLink(md, code, ..., 'documents')` +
 * reverse for each hit. ON CONFLICT DO NOTHING on the `links` table
 * makes the operation idempotent — edges that already exist stay,
 * new edges land.
 *
 * Why batch over per-import-reverse-scan: codex 2-phase review
 * flagged the per-import approach as O(N) ILIKE/JOIN queries per
 * code file imported. On a 47K-page brain first-syncing 5K code
 * files, that's 5K ILIKE scans. A user-triggered batch pass on an
 * already-synced brain is one walk, fully indexed via the existing
 * slug lookup in addLink.
 */

import type { BrainEngine } from '../core/engine.ts';
import { extractCodeRefs } from '../core/link-extraction.ts';
import { slugifyCodePath } from '../core/sync.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReconcileLinksResult {
  status: 'ok' | 'auto_link_disabled';
  markdownPagesScanned: number;
  codeRefsFound: number;
  edgesAttempted: number;
  edgesTargetsMissing: number;
}

export interface ReconcileLinksOpts {
  sourceId?: string;
  dryRun?: boolean;
}

/**
 * Scan every markdown page for code-path references (e.g.
 * `src/core/sync.ts`, `lib/foo.py:42`) and create bidirectional
 * doc↔impl edges (`documents` + `documented_by`) for each hit
 * that resolves to a code page. Idempotent via ON CONFLICT DO
 * NOTHING in the underlying addLink path.
 *
 * Called by `gbrain reconcile-links` CLI surface. Respects the
 * `auto_link` config: if the user has disabled auto-linking on
 * put_page, reconcile-links doesn't silently re-populate those
 * edges either.
 */
export async function runReconcileLinks(
  engine: BrainEngine,
  opts: ReconcileLinksOpts = {},
): Promise<ReconcileLinksResult> {
  // Respect auto_link config (same gate put_page uses). A user that
  // explicitly turned off auto-link doesn't want reconcile-links
  // writing edges back either.
  const autoLinkCfg = await engine.getConfig('auto_link');
  if (autoLinkCfg === 'false') {
    return {
      status: 'auto_link_disabled',
      markdownPagesScanned: 0,
      codeRefsFound: 0,
      edgesAttempted: 0,
      edgesTargetsMissing: 0,
    };
  }

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Walk all markdown slugs. listPages(markdown-only filter) isn't exposed,
  // so filter at call time via page_kind. Not using getAllSlugs because we
  // also need compiled_truth + timeline for extractCodeRefs.
  const mdSlugs = (await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE page_kind = 'markdown' ORDER BY slug`,
  )).map(r => r.slug);

  progress.start('reconcile_links.scan', mdSlugs.length);

  let codeRefsFound = 0;
  let edgesAttempted = 0;
  let edgesTargetsMissing = 0;

  // Fetch pages one at a time via getPage (no bulk read helper exists yet).
  // On a 47K-page brain this is the slow path; a v0.20.x follow-up can add
  // getPagesBatch. For the typical 2K–5K markdown count it's fine.
  for (const mdSlug of mdSlugs) {
    const page = await engine.getPage(mdSlug);
    if (!page) {
      progress.tick(1, mdSlug);
      continue;
    }
    const haystack = (page.compiled_truth || '') + '\n' + (page.timeline || '');
    const refs = extractCodeRefs(haystack);
    if (refs.length === 0) {
      progress.tick(1, mdSlug);
      continue;
    }
    codeRefsFound += refs.length;

    if (opts.dryRun) {
      progress.tick(1, `${mdSlug} (+${refs.length} refs)`);
      continue;
    }

    for (const ref of refs) {
      const codeSlug = slugifyCodePath(ref.path);
      const ctx = ref.line ? `cited at ${ref.path}:${ref.line}` : ref.path;
      edgesAttempted++;
      try {
        // Forward: guide documents code. addLink's inner SELECT drops
        // silently if codeSlug isn't a page yet (benign — counted below).
        await engine.addLink(mdSlug, codeSlug, ctx, 'documents', 'markdown', mdSlug, 'compiled_truth');
        await engine.addLink(codeSlug, mdSlug, ref.path, 'documented_by', 'markdown', mdSlug, 'compiled_truth');
      } catch (e: unknown) {
        // Per-link errors don't abort the batch. Track them for the summary.
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found|does not exist/i.test(msg)) {
          edgesTargetsMissing++;
        } else {
          // Real error — log but keep going. Agents can inspect progress events.
          console.warn(`[reconcile-links] ${mdSlug} → ${codeSlug}: ${msg}`);
        }
      }
    }
    progress.tick(1, `${mdSlug} (+${refs.length} refs)`);
  }

  progress.finish();

  return {
    status: 'ok',
    markdownPagesScanned: mdSlugs.length,
    codeRefsFound,
    edgesAttempted,
    edgesTargetsMissing,
  };
}

/**
 * CLI entry. Parses argv, runs runReconcileLinks, prints a summary.
 * --dry-run reports counts without writing. --json emits machine output.
 */
export async function runReconcileLinksCli(engine: BrainEngine, args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const jsonOut = args.includes('--json');

  const result = await runReconcileLinks(engine, { dryRun });

  if (jsonOut) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.status === 'auto_link_disabled') {
    console.log(
      '[reconcile-links] auto_link is disabled in config; skipping. ' +
      'Set `gbrain config set auto_link true` to re-enable.',
    );
    return;
  }

  const header = dryRun ? 'reconcile-links (dry run)' : 'reconcile-links';
  console.log(
    `${header}: scanned ${result.markdownPagesScanned} markdown pages, ` +
    `found ${result.codeRefsFound} code refs, ` +
    `attempted ${result.edgesAttempted} edges` +
    (result.edgesTargetsMissing > 0
      ? ` (${result.edgesTargetsMissing} targets missing code page)`
      : ''),
  );
}
