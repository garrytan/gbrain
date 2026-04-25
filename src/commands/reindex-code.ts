/**
 * v0.21.0 Cathedral II Layer 13 (E2) — `gbrain reindex-code`.
 *
 * Explicit backfill for v0.19.0 → v0.21.0 brains. Layer 12's
 * `sources.chunker_version` gate forces a re-walk next sync on any source
 * whose working tree hasn't drifted, but users who want the benefits NOW
 * (before the next sync) get this: walk every page where type='code', read
 * compiled_truth + frontmatter.file, re-import via importCodeFile. Pages
 * flow through the same code path as normal sync (chunker + embeddings +
 * content_hash folding), so a reindex is bit-identical to a fresh sync.
 *
 * Flags:
 *   --source <id>   Scope to one sources row. Omit = all code pages.
 *   --dry-run       Preview cost + page count, exit 0.
 *   --yes           Skip interactive [y/N]. Required for non-TTY + non-JSON.
 *   --json          Machine-readable ConfirmationRequired / result envelope.
 *   --force         Bypass importCodeFile's content_hash early-return. Use
 *                   this for paranoid full reindex when content_hash equals
 *                   but you still want a re-chunk + re-embed pass.
 *
 * Batched in chunks of 100 pages to avoid OOM on 47K-page brains (codex
 * review Finding 4.4). Idempotent: re-running on already-reindexed pages
 * is a no-op unless --force is passed.
 */

import type { BrainEngine } from '../core/engine.ts';
import { importCodeFile } from '../core/import-file.ts';
import { estimateTokens } from '../core/chunkers/code.ts';
import { EMBEDDING_MODEL, estimateEmbeddingCostUsd } from '../core/embedding.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import { createInterface } from 'readline';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReindexCodeOpts {
  sourceId?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  noEmbed?: boolean;
  /** Page batch size. Default 100 (codex Finding 4.4 OOM protection). */
  batchSize?: number;
}

export interface ReindexCodeResult {
  status: 'ok' | 'dry_run' | 'cancelled' | 'source_id_required';
  codePages: number;
  reindexed: number;
  skipped: number;
  failed: number;
  totalTokens: number;
  costUsd: number;
  model: string;
  failures?: Array<{ slug: string; error: string }>;
}

interface CodePageRow {
  slug: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown> | null;
}

async function fetchCodePages(
  engine: BrainEngine,
  sourceId: string | undefined,
  batchSize: number,
  offset: number,
): Promise<CodePageRow[]> {
  // Direct SQL: listPages doesn't expose source_id filtering, and we need
  // compiled_truth + frontmatter anyway (not just the Page shape).
  const sourceClause = sourceId ? `AND p.source_id = '${sourceId.replace(/'/g, "''")}'` : '';
  const rows = await engine.executeRaw<CodePageRow>(
    `SELECT p.slug, p.compiled_truth, p.frontmatter
     FROM pages p
     WHERE p.type = 'code' ${sourceClause}
     ORDER BY p.slug
     LIMIT ${batchSize} OFFSET ${offset}`,
  );
  return rows;
}

async function countCodePages(engine: BrainEngine, sourceId: string | undefined): Promise<number> {
  const sourceClause = sourceId ? `AND p.source_id = '${sourceId.replace(/'/g, "''")}'` : '';
  const rows = await engine.executeRaw<{ n: string | number }>(
    `SELECT COUNT(*)::text AS n FROM pages p WHERE p.type = 'code' ${sourceClause}`,
  );
  if (rows.length === 0) return 0;
  const raw = rows[0]!.n;
  return typeof raw === 'string' ? parseInt(raw, 10) : raw;
}

/**
 * Estimate total embedding cost for a reindex. Walks every code page's
 * compiled_truth and sums tokens. Conservative: does not try to detect
 * unchanged chunks (the incremental embedding cache in importCodeFile does
 * that; this estimate is the ceiling, not the floor).
 */
async function estimateReindexCost(
  engine: BrainEngine,
  sourceId: string | undefined,
  batchSize: number,
): Promise<{ totalTokens: number; totalPages: number }> {
  let totalTokens = 0;
  let totalPages = 0;
  let offset = 0;
  while (true) {
    const batch = await fetchCodePages(engine, sourceId, batchSize, offset);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (row.compiled_truth) totalTokens += estimateTokens(row.compiled_truth);
      totalPages++;
    }
    offset += batch.length;
    if (batch.length < batchSize) break;
  }
  return { totalTokens, totalPages };
}

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
    rl.on('close', () => resolve(false));
  });
}

export async function runReindexCode(
  engine: BrainEngine,
  opts: ReindexCodeOpts = {},
): Promise<ReindexCodeResult> {
  const batchSize = opts.batchSize ?? 100;

  const { totalTokens, totalPages } = await estimateReindexCost(engine, opts.sourceId, batchSize);
  const costUsd = estimateEmbeddingCostUsd(totalTokens);

  if (opts.dryRun) {
    return {
      status: 'dry_run',
      codePages: totalPages,
      reindexed: 0,
      skipped: 0,
      failed: 0,
      totalTokens,
      costUsd,
      model: EMBEDDING_MODEL,
    };
  }

  if (totalPages === 0) {
    return {
      status: 'ok',
      codePages: 0,
      reindexed: 0,
      skipped: 0,
      failed: 0,
      totalTokens: 0,
      costUsd: 0,
      model: EMBEDDING_MODEL,
    };
  }

  // Walk every code page, re-run importCodeFile with compiled_truth as
  // the content source. relativePath comes from frontmatter.file (set by
  // the original importCodeFile call). Progress via stderr reporter.
  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('reindex_code.pages', totalPages);

  let reindexed = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ slug: string; error: string }> = [];
  let offset = 0;

  try {
    while (true) {
      const batch = await fetchCodePages(engine, opts.sourceId, batchSize, offset);
      if (batch.length === 0) break;

      for (const row of batch) {
        const fm = row.frontmatter ?? {};
        const relPath = typeof fm.file === 'string' ? fm.file : null;
        if (!relPath) {
          failed++;
          failures.push({ slug: row.slug, error: 'missing frontmatter.file' });
          reporter.tick();
          continue;
        }
        if (!row.compiled_truth) {
          failed++;
          failures.push({ slug: row.slug, error: 'missing compiled_truth' });
          reporter.tick();
          continue;
        }
        try {
          const result = await importCodeFile(engine, relPath, row.compiled_truth, {
            noEmbed: opts.noEmbed,
            force: opts.force,
          });
          if (result.status === 'imported') reindexed++;
          else if (result.status === 'skipped') skipped++;
          else {
            failed++;
            failures.push({ slug: row.slug, error: result.error ?? result.status });
          }
        } catch (e: unknown) {
          failed++;
          failures.push({ slug: row.slug, error: e instanceof Error ? e.message : String(e) });
        }
        reporter.tick();
      }

      offset += batch.length;
      if (batch.length < batchSize) break;
    }
  } finally {
    reporter.finish();
  }

  return {
    status: 'ok',
    codePages: totalPages,
    reindexed,
    skipped,
    failed,
    totalTokens,
    costUsd,
    model: EMBEDDING_MODEL,
    failures: failures.length > 0 ? failures : undefined,
  };
}

/**
 * CLI entrypoint. Parses argv, wires cost-preview gate + JSON/TTY branching,
 * delegates to runReindexCode. Exit codes: 0 on success/dry-run, 2 on
 * ConfirmationRequired (matches sync --all), 1 on runtime error.
 */
export async function runReindexCodeCli(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const json = args.includes('--json');
  const force = args.includes('--force');
  const noEmbed = args.includes('--no-embed');

  if (dryRun) {
    const result = await runReindexCode(engine, { sourceId, dryRun: true, yes, json, force, noEmbed });
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(
        `reindex-code preview: ${result.codePages} code page(s), ` +
          `~${result.totalTokens.toLocaleString()} tokens, ` +
          `est. $${result.costUsd.toFixed(2)} on ${result.model}.`,
      );
      console.log('--dry-run: exit without reindexing.');
    }
    return;
  }

  // Cost preview + gate, before touching the DB.
  if (!noEmbed) {
    const preview = await estimateReindexCost(engine, sourceId, 100);
    const costUsd = estimateEmbeddingCostUsd(preview.totalTokens);
    const previewMsg =
      `reindex-code: ${preview.totalPages} code page(s), ` +
      `~${preview.totalTokens.toLocaleString()} tokens, ` +
      `est. $${costUsd.toFixed(2)} on ${EMBEDDING_MODEL}.`;

    if (preview.totalPages === 0) {
      if (json) {
        console.log(JSON.stringify({ status: 'ok', codePages: 0, reindexed: 0, skipped: 0, failed: 0, totalTokens: 0, costUsd: 0, model: EMBEDDING_MODEL }));
      } else {
        console.log('No code pages to reindex.');
      }
      return;
    }

    if (!yes) {
      const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
      if (!isTTY || json) {
        const envelope = serializeError(errorFor({
          class: 'ConfirmationRequired',
          code: 'cost_preview_requires_yes',
          message: previewMsg,
          hint: 'Pass --yes to proceed, or --dry-run to see the preview and exit 0.',
        }));
        console.log(JSON.stringify({ error: envelope, preview, costUsd, model: EMBEDDING_MODEL }));
        process.exit(2);
      }
      console.log(previewMsg);
      const answer = await promptYesNo('Proceed? [y/N] ');
      if (!answer) {
        console.log('Cancelled.');
        return;
      }
    }
  }

  const result = await runReindexCode(engine, { sourceId, yes, json, force, noEmbed });
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `reindex-code: ${result.reindexed} reindexed, ${result.skipped} skipped, ${result.failed} failed ` +
        `(${result.codePages} total code pages, ~${result.totalTokens.toLocaleString()} tokens, ` +
        `est. $${result.costUsd.toFixed(2)}).`,
    );
    if (result.failures && result.failures.length > 0) {
      console.log(`\n${result.failures.length} failure(s):`);
      for (const f of result.failures.slice(0, 10)) {
        console.log(`  ${f.slug}: ${f.error}`);
      }
      if (result.failures.length > 10) {
        console.log(`  ... and ${result.failures.length - 10} more`);
      }
    }
  }
}
