/**
 * `gbrain migrate embeddings --to <provider:model>` (#3390) — the
 * provider-agnostic forward migration off any embedding provider, built for
 * the ZeroEntropy 2026-09-04 sunset but not keyed to it.
 *
 * Also reachable as `gbrain retrieval-upgrade` — the command README.md and
 * doctor.ts have promised since v0.36 but which never had a dispatch branch.
 *
 * Flow (everything heavy is reused, see src/core/embedding-migration.ts):
 *   1. plan     — chunk/char counts via the widened stale predicates,
 *                 cost estimate from embedding-pricing.ts
 *   2. preflight— print estimate; require --yes or interactive confirm
 *                 (non-TTY without --yes refuses with exit 2, mirroring the
 *                 reindex-code cost gate in docs/operations/spend-controls.md)
 *   3. probe    — one live embed against the TARGET provider BEFORE any
 *                 mutation (validates key + model + dims in one shot)
 *   4. apply    — schema transition (dim change), config (DB + file plane),
 *                 #3391 NULL-signature-inclusive invalidation, cache purge
 *   5. re-embed — runEmbedCore --stale --catch-up with single-flight locks,
 *                 pacing (--pace), progress reporting. Resumable: a killed
 *                 run re-runs the SAME command; the NULL-embedding cursor is
 *                 the checkpoint and steps 3-4 no-op on the second pass.
 */

import type { BrainEngine } from '../core/engine.ts';
import { serr, slog } from '../core/console-prefix.ts';
import {
  planEmbeddingMigration,
  applyEmbeddingMigration,
  completeEmbeddingMigration,
  reconcilePageSignatures,
  MIGRATION_STATE_KEY,
  type EmbeddingMigrationPlan,
} from '../core/embedding-migration.ts';
import { formatEnvOverrideWarning } from '../core/retrieval-upgrade-planner.ts';
import { parsePaceArgs, runEmbedCore } from './embed.ts';

export interface MigrateEmbeddingsFlags {
  to?: string;
  dim?: number;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  noEmbed: boolean;
  ignoreEnvOverride: boolean;
  batchSize?: number;
  pace?: ReturnType<typeof parsePaceArgs>;
}

export function parseMigrateEmbeddingsFlags(args: string[]): MigrateEmbeddingsFlags {
  const toIdx = args.indexOf('--to');
  const dimIdx = args.indexOf('--dim');
  const dimRaw = dimIdx >= 0 ? parseInt(args[dimIdx + 1] ?? '', 10) : NaN;
  const bsIdx = args.indexOf('--batch-size');
  const bsRaw = bsIdx >= 0 ? parseInt(args[bsIdx + 1] ?? '', 10) : NaN;
  const batchSize = Number.isFinite(bsRaw) && bsRaw > 0 ? Math.min(10_000, bsRaw) : undefined;
  return {
    to: toIdx >= 0 ? args[toIdx + 1] : undefined,
    dim: Number.isFinite(dimRaw) && dimRaw > 0 ? dimRaw : undefined,
    yes: args.includes('--yes') || args.includes('--non-interactive'),
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    noEmbed: args.includes('--no-embed'),
    ignoreEnvOverride: args.includes('--ignore-env-override'),
    ...(batchSize !== undefined && { batchSize }),
    pace: parsePaceArgs(args),
  };
}

function printHelp(): void {
  process.stdout.write(`Usage: gbrain migrate embeddings --to <provider:model> [flags]

Re-embed the whole brain onto a different embedding provider/model. Handles
dimension changes (schema transition), pages without a recorded embedding
signature (#3391), the query cache, and resume-after-kill. The forward path
off a sunsetting provider.

Flags:
  --to <provider:model>   Target embedding model (e.g. openai:text-embedding-3-small).
  --dim <N>               Target dimensions. Defaults to the provider recipe's
                          declared width; required when the recipe declares none.
  --dry-run               Plan + cost estimate only; change nothing.
  --yes                   Skip the confirm prompt (required non-interactively).
  --json                  Machine-readable envelope on stdout.
  --no-embed              Apply schema + config + invalidation, but skip the
                          re-embed pass (run \`gbrain embed --stale --include-null-signature\`
                          or \`... --background\` yourself).
  --batch-size <N>        Stale-chunk batch size for the re-embed (default 2000).
  --pace[=mode]           DB-contention pacing for the re-embed (off|gentle|balanced|aggressive).
  --ignore-env-override   Proceed even when GBRAIN_EMBEDDING_* env vars would
                          override the target at runtime (you know why).
  --help                  Show this help.

A killed run is resumable: re-run the same command. Already-migrated chunks
are never re-embedded twice.
`);
}

function renderPlan(plan: EmbeddingMigrationPlan): string {
  const lines: string[] = [];
  lines.push('Embedding migration plan');
  lines.push(`  From: ${plan.from_model} (${plan.from_dims}d${plan.column_dims !== null && plan.column_dims !== plan.from_dims ? `; column is actually ${plan.column_dims}d` : ''})`);
  lines.push(`  To:   ${plan.to_model} (${plan.to_dims}d)`);
  if (plan.dim_change) {
    lines.push(`  DESTRUCTIVE: the embedding column is rebuilt at ${plan.to_dims}d, which DELETES`);
    lines.push('          every stored embedding vector in this brain. They are not recoverable —');
    lines.push('          going back to the old provider means paying for a second full re-embed.');
    lines.push('          Until the re-embed finishes, semantic search is degraded to lexical-only.');
    lines.push(`          The query cache and fact embeddings are rebuilt at ${plan.to_dims}d too`);
    lines.push('          (cache refills on next query; facts re-embed on their next write).');
  }
  lines.push(`  Chunks to re-embed: ${plan.chunks_to_embed}${plan.null_signature_chunks > 0 ? ` (includes ${plan.null_signature_chunks} on pages with no recorded embedding signature)` : ''}`);
  lines.push(
    plan.price_known
      ? `  Estimated cost: $${plan.est_cost_usd.toFixed(2)} (${plan.total_chars} chars at the ${plan.to_model} rate)`
      : `  Estimated cost: unknown — no pricing entry for ${plan.to_model}. Check the provider's pricing before proceeding.`,
  );
  if (plan.resuming) {
    lines.push('  Resuming: a prior migration to this target was interrupted; continuing it.');
  }
  if (plan.reranker_warning) {
    lines.push(`  WARNING: ${plan.reranker_warning}`);
  }
  return lines.join('\n');
}

/** Single-keypress y/N confirm on stdin. Injectable for tests. */
async function defaultConfirm(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  const key: string = await new Promise((resolve) => {
    stdin.once('data', (d) => resolve(d.toString()));
  });
  stdin.setRawMode?.(false);
  stdin.pause();
  process.stderr.write('\n');
  return key.trim().toLowerCase().startsWith('y');
}

/**
 * One tiny embed against the TARGET provider, BEFORE any mutation: validates
 * the API key, the model id, and dimension support in a single call, so a bad
 * target fails with the brain untouched instead of after the column is
 * dropped. Shared by the CLI and the `migrate_embeddings` op (the op used to
 * skip it, which let `yes:true` drop the column against a bad key).
 */
export async function probeTargetProvider(
  toModel: string,
  toDims: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { embed } = await import('../core/ai/gateway.ts');
    const vecs = await embed(['gbrain embedding migration probe'], {
      embeddingModel: toModel,
      dimensions: toDims,
    });
    const got = vecs[0]?.length ?? 0;
    if (got !== toDims) {
      return {
        ok: false,
        message: `Target provider returned ${got}-dim vectors, expected ${toDims}. Pass a valid --dim for ${toModel}.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: `Preflight embed against ${toModel} failed — nothing was changed:\n  ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Persist the target model+dims to the FILE plane and reconfigure the
 * in-process gateway. The gateway reads file/env config, not the DB plane —
 * without this the re-embed would silently run against the OLD provider.
 * Shared by the CLI command and the `migrate_embeddings` op handler.
 */
export async function persistEmbeddingFileConfig(
  toModel: string,
  toDims: number,
): Promise<void> {
  const { loadConfig, saveConfig } = await import('../core/config.ts');
  const { configureGateway } = await import('../core/ai/gateway.ts');
  const { buildGatewayConfig } = await import('../core/ai/build-gateway-config.ts');
  const cfg = loadConfig();
  if (!cfg) {
    // REFUSE rather than warn-and-proceed. Without a file plane to write, the
    // switch would not survive this process: the next `gbrain` invocation
    // reads file/env config, sees the OLD provider, and re-embeds the brain
    // back into the old space (paying twice) — or fails outright against a
    // column that is now the new width. Thrown from inside
    // applyEmbeddingMigration's try, so it surfaces as status: 'failed'
    // BEFORE the config/cache steps and the caller exits non-zero.
    throw new Error(
      'No ~/.gbrain/config.json found — refusing to migrate.\n' +
      '  The embed pipeline reads file/env config, so without a file plane this switch\n' +
      '  would not survive the process and the next run would re-embed into the old space.\n' +
      '  Fix: run `gbrain init` (or set GBRAIN_EMBEDDING_MODEL + GBRAIN_EMBEDDING_DIMENSIONS\n' +
      '  in the environment of every gbrain process) and re-run.',
    );
  }
  cfg.embedding_model = toModel;
  cfg.embedding_dimensions = toDims;
  saveConfig(cfg);
  configureGateway(buildGatewayConfig(cfg));
}

export interface RunMigrateEmbeddingsOpts {
  /** Test seams. */
  confirm?: (question: string) => Promise<boolean>;
  isTTY?: boolean;
  exit?: (code: number) => never;
}

export async function runMigrateEmbeddings(
  engine: BrainEngine,
  args: string[],
  opts: RunMigrateEmbeddingsOpts = {},
): Promise<void> {
  // Explicit `never` annotation so TS control-flow analysis treats every
  // exit() call as terminal (required for narrowing after the guard blocks).
  const exit: (code: number) => never = opts.exit ?? ((code: number) => process.exit(code));
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    exit(0);
  }
  const flags = parseMigrateEmbeddingsFlags(args);
  if (!flags.to) {
    serr('Missing --to <provider:model>. Example: gbrain migrate embeddings --to openai:text-embedding-3-small');
    serr('Run with --help for all flags.');
    exit(1);
  }

  // From-state as the gateway resolved it (file/env config + defaults) —
  // the truth for what embeds run under TODAY.
  let fromModel: string | undefined;
  let fromDims: number | undefined;
  try {
    const { getEmbeddingModel, getEmbeddingDimensions } = await import('../core/ai/gateway.ts');
    fromModel = getEmbeddingModel();
    fromDims = getEmbeddingDimensions();
  } catch {
    // Gateway unconfigured — plan falls back to shipped defaults.
  }

  let plan: EmbeddingMigrationPlan;
  try {
    plan = await planEmbeddingMigration(engine, {
      to: flags.to!,
      ...(flags.dim !== undefined && { dim: flags.dim }),
      ...(fromModel !== undefined && { fromModel }),
      ...(fromDims !== undefined && { fromDims }),
    });
  } catch (e) {
    serr(e instanceof Error ? e.message : String(e));
    exit(1);
    return; // unreachable; keeps TS happy for injected exit seams
  }

  if (flags.json) {
    // Human plan goes to stderr so stdout stays JSON-clean.
    serr(renderPlan(plan));
  } else {
    console.log(renderPlan(plan));
  }

  if (plan.chunks_to_embed === 0 && !plan.dim_change && plan.from_model === plan.to_model) {
    if (flags.json) console.log(JSON.stringify({ status: 'skipped_no_work', plan }, null, 2));
    else console.log('Nothing to migrate — brain is already on the target model.');
    exit(0);
  }

  if (flags.dryRun) {
    if (flags.json) console.log(JSON.stringify({ status: 'planned', plan }, null, 2));
    exit(0);
  }

  // ── Consent gate. Unlike the pure cost gates in
  // docs/operations/spend-controls.md, `spend.posture=tokenmax` does NOT
  // bypass this one: posture waives the SPEND ceiling, and this gate also
  // guards a destructive schema rebuild (existing vectors are dropped, and
  // retrieval is degraded until the re-embed finishes). We honor the posture
  // by marking the dollar figure informational, and still ask.
  if (!flags.yes) {
    const { resolveSpendPosture } = await import('../core/spend-posture.ts');
    const posture = await resolveSpendPosture(engine);
    if (posture === 'tokenmax') {
      serr('  [migrate] spend.posture=tokenmax: the cost estimate above is informational.');
      serr('  [migrate] Confirmation is still required — this rebuilds the embedding column (destructive, not just costly).');
    }
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
      serr('Refusing to migrate without confirmation in a non-TTY environment. Re-run with --yes.');
      exit(2);
    }
    const confirm = opts.confirm ?? defaultConfirm;
    const priceNote = plan.price_known ? `~$${plan.est_cost_usd.toFixed(2)}` : 'an UNKNOWN amount';
    const ok = await confirm(`Re-embed ${plan.chunks_to_embed} chunks (${priceNote})?`);
    if (!ok) {
      serr('Aborted. Nothing was changed.');
      exit(1);
    }
  }

  // ── Live probe BEFORE any mutation: one tiny embed against the TARGET
  // provider validates API key, model id, and dimension support in one call.
  const probe = await probeTargetProvider(plan.to_model, plan.to_dims);
  if (!probe.ok) {
    serr(probe.message);
    exit(1);
  }

  // ── Apply: schema + config + invalidation + cache purge.
  const applied = await applyEmbeddingMigration(engine, plan, {
    ignoreEnvOverride: flags.ignoreEnvOverride,
    persistConfig: (toModel, toDims) => persistEmbeddingFileConfig(toModel, toDims),
  });

  if (applied.status === 'refused') {
    if (flags.json) console.log(JSON.stringify(applied, null, 2));
    else serr(formatEnvOverrideWarning(applied.warning));
    exit(1);
  }
  if (applied.status === 'failed') {
    if (flags.json) console.log(JSON.stringify(applied, null, 2));
    else serr(`Migration apply failed: ${applied.reason}`);
    exit(1);
  }

  serr(`  [migrate] schema ${applied.schema_transitioned ? `rebuilt at ${plan.to_dims}d` : 'unchanged'}; ` +
    `${applied.invalidated} chunk(s) invalidated; query cache purged (${applied.cache_cleared} row(s)).`);

  if (flags.noEmbed) {
    const msg = 'Config + schema migrated. Re-embed deferred — run: gbrain embed --stale --catch-up --include-null-signature';
    if (flags.json) console.log(JSON.stringify({ ...applied, status: 'applied_no_embed', plan }, null, 2));
    else console.log(msg);
    exit(0);
  }

  // ── Re-embed. All the machinery (locks, pacing, backoff, progress,
  // signature stamping) is the standard embed pipeline.
  const { createProgress } = await import('../core/progress.ts');
  const { getCliOptions, cliOptsToProgressOptions } = await import('../core/cli-options.ts');
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  let progressStarted = false;
  const embedResult = await runEmbedCore(engine, {
    stale: true,
    catchUp: true,
    singleFlight: true,
    includeNullSignature: true,
    quiet: flags.json,
    ...(flags.batchSize !== undefined && { batchSize: flags.batchSize }),
    ...(flags.pace && { pace: flags.pace }),
    onProgress: (done, total) => {
      if (!progressStarted) {
        progress.start('migrate.reembed', total);
        progressStarted = true;
      }
      progress.tick(1);
    },
  });
  if (progressStarted) progress.finish();

  // Reconcile signatures BEFORE the completion probe: pages straddling a
  // stale-batch boundary are embedded correctly but left unstamped by the
  // embed loop's all-or-nothing stamp rule. Without this the probe would call
  // a fully-migrated brain "incomplete" and the re-run would pay again.
  const reconciled = await reconcilePageSignatures(engine, plan);
  if (reconciled > 0) {
    serr(`  [migrate] reconciled the embedding signature on ${reconciled} fully-embedded page(s) (batch-boundary pages).`);
  }

  const remaining = await engine.countStaleChunks({
    signature: `${plan.to_model}:${plan.to_dims}`,
    includeNullSignature: true,
  });

  if (remaining === 0) {
    await completeEmbeddingMigration(engine, plan);
    if (flags.json) {
      console.log(JSON.stringify({ status: 'completed', plan, embedded: embedResult.embedded, remaining: 0 }, null, 2));
    } else {
      slog(`Migration complete: ${embedResult.embedded} chunk(s) embedded on ${plan.to_model} (${plan.to_dims}d).`);
      if (plan.reranker_warning) serr(`  [migrate] reminder: ${plan.reranker_warning}`);
    }
    exit(0);
  } else {
    if (flags.json) {
      console.log(JSON.stringify({ status: 'incomplete', plan, embedded: embedResult.embedded, remaining }, null, 2));
    } else {
      serr(`Migration incomplete: ${remaining} chunk(s) still stale (embed failures or an interrupted run).`);
      serr('Re-run the same command to resume — completed chunks are never re-embedded.');
    }
    exit(1);
  }
}

/** Re-export for the op handler + tests. */
export { MIGRATION_STATE_KEY };
