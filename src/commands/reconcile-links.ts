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
 *
 * A segmented page (Wave B) is read block by block (`bodyLines`): a code ref
 * never spans a line, so it gets the refs the same text held as one string
 * gets. A page a block read refuses is listed in `skipped` and the walk goes on.
 */

import type { BrainEngine } from '../core/engine.ts';
import { PageMissingError } from '../core/engine-errors.ts';
import type { Page } from '../core/types.ts';
import { extractCodeRefs, type CodeRef } from '../core/link-extraction.ts';
import { OperationError } from '../core/ops/contract.ts';
import { isSegmentedPage } from '../core/page-body/page-shape.ts';
import { bodyLines } from '../core/page-body/segment-lines.ts';
import { slugifyCodePath } from '../core/sync.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReconcileLinksResult {
  status: 'ok' | 'auto_link_disabled';
  markdownPagesScanned: number;
  codeRefsFound: number;
  edgesAttempted: number;
  edgesTargetsMissing: number;
  /** Pages a per-page refusal kept out of the scan (present only when there are any). */
  skipped?: Array<{ slug: string; reason: string; message: string }>;
}

/**
 * Code refs of a page's `${compiled_truth}\n${timeline}`, first occurrence of each path, in text order. A segmented
 * page is read a block of lines at a time; `index` stays an offset into the joined text.
 */
async function pageCodeRefs(engine: BrainEngine, page: Page): Promise<CodeRef[]> {
  if (!isSegmentedPage(page)) return extractCodeRefs((page.compiled_truth || '') + '\n' + (page.timeline || ''));
  const seen = new Set<string>();
  const refs: CodeRef[] = [];
  let at = 0;
  for await (const lines of bodyLines(engine, page)) {
    const text = lines.join('\n');
    for (const ref of extractCodeRefs(text)) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      refs.push({ path: Buffer.from(ref.path, 'utf8').toString('utf8'), line: ref.line, index: ref.index + at });
    }
    at += text.length + 1;
  }
  return refs;
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
  const skipped: NonNullable<ReconcileLinksResult['skipped']> = [];

  // Fetch pages one at a time via getPage (no bulk read helper exists yet).
  // On a 47K-page brain this is the slow path; a v0.20.x follow-up can add
  // getPagesBatch. For the typical 2K–5K markdown count it's fine.
  // v0.18.0+ multi-source: source-scope getPage so reconcile picks up the
  // intended-source row for `default`-vs-`<source>` ambiguity. The link
  // edges below also propagate the same sourceId (Data R1 MED 1: opt was
  // declared on ReconcileLinksOpts but ignored end-to-end).
  const getPageOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  const linkOpts = opts.sourceId
    ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId, originSourceId: opts.sourceId }
    : undefined;
  for (const mdSlug of mdSlugs) {
    const page = await engine.getPage(mdSlug, getPageOpts);
    if (!page) {
      progress.tick(1, mdSlug);
      continue;
    }
    let refs: CodeRef[];
    try {
      refs = await pageCodeRefs(engine, page);
    } catch (e: unknown) {
      if (!(e instanceof OperationError && e.code === 'page_body_segmented')) throw e;
      skipped.push({ slug: mdSlug, reason: e.code, message: e.message });
      progress.tick(1, `${mdSlug} (skipped)`);
      continue;
    }
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
        // Forward: guide documents code. addLink's inner JOIN drops silently
        // if codeSlug isn't a page yet (benign — counted below). Source-
        // qualified per opts.sourceId; same-source assumption mirrors the
        // import-file.ts:303 doc↔impl auto-link.
        await engine.addLink(mdSlug, codeSlug, ctx, 'documents', 'markdown', mdSlug, 'compiled_truth', linkOpts); // gbrain-allow-direct-insert: gbrain reconcile-links command — code-graph reconciliation from markdown references
        await engine.addLink(codeSlug, mdSlug, ref.path, 'documented_by', 'markdown', mdSlug, 'compiled_truth', linkOpts); // gbrain-allow-direct-insert: gbrain reconcile-links command — reverse documented_by edge
      } catch (e: unknown) {
        // Per-link errors don't abort the batch. Track them for the summary.
        if (e instanceof PageMissingError) {
          edgesTargetsMissing++;
        } else {
          // Real error — log but keep going. Agents can inspect progress events.
          console.warn(`[reconcile-links] ${mdSlug} → ${codeSlug}: ${e instanceof Error ? e.message : String(e)}`);
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
    ...(skipped.length ? { skipped } : {}),
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
  for (const page of result.skipped ?? []) console.log(`[reconcile-links] skipped ${page.slug} (${page.reason}): ${page.message}`);
}
