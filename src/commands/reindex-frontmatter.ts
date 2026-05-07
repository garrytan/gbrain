/**
 * v0.29.1 — `gbrain reindex-frontmatter`.
 *
 * Recovery / explicit-rebuild path for `pages.effective_date`. Useful when:
 *   - The user edited frontmatter dates after import and wants the effective_date
 *     column refreshed without a full `gbrain sync`.
 *   - The post-upgrade backfill orchestrator finished but the user wants to
 *     re-walk a subset (e.g. just `meetings/`) after fixing some frontmatter.
 *   - The precedence rules change between releases and the user wants to
 *     re-apply on existing rows.
 *
 * Thin wrapper over the shared library function in
 * `src/core/backfill-effective-date.ts` (same code path the migration
 * orchestrator uses; one source of truth for the backfill logic).
 *
 * Flags mirror `reindex-code`:
 *   --source <id>      Scope to one sources row. Omit = all pages.
 *   --slug-prefix P    Scope to slugs starting with P (e.g. 'meetings/').
 *   --dry-run          Print what WOULD change, no DB writes.
 *   --yes              Skip the confirmation prompt (required for non-TTY non-JSON).
 *   --json             Machine-readable result envelope.
 *   --force            Re-apply even when computed value matches existing
 *                      (bypasses no-op-on-equal guard).
 */

import type { BrainEngine } from '../core/engine.ts';
import { backfillEffectiveDate } from '../core/backfill-effective-date.ts';
import { createInterface } from 'readline';

export interface ReindexFrontmatterOpts {
  sourceId?: string;
  slugPrefix?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
}

export interface ReindexFrontmatterResult {
  status: 'ok' | 'dry_run' | 'cancelled';
  examined: number;
  updated: number;
  fallback: number;
  durationSec: number;
  source_filter?: string;
  slug_prefix?: string;
}

async function countAffected(
  engine: BrainEngine,
  slugPrefix: string | undefined,
  sourceId: string | undefined,
): Promise<number> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (slugPrefix) {
    params.push(slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    where.push(`slug LIKE $${params.length} ESCAPE '\\\\'`);
  }
  if (sourceId) {
    params.push(sourceId);
    where.push(`source_id = $${params.length}`);
  }
  const sql = `SELECT COUNT(*)::text AS n FROM pages${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const rows = await engine.executeRaw<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // No TTY = require --yes
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(prompt + ' [y/N] ', (ans: string) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

export async function runReindexFrontmatter(
  engine: BrainEngine,
  opts: ReindexFrontmatterOpts,
): Promise<ReindexFrontmatterResult> {
  const total = await countAffected(engine, opts.slugPrefix, opts.sourceId);

  if (opts.dryRun) {
    // Library function with dryRun=true counts would-update without writing.
    const r = await backfillEffectiveDate(engine, {
      slugPrefix: opts.slugPrefix,
      dryRun: true,
      force: opts.force,
      // Note: the library doesn't support sourceId filter today; documented
      // as a v0.30+ enhancement. CLI surfaces the param so the future
      // refinement is non-breaking.
      maxRows: total > 0 ? total : undefined,
    });
    return {
      status: 'dry_run',
      examined: r.examined,
      updated: r.updated,
      fallback: r.fallback,
      durationSec: r.durationSec,
      slug_prefix: opts.slugPrefix,
      source_filter: opts.sourceId,
    };
  }

  // Confirm in TTY non-yes flow.
  if (!opts.yes && !opts.json && total > 100) {
    const ok = await confirm(`Reindex effective_date on ${total} page(s)? Force=${opts.force ? 'yes' : 'no'}.`);
    if (!ok) {
      return {
        status: 'cancelled',
        examined: 0, updated: 0, fallback: 0, durationSec: 0,
        slug_prefix: opts.slugPrefix,
        source_filter: opts.sourceId,
      };
    }
  }

  const r = await backfillEffectiveDate(engine, {
    slugPrefix: opts.slugPrefix,
    force: opts.force,
    fresh: true, // CLI is explicit; ignore checkpoint from prior orchestrator runs
    onBatch: ({ batch, lastId, rowsTouched, cumulative }) => {
      if (!opts.json && batch % 5 === 0) {
        process.stderr.write(`  [reindex] batch ${batch} | last_id=${lastId} | examined=${cumulative} | updated=${rowsTouched}\n`);
      }
    },
  });

  return {
    status: 'ok',
    examined: r.examined,
    updated: r.updated,
    fallback: r.fallback,
    durationSec: r.durationSec,
    slug_prefix: opts.slugPrefix,
    source_filter: opts.sourceId,
  };
}

/** CLI entrypoint. Argv shape matches reindex-code for consistency. */
export async function reindexFrontmatterCli(args: string[]): Promise<void> {
  const opts: ReindexFrontmatterOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') opts.sourceId = args[++i];
    else if (a === '--slug-prefix') opts.slugPrefix = args[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--force') opts.force = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }

  const { createEngine } = await import('../core/engine-factory.ts');
  const { loadConfig, toEngineConfig } = await import('../core/config.ts');
  const cfg = loadConfig();
  if (!cfg) {
    console.error('No gbrain config; run `gbrain init` first.');
    process.exit(1);
  }
  const engine = await createEngine(toEngineConfig(cfg));

  try {
    const result = await runReindexFrontmatter(engine, opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const noun = result.status === 'dry_run' ? 'would update' : 'updated';
      console.error(
        `\nReindex ${result.status}: examined=${result.examined} ${noun}=${result.updated} ` +
        `fallback=${result.fallback} dur=${result.durationSec.toFixed(1)}s`,
      );
    }
    if (result.status === 'cancelled') process.exit(1);
  } finally {
    if ('disconnect' in engine && typeof engine.disconnect === 'function') {
      await engine.disconnect();
    }
  }
}
