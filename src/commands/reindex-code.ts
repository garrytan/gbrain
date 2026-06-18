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
import { getEmbeddingModelName, estimateEmbeddingCostUsd } from '../core/embedding.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import { createInterface } from 'readline';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { BudgetTracker, BudgetExhausted } from '../core/budget/budget-tracker.ts';
import { withBudgetTracker } from '../core/ai/gateway.ts';
// v0.41.15.0 (T11, D9): per-batch parallel workers. BudgetExhausted
// auto-aborts via the worker-pool's D13 bypass.
import { runSlidingPool } from '../core/worker-pool.ts';
import { parseWorkers, resolveWorkersWithClamp } from '../core/sync-concurrency.ts';

export interface ReindexCodeOpts {
  sourceId?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  noEmbed?: boolean;
  /** Page batch size. Default 100 (codex Finding 4.4 OOM protection). */
  batchSize?: number;
  /**
   * Cap embedding spend in USD. Default undefined = no cap (legacy behavior).
   * When set, the reindex body runs inside a `withBudgetTracker` scope so
   * every `gateway.embed()` call inside `importCodeFile` composes with the
   * cap. Throws BudgetExhausted (reason='cost') when cumulative exceeds the
   * cap; partial progress is preserved (already-imported pages stay
   * imported, the throw aborts the remaining batch).
   */
  maxCostUsd?: number;
  /**
   * v0.41.15.0 (T11, D9): per-batch parallel workers. Default 1.
   * PGLite clamps to 1. Recommended 4-8 for large code corpora.
   * BudgetExhausted from any worker aborts the pool via the worker-
   * pool's D13 bypass — the budget cap stays load-bearing under
   * concurrency.
   */
  workers?: number;
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

/**
 * Voyage publishes voyage-code-3, a code-specialized embedding model that
 * outperforms their general flagships on code retrieval. Per-worktree code
 * brains (Topology 3) are pure source-code, so the recommendation is clean.
 * The nudge surfaces this from `gbrain reindex --code` on dry-run AND
 * execute paths so an agent sees it before spending Anthropic/OpenAI tokens.
 *
 * Allowlist matches against the BARE model name (what getEmbeddingModelName()
 * returns — the gateway strips the provider prefix). Lives in runReindexCode
 * (not the CLI wrapper) because the CLI wrapper's dry-run branch returns
 * before the gate block.
 */
const CODE_TUNED_BARE_MODELS = new Set(['voyage-code-3']);

export type NudgeDecision =
  | { shouldNudge: false }
  | { shouldNudge: true; currentModel: string; recommendedModel: 'voyage:voyage-code-3' };

export function shouldNudgeCodeModel(bareModelName: string | undefined | null): NudgeDecision {
  if (!bareModelName || typeof bareModelName !== 'string') return { shouldNudge: false };
  const trimmed = bareModelName.trim();
  if (!trimmed) return { shouldNudge: false };
  if (CODE_TUNED_BARE_MODELS.has(trimmed.toLowerCase())) return { shouldNudge: false };
  return {
    shouldNudge: true,
    currentModel: trimmed,
    recommendedModel: 'voyage:voyage-code-3',
  };
}

/** Render the nudge to stderr. Pure-stderr by construction so --json stdout stays clean. */
function printCodeModelNudge(decision: Extract<NudgeDecision, { shouldNudge: true }>): void {
  process.stderr.write(
    `[reindex-code] Configured embedding model is \`${decision.currentModel}\`. For pure code retrieval, Voyage's code-tuned \`voyage-code-3\` typically outperforms general-purpose models. Switch:\n` +
      `  gbrain config set embedding_model ${decision.recommendedModel}\n` +
      `  gbrain config set embedding_dimensions 1024\n` +
      `Suppress with GBRAIN_NO_CODE_MODEL_NUDGE=1.\n`,
  );
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

  // Code-model nudge: fire when there's actual work, the operator hasn't opted
  // out, and JSON-mode isn't active. Lives here (not in runReindexCodeCli) so
  // dry-run paths surface it too — the CLI wrapper's dry-run branch returns
  // before its gate block, which is where any UI placed there would be missed.
  if (
    totalPages > 0 &&
    !opts.json &&
    !opts.noEmbed &&
    process.env.GBRAIN_NO_CODE_MODEL_NUDGE !== '1'
  ) {
    const decision = shouldNudgeCodeModel(getEmbeddingModelName());
    if (decision.shouldNudge) printCodeModelNudge(decision);
  }

  if (opts.dryRun) {
    return {
      status: 'dry_run',
      codePages: totalPages,
      reindexed: 0,
      skipped: 0,
      failed: 0,
      totalTokens,
      costUsd,
      model: getEmbeddingModelName(),
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
      model: getEmbeddingModelName(),
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
  let budgetExhausted: BudgetExhausted | null = null;

  // F3: when --max-cost is set, run the body inside withBudgetTracker so
  // every gateway.embed() call inside importCodeFile composes with the cap.
  // On BudgetExhausted, we catch + persist what's been imported so far,
  // then surface the throw as a partial-progress result the caller can
  // re-run. importCodeFile is idempotent (content_hash short-circuit), so
  // a re-run picks up where the cap fired.
  const reindexBody = async (): Promise<void> => {
    try {
      while (true) {
        const batch = await fetchCodePages(engine, opts.sourceId, batchSize, offset);
        if (batch.length === 0) break;

        // v0.41.15.0 (T11): per-batch sliding pool. BudgetExhausted
        // from any worker propagates up via the helper's D13 bypass
        // (not caught here) so the outer catch can record partial
        // progress unchanged.
        const writersResolved = resolveWorkersWithClamp(
          engine,
          opts.workers,
          'reindex-code',
          batch.length,
        );
        await runSlidingPool({
          items: batch,
          workers: writersResolved.workers,
          failureLabel: (row) => row.slug,
          onItem: async (row) => {
            const fm = row.frontmatter ?? {};
            const relPath = typeof fm.file === 'string' ? fm.file : null;
            if (!relPath) {
              failed++;
              failures.push({ slug: row.slug, error: 'missing frontmatter.file' });
              reporter.tick();
              return;
            }
            if (!row.compiled_truth) {
              failed++;
              failures.push({ slug: row.slug, error: 'missing compiled_truth' });
              reporter.tick();
              return;
            }
            try {
              const result = await importCodeFile(engine, relPath, row.compiled_truth, {
                noEmbed: opts.noEmbed,
                force: opts.force,
                sourceId: opts.sourceId,
              });
              if (result.status === 'imported') reindexed++;
              else if (result.status === 'skipped') skipped++;
              else {
                failed++;
                failures.push({ slug: row.slug, error: result.error ?? result.status });
              }
            } catch (e: unknown) {
              // BudgetExhausted bypasses the helper's onError and hard-
              // aborts the pool (D13). All other errors are captured
              // per-page so the rest of the batch completes.
              if (e instanceof BudgetExhausted) throw e;
              failed++;
              failures.push({ slug: row.slug, error: e instanceof Error ? e.message : String(e) });
            }
            reporter.tick();
          },
        });

        offset += batch.length;
        if (batch.length < batchSize) break;
      }
    } finally {
      reporter.finish();
    }
  };

  try {
    if (typeof opts.maxCostUsd === 'number' && opts.maxCostUsd > 0) {
      const tracker = new BudgetTracker({ maxCostUsd: opts.maxCostUsd, label: 'reindex-code' });
      await withBudgetTracker(tracker, reindexBody);
    } else {
      await reindexBody();
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      budgetExhausted = e;
    } else {
      throw e;
    }
  }

  if (budgetExhausted) {
    // Partial-progress result: surfaces what got reindexed before the cap
    // fired. The CLI wrapper translates this into a clear user-facing
    // message + non-zero exit; the library result lets agent callers see
    // what happened without grep'ing stderr.
    return {
      status: 'ok',
      codePages: totalPages,
      reindexed,
      skipped,
      failed,
      totalTokens,
      costUsd: budgetExhausted.spent,
      model: getEmbeddingModelName(),
      failures: [
        { slug: '(budget)', error: budgetExhausted.message },
        ...(failures.length > 0 ? failures : []),
      ],
    };
  }

  return {
    status: 'ok',
    codePages: totalPages,
    reindexed,
    skipped,
    failed,
    totalTokens,
    costUsd,
    model: getEmbeddingModelName(),
    failures: failures.length > 0 ? failures : undefined,
  };
}

/**
 * v0.42.11.0 (#1784) — what to print when the cost gate refuses to spend
 * non-interactively without `--yes`. The REFUSAL (exit 2, no spend) is the
 * guardrail and is correct; the FORMAT is a separate axis. Pre-#1784 this path
 * always emitted a JSON envelope even without `--json`, violating the repo's
 * "human by default" convention. Now: JSON only when `--json` is explicit;
 * otherwise a human refusal on stderr. Pure + exported so it's unit-testable
 * without a brain or a real cost preview.
 */
export interface CostRefusal {
  stdout?: string;
  stderr?: string;
}
export function buildCostRefusal(opts: {
  json: boolean;
  previewMsg: string;
  preview: unknown;
  costUsd: number;
  model: string;
}): CostRefusal {
  if (opts.json) {
    const envelope = serializeError(errorFor({
      class: 'ConfirmationRequired',
      code: 'cost_preview_requires_yes',
      message: opts.previewMsg,
      hint: 'Pass --yes to proceed, or --dry-run to see the preview and exit 0.',
    }));
    return {
      stdout: JSON.stringify({ error: envelope, preview: opts.preview, costUsd: opts.costUsd, model: opts.model }),
    };
  }
  return {
    stderr:
      `${opts.previewMsg}\n` +
      'Refusing to re-embed non-interactively without confirmation. ' +
      'Pass --yes to proceed, or --dry-run for the preview (exit 0).',
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

  // v0.41.15.0 (T11, D9): --workers N for per-batch parallelism.
  let workers: number | undefined;
  const workersIdx = args.indexOf('--workers');
  const concurrencyIdx = args.indexOf('--concurrency');
  const workersValIdx = workersIdx >= 0 ? workersIdx + 1 : (concurrencyIdx >= 0 ? concurrencyIdx + 1 : -1);
  if (workersValIdx > 0 && workersValIdx < args.length) {
    try {
      workers = parseWorkers(args[workersValIdx]);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }

  // F3: --max-cost / --max-cost-usd both accepted for symmetry with brainstorm.
  // v0.42.42.0 (#2139): `off`/`unlimited`/`none` → no runtime cap AND an explicit
  // "cost isn't the constraint" decision that proceeds past the confirmation gate
  // (like --yes). Numeric must be positive; `0`/garbage is rejected.
  let maxCostUsd: number | undefined;
  let maxCostOff = false;
  for (const flag of ['--max-cost', '--max-cost-usd']) {
    const idx = args.indexOf(flag);
    if (idx >= 0) {
      const v = args[idx + 1];
      const t = (v ?? '').trim().toLowerCase();
      if (['off', 'unlimited', 'none'].includes(t)) {
        maxCostUsd = undefined; // no runtime cap (reindex skips the tracker when unset)
        maxCostOff = true;
        break;
      }
      const n = v ? parseFloat(v) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`gbrain reindex --code: ${flag} requires a positive number in USD, or off/unlimited (got ${v ?? '(missing)'})`);
        process.exit(2);
      }
      maxCostUsd = n;
      break;
    }
  }

  if (dryRun) {
    const result = await runReindexCode(engine, { sourceId, dryRun: true, yes, json, force, noEmbed, maxCostUsd, workers });
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
      `est. $${costUsd.toFixed(2)} on ${getEmbeddingModelName()}.`;

    if (preview.totalPages === 0) {
      if (json) {
        console.log(JSON.stringify({ status: 'ok', codePages: 0, reindexed: 0, skipped: 0, failed: 0, totalTokens: 0, costUsd: 0, model: getEmbeddingModelName() }));
      } else {
        console.log('No code pages to reindex.');
      }
      return;
    }

    if (!yes) {
      // v0.42.42.0 (#2139): spend.posture=tokenmax makes the gate informational
      // — print the estimate and proceed (the operator declared cost isn't the
      // constraint). The spend is still ledgered by the runtime BudgetTracker.
      const { resolveSpendPosture } = await import('../core/spend-posture.ts');
      const posture = await resolveSpendPosture(engine);
      // An explicit `--max-cost off` is the same "cost isn't the constraint"
      // signal as spend.posture=tokenmax — proceed past the confirmation gate.
      if (posture === 'tokenmax' || maxCostOff) {
        const gate = maxCostOff ? 'max_cost_off' : 'posture_tokenmax';
        if (json) {
          console.log(JSON.stringify({ status: 'proceeding', gate, codePages: preview.totalPages, totalTokens: preview.totalTokens, costUsd, model: getEmbeddingModelName() }));
        } else {
          console.log(`${previewMsg} ${maxCostOff ? '--max-cost off' : 'spend.posture=tokenmax'}: proceeding (informational). docs: docs/operations/spend-controls.md`);
        }
      } else {
        const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
        if (!isTTY || json) {
          // Guardrail unchanged: refuse + exit 2, no spend. Only the FORMAT splits
          // on --json now (human refusal on stderr otherwise) — #1784.
          const refusal = buildCostRefusal({ json, previewMsg, preview, costUsd, model: getEmbeddingModelName() });
          if (refusal.stdout) console.log(refusal.stdout);
          if (refusal.stderr) console.error(refusal.stderr);
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
  }

  const result = await runReindexCode(engine, { sourceId, yes, json, force, noEmbed, maxCostUsd, workers });
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
