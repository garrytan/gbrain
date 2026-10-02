/**
 * Embedding provider health: live provider probe, alternative providers, the embedding column registry, env override and migration state.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { hnswIndexExpected, hnswMaxDimsForType } from '../../../core/vector-index.ts';
import { checkEmbeddingEnvOverride, checkEmbeddingMigrationState } from './search-eval.ts';
import type { GBrainConfig } from '../../../core/config.ts';
import { DEFAULT_EMBEDDING_MODEL } from '../../../core/ai/defaults.ts';
import { providerKeyShadows, providerKeySource } from '../../../core/ai/provider-env.ts';
import { credentialEnvName, keyShadowWarning } from '../../../core/ai/key-warnings.ts';
import { getRecipe } from '../../../core/ai/recipes/index.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runEmbeddingProvider(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 8b. Embedding provider eval — live smoke test of the configured provider.
  //     Verifies: correct model, API key works, dimensions match config, DB column matches.
  progress.heartbeat('embedding_provider');
  try {
    const {
      getEmbeddingModel,
      getEmbeddingDimensions,
      embedOne,
      isAvailable,
    } = await import('../../../core/ai/gateway.ts');

    const configuredModel = getEmbeddingModel();
    const configuredDims = getEmbeddingDimensions();
    const available = isAvailable('embedding');

    // v0.37 (T9, codex #7 nuance): catch the v0.36 silent-default case where
    // config has no embedding_model but the schema column exists at a dim
    // that doesn't match the gateway's resolved default. Empty-brain vs
    // non-empty-brain branching determines the repair hint:
    //   - empty brain (no embedded chunks) → `gbrain init --force --embedding-model …`
    //   - non-empty brain → `gbrain migrate embeddings --to … --dim …` (#3390)
    // The bug-reporter's `rm -rf ~/.gbrain` recovery is never the right answer.
    let surfacedUnconfiguredDrift = false;
    try {
      const { loadConfig } = await import('../../../core/config.ts');
      const cfg = loadConfig();
      const fileEmbeddingSet = !!cfg?.embedding_model;
      const deferredSetup = cfg?.embedding_disabled === true;
      if (!fileEmbeddingSet && !deferredSetup) {
        // Read column dim + chunk count
        const { readContentChunksEmbeddingDim } = await import('../../../core/embedding-dim-check.ts');
        const colDim = await readContentChunksEmbeddingDim(engine);
        if (colDim.exists && colDim.dims !== null && colDim.dims !== configuredDims) {
          // Determine if the brain has any content — drift is only a real
          // user-facing problem once the user has imported anything. A
          // pristine brain (0 total chunks) is still in fresh-install state;
          // first import will hit the loud preflight before any column
          // write, so doctor doesn't need to pre-warn.
          let totalChunks = 0;
          let embeddedCount = 0;
          try {
            const rows = await engine.executeRaw<{ total: number | string; embedded: number | string }>(
              `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded FROM content_chunks`,
            );
            totalChunks = Number(rows?.[0]?.total ?? 0);
            embeddedCount = Number(rows?.[0]?.embedded ?? 0);
          } catch { /* table may be missing or fresh; treat as empty */ }

          if (totalChunks > 0) {
            const fix = `Existing brain (${totalChunks} chunks, ${embeddedCount} embedded). Keep a verified database backup and preview the brain-wide migration:\n        gbrain migrate embeddings --to ${configuredModel} --dim ${configuredDims} --dry-run\n      After reviewing the plan, replace --dry-run with --yes --max-cost-usd <approved-total>. Missing vectors do not mean the brain is empty. See docs/guides/embedding-migration.md#recovery.`;

            checks.push({
              name: 'embedding_provider',
              status: 'warn',
              message:
                `Schema column is vector(${colDim.dims}) but gateway default resolves to ${configuredModel} (${configuredDims}d). ` +
                `Persist your provider choice with \`gbrain config set embedding_model ${configuredModel}\` AND fix the schema:\n      ${fix}`,
            });
            surfacedUnconfiguredDrift = true;
          }
        }
      }
    } catch {
      // loadConfig may throw on a malformed config; let the existing
      // available/probe branch surface the issue.
    }

    if (surfacedUnconfiguredDrift) {
      // Bail out — the warn above is more actionable than the live probe.
    } else if (!available) {
      // Per v0.28.5 plan P1: silently skipped when no API key is configured.
      // Doctor must stay green on CI / local-only / offline environments where
      // a full provider probe isn't possible. The skipped status is still
      // visible in --json output so operators can see it ran.
      checks.push({
        name: 'embedding_provider',
        status: 'ok',
        message: `Skipped (no provider credentials). Model: ${configuredModel}.`,
      });
    } else {
      // Live embed test
      const start = Date.now();
      // Doctor is itself the provider-health circuit breaker. A permanent
      // billing/auth failure must be sampled once, not multiplied by the AI
      // SDK's default retries (which can add ~90s to every health check).
      const vec = await embedOne('gbrain doctor embedding smoke test', { maxRetries: 0 });
      const ms = Date.now() - start;
      const actualDims = vec.length;

      const issues: string[] = [];

      // Check dimensions match config
      if (actualDims !== configuredDims) {
        issues.push(`Dimension mismatch: provider returned ${actualDims} but config expects ${configuredDims}`);
      }

      // Check DB column dimensions match (engine-portable; works on both
      // Postgres and PGLite via the shared dim-check helper added in v0.28.5).
      try {
        const { readContentChunksEmbeddingDim } = await import('../../../core/embedding-dim-check.ts');
        const colDim = await readContentChunksEmbeddingDim(engine);
        if (colDim.exists && colDim.dims !== null && colDim.dims !== actualDims) {
          issues.push(`DB dimension mismatch: column is vector(${colDim.dims}) but provider returns ${actualDims}-dim. See docs/embedding-migrations.md for a verified backup, migration preview and explicitly authorized repair.`);
        }
      } catch { /* column or table missing — fresh brain, fine */ }

      if (issues.length > 0) {
        checks.push({
          name: 'embedding_provider',
          status: 'warn',
          message: `${configuredModel} responds (${ms}ms, ${actualDims} dims) but: ${issues.join('; ')}`,
        });
      } else {
        checks.push({
          name: 'embedding_provider',
          status: 'ok',
          message: `${configuredModel} ✓ ${ms}ms, ${actualDims} dims, DB aligned`,
        });
      }
    }
  } catch (e: any) {
    // Per v0.28.5 plan P1: non-fatal on network failure. The probe surfaces
    // the issue but doesn't fail doctor — common cases (rate limit, transient
    // 5xx, DNS blip, expired key) shouldn't take down a CI run.
    checks.push({
      name: 'embedding_provider',
      status: 'warn',
      message: `Embedding provider probe failed: ${e.message?.slice(0, 200) ?? e}`,
    });
  }
  return checks;
}

export const embeddingProviderEntry: DoctorEntry = {
  name: 'embedding_provider',
  emits: ['embedding_provider'],
  run: runEmbeddingProvider,
};

async function runAlternativeProviders(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const checks: Check[] = [];

  // 8c. Alternative provider advisory (v0.32 D11=C / Codex finding #2 wire-through).
  // Walks listRecipes() and surfaces any recipe whose required env vars are ALL
  // set in the process env but is not the currently configured provider. Helps
  // users discover that, e.g., OPENAI_API_KEY=x DASHSCOPE_API_KEY=y means they
  // have a Chinese-region alternative ready to go without setup.
  progress.heartbeat('alternative_providers');
  try {
    const { listRecipes } = await import('../../../core/ai/recipes/index.ts');
    const { getEmbeddingModel } = await import('../../../core/ai/gateway.ts');
    const configuredId = (getEmbeddingModel() || '').split(':')[0];
    const alternatives: string[] = [];
    for (const r of listRecipes()) {
      if (r.id === configuredId) continue;
      const required = r.auth_env?.required ?? [];
      // Skip recipes with no required env (they're "always available" — not a
      // useful signal) and recipes that require env we don't have.
      if (required.length === 0) continue;
      const allPresent = required.every(k => !!process.env[k]);
      if (!allPresent) continue;
      // Skip recipes without an embedding touchpoint (chat-only — not an
      // embedding alternative).
      if (!r.touchpoints.embedding) continue;
      alternatives.push(r.id);
    }
    if (alternatives.length > 0) {
      checks.push({
        name: 'alternative_providers',
        status: 'ok',
        message: `Detected ${alternatives.length} alternative embedding provider${alternatives.length > 1 ? 's' : ''} ready to use: ${alternatives.join(', ')}. Run \`gbrain providers list\` to switch.`,
      });
    }
  } catch { /* listRecipes / gateway not available — silent */ }
  return checks;
}

export const alternativeProvidersEntry: DoctorEntry = {
  name: 'alternative_providers',
  emits: ['alternative_providers'],
  run: runAlternativeProviders,
};

async function runEmbeddingQueryPrefix(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  // #5691 / #3783: suggest (never apply) the query instruction a model family
  // documents. Instruction-style models retrieve measurably worse without it.
  ctx.progress.heartbeat('embedding_query_prefix');
  try {
    const { getEmbeddingModel } = await import('../../../core/ai/gateway.ts');
    const { loadEmbeddingQueryPrefix, suggestedQueryPrefix, shellQuoteConfigValue } = await import('../../../core/search/query-prefix.ts');
    const model = getEmbeddingModel() || '';
    const suggestion = suggestedQueryPrefix(model);
    if (suggestion && !(await loadEmbeddingQueryPrefix(engine))) {
      const command = `gbrain config set embedding_query_prefix ${shellQuoteConfigValue(suggestion.value)}`;
      checks.push({
        name: 'embedding_query_prefix',
        status: 'warn',
        message: `Embedding model ${model} is a ${suggestion.family} model, whose model card asks for a query instruction; `
          + `none is set, so query embeddings miss it. Set the documented value: ${command} . `
          + 'It applies to query embeddings only; stored document vectors are not re-embedded. '
          + 'It takes effect on the next CLI or MCP query, without restarting a running server. '
          + 'Remove it with: gbrain config unset embedding_query_prefix . See docs/guides/search-modes.md#query-instruction-prefix.',
        details: { model, family: suggestion.family, value: suggestion.value, command },
      });
    }
  } catch { /* gateway not configured — no advisory */ }
  return checks;
}

export const embeddingQueryPrefixEntry: DoctorEntry = {
  name: 'embedding_query_prefix',
  emits: ['embedding_query_prefix'],
  run: runEmbeddingQueryPrefix,
};

async function runEmbeddingColumnRegistry(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 8c. Embedding column registry (v0.36 — D5 + D13 + D14).
  //     Validates every column in the merged registry against the real DB
  //     shape: (a) column exists, (b) declared type+dims match actual
  //     format_type(atttypid, atttypmod), (c) HNSW index present on
  //     Postgres, (d) the ACTIVE default column has >= 90% coverage.
  //
  //     Batch probes (D5) so the registry can grow without N+1 round-trips:
  //     one format_type query, one pg_indexes query, one coverage-per-active
  //     column query.
  progress.heartbeat('embedding_column_registry');
  try {
    const { getEmbeddingColumnRegistry, resolveEmbeddingColumn, quoteIdentifier } =
      await import('../../../core/search/embedding-column.ts');
    const { loadConfig: _loadConfig } = await import('../../../core/config.ts');
    const fileCfg = _loadConfig();
    const mergedCfg = fileCfg ? await (await import('../../../core/config.ts')).loadConfigWithEngine(engine, fileCfg).catch(() => fileCfg) : null;
    if (!mergedCfg) {
      checks.push({
        name: 'embedding_column_registry',
        status: 'ok',
        message: 'No brain config loaded — skipped',
      });
    } else {
      const registry = getEmbeddingColumnRegistry(mergedCfg);
      const declaredColumns = Object.keys(registry).filter(name => name !== 'embedding' || !fileCfg?.embedding_disabled || !!mergedCfg.embedding_columns?.embedding);
      const activeCol = resolveEmbeddingColumn(undefined, mergedCfg).name;

      // D13 — batch format_type probe via pg_attribute. udt_name only
      // returns 'vector' vs 'halfvec'; format_type(atttypid, atttypmod)
      // returns 'vector(1024)' / 'halfvec(2560)' so dim drift surfaces.
      const formatRows = await engine.executeRaw<{ attname: string; formatted: string }>(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS formatted
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'content_chunks'
            AND a.attname = ANY($1::text[])
            AND NOT a.attisdropped`,
        [declaredColumns],
      );
      const actualByName = new Map<string, string>();
      for (const r of formatRows) actualByName.set(r.attname, r.formatted);

      // D5 — batch index probe (Postgres only; PGLite indexing is implicit
      // and the partial-index pattern doesn't surface in pg_indexes the
      // same way). Reports informational, not blocking — search still
      // works without an HNSW index, just slow.
      const haveIndex = new Map<string, boolean>();
      if (engine.kind === 'postgres') {
        const indexRows = await engine.executeRaw<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes
            WHERE tablename = 'content_chunks'
              AND schemaname = 'public'`,
        );
        for (const col of declaredColumns) {
          const found = indexRows.some(r => /USING\s+hnsw/i.test(r.indexdef) && r.indexdef.includes(`(${col} `));
          haveIndex.set(col, found);
        }
      }

      // Per-column health rollup.
      const issues: string[] = [];
      const okColumns: string[] = [];
      for (const colName of declaredColumns) {
        const entry = registry[colName];
        const actual = actualByName.get(colName);
        if (!actual) {
          issues.push(`${colName}: declared but column does NOT exist in content_chunks`);
          continue;
        }
        // Expected format: `vector(N)` or `halfvec(N)`.
        const m = actual.match(/^(vector|halfvec)\((\d+)\)/i);
        const actualType = m ? m[1].toLowerCase() : actual;
        const actualDims = m ? parseInt(m[2], 10) : null;
        if (actualType !== entry.type) {
          issues.push(
            `${colName}: declared type=${entry.type} but actual is ${actual}. ` +
              `Fix: gbrain config set embedding_columns '<JSON>' OR ` +
              `ALTER TABLE content_chunks ALTER COLUMN ${colName} TYPE ${entry.type}(${entry.dimensions});`,
          );
          continue;
        }
        if (actualDims !== null && actualDims !== entry.dimensions) {
          issues.push(
            `${colName}: declared dims=${entry.dimensions} but actual is ${actual}. ` +
              `Fix one side: update config OR ` +
              `ALTER TABLE content_chunks ALTER COLUMN ${colName} TYPE ${entry.type}(${entry.dimensions});`,
          );
          continue;
        }
        if (engine.kind === 'postgres' && haveIndex.get(colName) === false) {
          if (!hnswIndexExpected(entry.type, entry.dimensions)) {
            okColumns.push(
              `${colName} (exact scan: ${entry.type}(${entry.dimensions}) exceeds HNSW cap ${hnswMaxDimsForType(entry.type)})`,
            );
            continue;
          }
          issues.push(
            `${colName}: no HNSW index. Search works but uses sequential scan. ` +
              `Fix: CREATE INDEX IF NOT EXISTS idx_chunks_${colName} ON content_chunks USING hnsw (${quoteIdentifier(colName)} ${entry.type}_cosine_ops);`,
          );
          continue;
        }
        okColumns.push(colName);
      }

      // D14 — coverage gate on the ACTIVE default column. Catches the
      // "user switched to a 5%-populated column" silent-degradation case.
      let coverageWarn: string | null = null;
      if (activeCol && actualByName.has(activeCol)) {
        // Codex /ship #5: pull `total` alongside `pct` so a fresh brain
        // (0 chunks → NULLIF makes pct NULL → coalesces to 0) doesn't
        // false-warn "Active column 'embedding' is 0.0% populated".
        const covRows = await engine.executeRaw<{ pct: number; total: number }>(
          `SELECT (
             COUNT(*) FILTER (WHERE ${quoteIdentifier(activeCol)} IS NOT NULL)::float
             / NULLIF(COUNT(*), 0) * 100
           )::float AS pct,
           COUNT(*)::int AS total
           FROM content_chunks`,
        );
        const pct = covRows[0]?.pct ?? 0;
        const total = covRows[0]?.total ?? 0;
        // Only warn when there's a real coverage gap. Empty brain (0 chunks)
        // is a normal state for new installs — skip the gate entirely.
        if (total > 0 && pct < 90) {
          // NOTE: there is NO per-column embed flag (write-side custom-column
          // support is a filed follow-up) — the old hint prescribed one.
          coverageWarn =
            `Active column '${activeCol}' is ${pct.toFixed(1)}% populated. ` +
            `Search quality silently degraded on un-embedded chunks. ` +
            `Fix: gbrain config set search_embedding_column embedding (read the default column), ` +
            `then gbrain embed --stale; per-column write-side backfill is a filed follow-up (TODOS.md)`;
        }
      }

      if (issues.length === 0 && !coverageWarn) {
        const indexNote = engine.kind === 'postgres' ? ' (all indexed)' : '';
        checks.push({
          name: 'embedding_column_registry',
          status: 'ok',
          message: `Registry healthy: ${okColumns.length} columns (${okColumns.join(', ')})${indexNote}; ${fileCfg?.embedding_disabled && activeCol === 'embedding' ? 'primary embeddings disabled' : `active='${activeCol}'`}`,
        });
      } else {
        const allMessages = [
          ...issues,
          ...(coverageWarn ? [coverageWarn] : []),
        ];
        checks.push({
          name: 'embedding_column_registry',
          status: 'warn',
          message: allMessages.join(' | '),
        });
      }
    }
  } catch (err) {
    // Pre-config brains, registry-validation throws, etc. Surfaces the
    // error message but doesn't fail the doctor run.
    checks.push({
      name: 'embedding_column_registry',
      status: 'warn',
      message: `Could not check embedding column registry: ${(err as Error).message}`,
    });
  }
  return checks;
}

export const embeddingColumnRegistryEntry: DoctorEntry = {
  name: 'embedding_column_registry',
  emits: ['embedding_column_registry'],
  run: runEmbeddingColumnRegistry,
};

async function runEmbeddingEnvOverride(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  progress.heartbeat('embedding_env_override');
  checks.push(await checkEmbeddingEnvOverride(engine));

  // Surface the migration state marker (previously write-only): a live
  // marker = mid-migration brain, with the exact resume + status commands.
  checks.push(await checkEmbeddingMigrationState(engine));
  return checks;
}

export const embeddingEnvOverrideEntry: DoctorEntry = {
  name: 'embedding_env_override',
  emits: ['embedding_env_override', 'embedding_migration_state'],
  run: runEmbeddingEnvOverride,
};

/**
 * Doctor `embedding_key_source` (#5137, DX-O8): which provider keys come from
 * the environment and override a different config-plane key, and where the
 * embedding key in effect comes from. Names only, never key values. It sees
 * only the environment `gbrain doctor` runs in, not a daemon's. Engine-free
 * filesystem-lane entry (also under `--fast`).
 */
const KEY_SOURCE_DOCS = 'docs/guides/repair.md#embedding-key-source';
const KEY_SOURCE_SCOPE = 'This check sees only the environment `gbrain doctor` runs in; a daemon (gbrain serve, autopilot) has its own, and reports a mismatch in its log with a startup warning or embedding_auth_failed.';

export function embeddingKeySource(fileCfg: GBrainConfig | null, env: Record<string, string | undefined>, file: string): Pick<Check, 'status' | 'message' | 'details'> {
  const shadows = providerKeyShadows(fileCfg, env);
  const model = env.GBRAIN_EMBEDDING_MODEL || fileCfg?.embedding_model || DEFAULT_EMBEDDING_MODEL;
  const variable = credentialEnvName(getRecipe(model.split(':')[0] ?? '')?.auth_env);
  const source = variable ? providerKeySource(fileCfg, env, variable) : null;
  const inEffect = !source ? `The embedding model ${model} reads no API key.`
    : source.kind === 'env' ? `The embedding key in effect is ${source.variable} from this environment.`
      : source.kind === 'config' ? `The embedding key in effect is ${source.config_key} in ${file}.`
        : `No embedding key is set here (${source.variable}${source.config_key ? ` or ${source.config_key}` : ''}).`;
  const details = { shadows: shadows.map(shadow => ({ ...shadow, in_effect: 'env' as const })),
    embedding_model: model, embedding_key: source ? { kind: source.kind, variable: source.variable, config_key: source.config_key ?? null } : null, docs: KEY_SOURCE_DOCS };
  if (!shadows.length) return { status: 'ok', message: `${inEffect} No environment variable overrides a different config-plane provider key. ${KEY_SOURCE_SCOPE}`, details };
  return {
    status: 'warn',
    message: `${inEffect} ${shadows.map(shadow => keyShadowWarning(shadow, file).replace('[gbrain] warning: ', '')).join(' ')} ${KEY_SOURCE_SCOPE}`,
    details,
  };
}

async function runEmbeddingKeySource(_ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { configPath, loadConfigFileOnly } = await import('../../../core/config.ts');
  let file = 'config.json';
  try { file = configPath(); } catch { /* invalid GBRAIN_HOME: doctor reports it elsewhere */ }
  checks.push({ name: 'embedding_key_source', ...embeddingKeySource(loadConfigFileOnly(), process.env, file) });
  return checks;
}

export const embeddingKeySourceEntry: DoctorEntry = {
  name: 'embedding_key_source',
  emits: ['embedding_key_source'],
  run: runEmbeddingKeySource,
};
