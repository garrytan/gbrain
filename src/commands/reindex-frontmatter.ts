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
 *   --source <id>      Scope to one sources row (preview, hash and apply). Omit = all pages.
 *   --slug-prefix P    Scope to slugs starting with P (e.g. 'meetings/').
 *   --dry-run          Print what WOULD change (and its plan_hash), no DB writes.
 *   --yes --expect H   Apply the plan the user approved without a prompt. Without
 *                      it a non-interactive run (--json included) changes nothing
 *                      and exits 3 with the consent payload.
 *   --json             Machine-readable result envelope.
 *   --force            Re-apply even when computed value matches existing
 *                      (bypasses no-op-on-equal guard).
 */

import type { BrainEngine } from '../core/engine.ts';
import { backfillEffectiveDate } from '../core/backfill-effective-date.ts';
import { computePlanHash, type PlanSelection } from '../core/consent.ts';
import { consentGate } from '../core/consent-cli.ts';

export interface ReindexFrontmatterOpts {
  sourceId?: string;
  slugPrefix?: string;
  dryRun?: boolean;
  yes?: boolean;
  /** `--expect <plan_hash>`: the plan the user approved (from the dry run or the refusal). */
  expect?: string;
  json?: boolean;
  force?: boolean;
  /**
   * v0.41.15.0 (T12, D9): accepted for API consistency with the other
   * `gbrain reindex --workers N` surfaces but currently INFORMATIONAL
   * ONLY. reindex-frontmatter delegates to `backfillEffectiveDate`
   * which has its own internal batching and doesn't expose a worker
   * count. The work is pure CPU (date precedence resolution per row,
   * no I/O), so parallelism gains would be marginal. Deep wiring is
   * filed as a v0.42+ follow-up TODO. Pass `--workers N` today and
   * the flag is recorded + ignored.
   */
  workers?: number;
}

export interface ReindexFrontmatterResult {
  /** `confirmation_required`: consent refused; the refusal was printed (exit verdict 3) and nothing changed. */
  status: 'ok' | 'dry_run' | 'confirmation_required';
  examined: number;
  updated: number;
  fallback: number;
  durationSec: number;
  source_filter?: string;
  slug_prefix?: string;
  /** Dry run: the hash an approved apply names with `--yes --expect <plan_hash>`. */
  plan_hash?: string;
}

/** The rows one invocation would change: the selection its preview, plan hash and apply share. */
async function previewSelection(engine: BrainEngine, opts: ReindexFrontmatterOpts) {
  const changes: Array<{ id: string; revision: string }> = [];
  const r = await backfillEffectiveDate(engine, {
    slugPrefix: opts.slugPrefix,
    sourceId: opts.sourceId,
    dryRun: true,
    force: opts.force,
    onChange: row => changes.push({ id: String(row.id), revision: `${row.effective_date ?? ''}|${row.effective_date_source ?? ''}` }),
  });
  const selection: PlanSelection = {
    brain: 'host',
    source: opts.sourceId ?? null,
    operation: 'reindex-frontmatter',
    records: changes,
    parameters: { slug_prefix: opts.slugPrefix ?? null, force: opts.force === true },
    effects: ['destructive'],
  };
  return { result: r, selection, plan_hash: computePlanHash(selection) };
}

/** The scope flags an approved or preview command repeats. */
function scopeArgv(opts: ReindexFrontmatterOpts): string[] {
  return [
    ...(opts.sourceId ? ['--source', opts.sourceId] : []),
    ...(opts.slugPrefix ? ['--slug-prefix', opts.slugPrefix] : []),
    ...(opts.force ? ['--force'] : []),
  ];
}

/**
 * Preview (dry run) or apply. Apply previews the same selection first, asks
 * through requireConsent (destructive: it overwrites stored effective_date
 * values, bound to the plan hash of exactly the rows that would change), and
 * then writes only those rows. `--json` never implies consent. Returns
 * `confirmation_required` when consent was refused (the refusal is printed,
 * exit verdict 3).
 */
export async function runReindexFrontmatter(
  engine: BrainEngine,
  opts: ReindexFrontmatterOpts,
  args: readonly string[] = [...(opts.yes ? ['--yes'] : []), ...(opts.expect ? ['--expect', opts.expect] : [])],
): Promise<ReindexFrontmatterResult> {
  const preview = await previewSelection(engine, opts);
  const scope = { slug_prefix: opts.slugPrefix, source_filter: opts.sourceId };
  if (opts.dryRun) {
    const r = preview.result;
    return { status: 'dry_run', examined: r.examined, updated: r.updated, fallback: r.fallback, durationSec: r.durationSec, ...scope,
      plan_hash: preview.plan_hash };
  }
  const n = preview.selection.records.length;
  if (n === 0) {
    return { status: 'ok', examined: preview.result.examined, updated: 0, fallback: 0, durationSec: preview.result.durationSec, ...scope };
  }

  const where = `${opts.sourceId ? ` in source ${opts.sourceId}` : ''}${opts.slugPrefix ? ` under ${opts.slugPrefix}` : ''}`;
  const auth = await consentGate({
    command: 'reindex-frontmatter',
    effects: ['destructive'],
    actor: 'agent',
    what: `Rewrite the effective date of ${n} page(s)${where}`,
    why: 'Re-derives pages.effective_date from each page\'s frontmatter, filename and timestamps with the current precedence rules.',
    risk: `Overwrites the stored effective_date and effective_date_source of ${n} page(s); the previous values are not kept, `
      + 'and date-ordered recall and timelines change accordingly. Pages, chunks and frontmatter are not touched.',
    user_message: `Recompute the effective date of ${n} page(s)${where}? Their current stored dates are replaced.`,
    argv: ['gbrain', 'reindex-frontmatter', ...scopeArgv(opts), ...(opts.json ? ['--json'] : [])],
    preview_argv: ['gbrain', 'reindex-frontmatter', ...scopeArgv(opts), '--dry-run', '--json'],
    plan_hash: preview.plan_hash,
    selection: preview.selection,
    args,
  }, { json: opts.json === true });
  if (!auth) return { status: 'confirmation_required', examined: preview.result.examined, updated: 0, fallback: 0, durationSec: preview.result.durationSec, ...scope };

  const r = await backfillEffectiveDate(engine, {
    slugPrefix: opts.slugPrefix,
    sourceId: opts.sourceId,
    onlyIds: new Set(preview.selection.records.map(rec => Number(rec.id))),
    force: opts.force,
    fresh: true, // CLI is explicit; ignore checkpoint from prior orchestrator runs
    onBatch: ({ batch, lastId, rowsTouched, cumulative }) => {
      if (!opts.json && batch % 5 === 0) {
        process.stderr.write(`  [reindex] batch ${batch} | last_id=${lastId} | examined=${cumulative} | updated=${rowsTouched}\n`);
      }
    },
  });

  return { status: 'ok', examined: r.examined, updated: r.updated, fallback: r.fallback, durationSec: r.durationSec, ...scope };
}

/**
 * CLI entrypoint. Argv shape matches reindex-code for consistency.
 *
 * #1963: takes the ALREADY-CONNECTED engine from cli.ts's dispatch instead of
 * building its own. The old self-managed `createEngine()+connect()` here was a
 * same-process double-connect: cli.ts's `connectEngine()` already held the
 * PGLite data-dir lock, so the second `connect()` spun the full 30s lock
 * timeout waiting on its own process and the command always exited 1 on
 * PGLite. The engine lifecycle (connect + teardown) belongs to cli.ts.
 */
export async function reindexFrontmatterCli(engine: BrainEngine, args: string[]): Promise<void> {
  const opts: ReindexFrontmatterOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') opts.sourceId = args[++i];
    else if (a === '--slug-prefix') opts.slugPrefix = args[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--expect') opts.expect = args[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--workers' || a === '--concurrency') {
      // v0.41.15.0 (T12): accepted but informational only — see opts doc.
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 1) opts.workers = v;
    }
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }

  const result = await runReindexFrontmatter(engine, opts);
  if (result.status === 'confirmation_required') return;
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const noun = result.status === 'dry_run' ? 'would update' : 'updated';
    console.error(
      `\nReindex ${result.status}: examined=${result.examined} ${noun}=${result.updated} ` +
      `fallback=${result.fallback} dur=${result.durationSec.toFixed(1)}s`,
    );
  }
}
