import type { BrainEngine } from '../core/engine.ts';
import {
  isFileBackedModelConfigKey,
  listFileConfigKeys,
  loadConfig,
  loadConfigFileOnly,
  loadConfigWithEngine,
  readFileConfigValue,
  saveConfig,
  unsetFileConfigValue,
  writeFileConfigValue,
} from '../core/config.ts';
import {
  getEmbeddingColumnRegistry,
  validateColumnKey,
  validateColumnConfig,
  quoteIdentifier,
  EmbeddingColumnNotRegisteredError,
  EmbeddingColumnConfigError,
} from '../core/search/embedding-column.ts';

const MEMORY_DUAL_PLANE_LEAVES = ['auto_writeback', 'auto_writeback_transient_ttl'] as const;
const MEMORY_DUAL_PLANE_KEYS: ReadonlySet<string> = new Set(
  MEMORY_DUAL_PLANE_LEAVES.map((leaf) => `memory.${leaf}`),
);

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

// v0.36.x #892: sensitive config-key allowlist. The `show` path used a
// loose `.includes('key')` check that also redacts (works); the `set` path
// previously printed the raw value to stderr, leaking API keys via shell
// history + scrollback. This helper is the single source of truth so the
// two surfaces can't drift again. Match on word-segments to avoid
// false-positives (e.g. `monkey` doesn't match `key`).
export function isSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === 'provider_touchpoint_api_keys' || lower.startsWith('provider_touchpoint_api_keys.')) return true;
  // Word-boundary matches: foo_key, foo.key, key_foo, key, api_key, ...
  return /(^|[._-])(key|secret|token|password|pwd|passwd|auth)([._-]|$)/.test(lower);
}

export function redactConfigValue(key: string, value: string): string {
  if (value.includes('postgresql://')) return redactUrl(value);
  if (isSensitiveConfigKey(key)) return '***';
  return value;
}

export async function switchEmbeddingModel(
  engine: BrainEngine,
  nextModel: string,
  opts: { expectedDimensions?: number } = {},
): Promise<void> {
  const current = loadConfigFileOnly();
  if (!current) throw new Error('No config found. Run: pmbrain init');
  const previousModel = current.embedding_model?.trim();
  if (previousModel === nextModel) {
    await engine.unsetConfig('embedding_model');
    await engine.unsetConfig('embedding_dimensions');
    const configuredDimensions = current.embedding_dimensions ?? 0;
    if (configuredDimensions > 0) {
      const { alignEmbeddingDimension } = await import('../core/embedding-dimension-alignment.ts');
      await alignEmbeddingDimension(engine, configuredDimensions, { targetModel: nextModel });
    }
    const stale = await engine.countStaleChunks();
    if (stale === 0) {
      console.log(`Embedding model is already ${nextModel}; no re-embedding needed.`);
      return;
    }
    const { runEmbedCore } = await import('./embed.ts');
    const result = await runEmbedCore(engine, { stale: true, catchUp: true });
    console.log(
      `Embedding migration resumed for ${nextModel}: ${result.embedded} chunks updated, ` +
      `${result.total_chunks - result.embedded} still pending.`,
    );
    return;
  }

  const { recommendedEmbeddingDimension, alignEmbeddingDimension } = await import('../core/embedding-dimension-alignment.ts');
  const { configureGateway, detectEmbeddingDimensions } = await import('../core/ai/gateway.ts');
  const { buildGatewayConfig } = await import('../core/ai/gateway-config.ts');
  let provisionalDimensions = current.embedding_dimensions ?? 1536;
  try {
    provisionalDimensions = recommendedEmbeddingDimension(nextModel);
  } catch {
    // User-provided OpenAI-compatible model ids have no catalog dimension;
    // the live one-vector probe below is the source of truth.
  }
  const candidate = {
    ...current,
    embedding_model: nextModel,
    embedding_dimensions: provisionalDimensions,
  };
  delete candidate.embedding_disabled;

  configureGateway(buildGatewayConfig(candidate));
  let detectedDimensions: number;
  try {
    detectedDimensions = await detectEmbeddingDimensions(nextModel, provisionalDimensions);
  } catch (error) {
    configureGateway(buildGatewayConfig(current));
    throw new Error(
      `Embedding model ${nextModel} validation failed; config and existing vectors were not changed. ` +
      (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  candidate.embedding_dimensions = detectedDimensions;
  if (opts.expectedDimensions !== undefined && detectedDimensions !== opts.expectedDimensions) {
    configureGateway(buildGatewayConfig(current));
    throw new Error(
      `Embedding model ${nextModel} returned ${detectedDimensions} dimensions, `
      + `but --dim requested ${opts.expectedDimensions}. No configuration or vectors were changed.`,
    );
  }

  saveConfig(candidate);
  let committed = false;
  try {
    const alignment = await alignEmbeddingDimension(engine, detectedDimensions, {
      forceReembed: Boolean(previousModel),
      targetModel: nextModel,
    });
    committed = alignment.status === 'aligned' || alignment.status === 'invalidated';
    console.log(
      `Embedding model set to ${nextModel} (${detectedDimensions} dimensions); ` +
      `${alignment.cleared_embeddings} derived vectors invalidated. Source content preserved.`,
    );
    if (committed) {
      await engine.unsetConfig('embedding_model');
      await engine.unsetConfig('embedding_dimensions');
      const { runEmbedCore } = await import('./embed.ts');
      const result = await runEmbedCore(engine, { stale: true, catchUp: true });
      console.log(
        `Re-embedding finished: ${result.embedded} chunks updated, ` +
        `${result.total_chunks - result.embedded} still pending.`,
      );
    }
  } catch (error) {
    if (!committed) {
      saveConfig(current);
      configureGateway(buildGatewayConfig(current));
    }
    throw error;
  }
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];

  if (!action || action === '--help' || action === '-h') {
    console.log('Usage: pmbrain config [show|get|set|unset] <key> [value]');
    console.log('       pmbrain config unset --pattern <prefix>');
    return;
  }

  if (action === 'show') {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: gbrain init');
      process.exit(1);
    }
    console.log('PMBrain config:');
    for (const [k, v] of Object.entries(config)) {
      const display = isSensitiveConfigKey(k) ? '***' : typeof v === 'string' ? redactConfigValue(k, v) : v;
      console.log(`  ${k}: ${display}`);
    }
    return;
  }

  // v0.32.3 [CDX-7+8]: `unset` is required before `gbrain search modes
  // --reset` can implement its contract. Two shapes:
  //   gbrain config unset <key>             — single-key delete
  //   gbrain config unset --pattern <pfx>   — prefix-bulk delete
  if (action === 'unset') {
    const flagIdx = args.indexOf('--pattern');
    if (flagIdx !== -1) {
      const prefix = args[flagIdx + 1];
      if (!prefix || prefix.length === 0) {
        console.error('Usage: pmbrain config unset --pattern <prefix>');
        process.exit(1);
      }
      const keys = await engine.listConfigKeys(prefix);
      if('memory.auto_writeback'.startsWith(prefix)){
        const {setWritebackMode}=await import('../core/facts/writeback-set.ts');
        await setWritebackMode(engine,'off');
      }
      const fileConfig = loadConfigFileOnly();
      const fileKeys = listFileConfigKeys(fileConfig).filter(
        candidate => candidate.startsWith(prefix) && (isFileBackedModelConfigKey(candidate)||MEMORY_DUAL_PLANE_KEYS.has(candidate)),
      );
      const allKeys = [...new Set([...fileKeys, ...keys])];
      if (allKeys.length === 0) {
        console.log(`No keys match prefix "${prefix}".`);
        return;
      }
      let deleted = 0;
      if (fileConfig) {
        for (const fileKey of fileKeys) {
          if (unsetFileConfigValue(fileConfig, fileKey)) deleted += 1;
        }
        if (fileKeys.length > 0) saveConfig(fileConfig);
      }
      for (const k of keys) {
        const n = await engine.unsetConfig(k);
        if (n > 0) deleted += n;
      }
      console.log(`Unset ${deleted} key(s) matching "${prefix}":`);
      for (const k of allKeys) console.log(`  - ${k}`);
      return;
    }

    const key = args[1];
    if (!key) {
      console.error('Usage: pmbrain config unset <key> | --pattern <prefix>');
      process.exit(1);
    }
    if (key === 'integrations.memorable.enabled') {
      const hb = await import('../core/context/hook-heartbeat.ts');
      const cfg = loadConfigFileOnly();
      const memorable = cfg?.integrations?.memorable as Record<string, unknown> | undefined;
      await hb.clearMemorableConsent();
      if (cfg && memorable && 'enabled' in memorable) {
        delete memorable.enabled;
        saveConfig(cfg);
        console.log(`Unset ${key} (file plane) — disclosure consent revoked`);
      } else {
        console.error(`Config key not found: ${key} (disclosure consent revoked regardless)`);
        process.exit(1);
      }
      return;
    }
    let removed = false;
    if(key==='memory.auto_writeback'){
      const {setWritebackMode}=await import('../core/facts/writeback-set.ts');
      await setWritebackMode(engine,'off');
    }
    if (isFileBackedModelConfigKey(key) || MEMORY_DUAL_PLANE_KEYS.has(key)) {
      const fileConfig = loadConfigFileOnly();
      if (fileConfig && unsetFileConfigValue(fileConfig, key)) {
        saveConfig(fileConfig);
        removed = true;
      }
    }
    const n = await engine.unsetConfig(key);
    if (n > 0 || removed) {
      console.log(`Unset ${key}`);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
    return;
  }

  const key = args[1];
  const value = args[2];

  if (action === 'get' && key) {
    const fileValue = isFileBackedModelConfigKey(key) || key === 'integrations.memorable.enabled'
      ? readFileConfigValue(loadConfigFileOnly(), key)
      : undefined;
    const val = fileValue !== undefined
      ? typeof fileValue === 'string' ? fileValue : JSON.stringify(fileValue)
      : await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    if (key === 'embedding_model') {
      await switchEmbeddingModel(engine, value.trim());
      return;
    }
    // v0.37.11.0 fix wave (Lane C.2 + CDX2-13): refuse writes to schema-sizing
    // fields unconditionally. These fields size the `content_chunks.embedding`
    // column at init time and are file-plane canonical. embedding_model is
    // handled above by the validated switch path; a raw dimension-only write
    // would split config from the schema.
    //
    // No `--force` escape hatch (CDX2-13): keeping a known-no-op DB-only
    // write preserves the split-brain footgun the wave exists to close.
    // PMBrain protects DB-only knowledge and never recommends a whole-database
    // wipe. PGLite switches require a verified cold backup followed by a
    // derived-data-only rebuild; raw dimension writes remain forbidden.
    if (key === 'embedding_dimensions') {
      const isPgliteEngine = (await import('../core/config.ts')).loadConfig()?.engine === 'pglite';
      console.error(`[config] ${key} is a file-plane field that sizes the schema.`);
      console.error(`[config] Setting it in the DB has no effect on the embed pipeline (silent no-op).`);
      console.error(`[config]`);
      if (isPgliteEngine) {
        console.error(`[config] Direct dimension-only changes are disabled for PGLite.`);
        console.error(`[config] Select the embedding model in Desktop (recommended), or first create a verified backup:`);
        console.error(`[config]   pmbrain pglite-backup create --target-version manual`);
        console.error(`[config] PMBrain then rebuilds only derived vectors/caches; it never wipes the whole database.`);
      } else {
        console.error(`[config] To switch embedding models/dimensions on Postgres, see:`);
        console.error(`[config]   docs/embedding-migrations.md`);
      }
      console.error(`[config]`);
      console.error(`[config] No --force escape: silently writing a no-op preserves the bug class this rejection closes.`);
      process.exit(1);
    }

    // v0.37.10.0 (D6): strict unknown-key rejection with --force escape hatch.
    // Catches the silent-no-op class for namespaced typos like `embedding.provider`,
    // `embedding.model`, `embedding.dimensions` — Levenshtein suggests the canonical
    // key (`embedding_model`, `embedding_dimensions`) when one is within edit
    // distance ≤ 3, after which the v0.37.11.0 hard-refuse above kicks in for those
    // specific schema-sizing fields.
    const forceFlag = args.includes('--force');
    if (!forceFlag) {
      const { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } = await import('../core/config.ts');
      const isKnown = KNOWN_CONFIG_KEYS.includes(key);
      const matchesPrefix = KNOWN_CONFIG_KEY_PREFIXES.some(p => key.startsWith(p));
      if (!isKnown && !matchesPrefix) {
        const { suggestNearest } = await import('../core/levenshtein.ts');
        const suggestion = suggestNearest(key, KNOWN_CONFIG_KEYS, 3);
        console.error(`[config] Unknown config key "${key}".`);
        if (suggestion) {
          console.error(`[config] Did you mean "${suggestion}"?`);
        } else {
          console.error(`[config] No similar known key. Run \`pmbrain config show\` to see currently-set keys.`);
        }
        console.error(`[config] If this is intentional (downstream tooling, forward-compat), re-run with --force.`);
        process.exit(1);
      }
    } else {
      // --force: accept but warn loudly so the user sees what they're doing.
      const { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } = await import('../core/config.ts');
      const isKnown = KNOWN_CONFIG_KEYS.includes(key);
      const matchesPrefix = KNOWN_CONFIG_KEY_PREFIXES.some(p => key.startsWith(p));
      if (!isKnown && !matchesPrefix) {
        console.error(`[config] WARN: writing unknown key "${key}" with --force. Nothing in gbrain reads this.`);
      }
    }

    // v0.36 (D12 + D14): validate embedding-column keys at set time so a
    // bad config gets rejected loud + early. The `--coverage-override`
    // flag lets the user proceed past the < 90% gate when they know
    // they're mid-backfill.
    const coverageOverride =
      args.includes('--coverage-override') || args.includes('--yes');

    if (key === 'integrations.memorable.enabled') {
      const { isConfigTruthy } = await import('../core/config.ts');
      const hb = await import('../core/context/hook-heartbeat.ts');
      const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
      const on = isConfigTruthy(value);
      if (!on) {
        cfg.integrations = { ...(cfg.integrations ?? {}), memorable: { ...(cfg.integrations?.memorable ?? {}), enabled: false } };
        saveConfig(cfg);
        await hb.clearMemorableConsent();
        console.log(`Set ${key} = false (file plane: ~/.pmbrain/config.json)`);
        console.log('Relay disabled and the disclosure consent was revoked — re-enabling shows the disclosure again.');
        return;
      }
      if (!(await hb.memorableConsentValid())) {
        console.log(hb.MEMORABLE_DISCLOSURE_TEXT);
        const preConsented = args.includes('--yes');
        if (!preConsented) {
          if (!process.stdin.isTTY) {
            console.error('[config] non-interactive session and no --yes: refusing to enable a third-party relay without explicit consent. Nothing was written.');
            console.error('[AGENT] Relay this to your operator: run `pmbrain config set integrations.memorable.enabled true` in a terminal and answer the prompt.');
            process.exit(1);
          }
          const { promptYesNo } = await import('../core/confirm-prompt.ts');
          const accepted = await promptYesNo('[pmbrain] 开启 Memorable 会话结束转发？ [y/N] ');
          if (!accepted) {
            console.log('Declined. Nothing was written.');
            return;
          }
        }
        const stampPath = await hb.writeMemorableConsent();
        console.log(`Consent recorded: ${stampPath}`);
      }
      cfg.integrations = { ...(cfg.integrations ?? {}), memorable: { ...(cfg.integrations?.memorable ?? {}), enabled: true } };
      saveConfig(cfg);
      console.log(`Set ${key} = true (file plane: ~/.pmbrain/config.json)`);
      console.log(
        'Session-end traces will now be offered to the locally-installed `memorable` CLI, ' +
          'which sends redacted tool calls off-machine to its extraction API. ' +
          'Turn off: pmbrain config set integrations.memorable.enabled false (or PMBRAIN_MEMORABLE=0 / GBRAIN_MEMORABLE=0)',
      );
      return;
    }

    if (key === 'spend.posture') {
      const { isValidSpendPosture } = await import('../core/spend-posture.ts');
      if (!isValidSpendPosture(value)) {
        console.error(
          `[config] spend.posture must be 'gated' or 'tokenmax' (got '${value}').\n` +
          `[config]   pmbrain config set spend.posture tokenmax   # cost gates become informational\n` +
          `[config]   pmbrain config set spend.posture gated      # default: gates enforce`,
        );
        process.exit(1);
      }
    }

    if (key === 'embedding_columns') {
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('embedding_columns must be a JSON object');
        }
        // D12: validate every key + entry shape before persisting.
        for (const [k, entry] of Object.entries(parsed)) {
          validateColumnKey(k);
          validateColumnConfig(k, entry);
        }
      } catch (err) {
        if (err instanceof EmbeddingColumnConfigError) {
          console.error(`[config] ${err.message}`);
        } else {
          console.error(
            `[config] embedding_columns rejected: ${(err as Error).message}`,
          );
          console.error(
            `[config] Expected JSON shape: {"<column_name>": {"provider": "...", "dimensions": N, "type": "vector" | "halfvec"}, ...}`,
          );
        }
        process.exit(1);
      }
    }

    if (key === 'search_embedding_column') {
      // Validate against the merged registry (file + DB plane + builtins).
      // We re-read merged config so a prior `gbrain config set
      // embedding_columns ...` is visible.
      const fileCfg = loadConfig();
      const mergedCfg = fileCfg
        ? await loadConfigWithEngine(engine, fileCfg).catch(() => fileCfg)
        : null;
      if (mergedCfg) {
        let registry: ReturnType<typeof getEmbeddingColumnRegistry>;
        try {
          registry = getEmbeddingColumnRegistry(mergedCfg);
        } catch (err) {
          console.error(
            `[config] Existing embedding_columns is invalid; refusing to set search_embedding_column. ` +
              `Fix the registry first. (${(err as Error).message})`,
          );
          process.exit(1);
        }
        // Object.hasOwn so inherited keys ('constructor', 'toString', etc.)
        // cannot pass the registry-lookup gate.
        if (!Object.hasOwn(registry, value)) {
          const known = Object.keys(registry).sort().join(', ') || '(none)';
          console.error(
            `[config] Unknown embedding column "${value}". ` +
              `Declared columns: ${known}. ` +
              `Add it via: gbrain config set embedding_columns '<JSON>'`,
          );
          process.exit(1);
        }

        // D14 coverage gate. Probe the column's NULL-rate; refuse when
        // coverage < 90% unless `--coverage-override` or `--yes` is
        // present.
        try {
          const covRows = await engine.executeRaw<{ pct: number; total: number }>(
            `SELECT (
               COUNT(*) FILTER (WHERE ${quoteIdentifier(value)} IS NOT NULL)::float
               / NULLIF(COUNT(*), 0) * 100
             )::float AS pct,
             COUNT(*)::int AS total
             FROM content_chunks`,
          );
          const pct = covRows[0]?.pct ?? 0;
          const total = covRows[0]?.total ?? 0;
          if (total > 0 && pct < 90 && !coverageOverride) {
            console.error(
              `[config] Column "${value}" is ${pct.toFixed(1)}% populated (${total} total chunks).`,
            );
            console.error(
              `[config] Switching the default to a low-coverage column silently degrades search.`,
            );
            console.error(
              `[config] Re-run with --coverage-override (or --yes) to proceed anyway:`,
            );
            console.error(
              `[config]   gbrain config set search_embedding_column ${value} --coverage-override`,
            );
            process.exit(1);
          }
        } catch (err) {
          // Coverage probe failure shouldn't block when the column shape
          // is otherwise valid (e.g. the column was JUST added, no chunks
          // yet, NULLIF guard returns NULL → pct=0 BUT total=0 short-
          // circuits above). If the SQL itself errors (column ALTER race,
          // permission), warn but proceed.
          console.error(
            `[config] WARN: coverage probe failed (${(err as Error).message}); proceeding.`,
          );
        }
      }
    }

    if (isFileBackedModelConfigKey(key)) {
      const fileConfig = loadConfigFileOnly();
      if (!fileConfig) throw new Error('No config found. Run: pmbrain init');
      const fileValue = key === 'embedding_disabled'
        ? value === 'true'
        : key === 'chat_fallback_chain'
          ? value.split(',').map(item => item.trim()).filter(Boolean)
          : value;
      writeFileConfigValue(fileConfig, key, fileValue);
      saveConfig(fileConfig);
      await engine.unsetConfig(key);
      console.log(`Set ${key} = ${redactConfigValue(key, value)}`);
      return;
    }

    // v0.40.3.0 (D3 + Phase 2B): capture the OLD search.mode BEFORE the
    // setConfig so summarizeTransition() can classify the kind correctly.
    // Read fails silently → oldMode null → treated as broadening.
    let oldSearchMode: string | null = null;
    if (key === 'search.mode') {
      try {
        oldSearchMode = await engine.getConfig('search.mode');
      } catch {
        // ignore — null is the correct "never seen" semantic.
      }
    }

    if (MEMORY_DUAL_PLANE_KEYS.has(key)) {
      const { setWritebackMode, getWritebackStatus } = await import('../core/facts/writeback-set.ts');
      const current = await getWritebackStatus(engine);
      await setWritebackMode(engine, key === 'memory.auto_writeback' ? value.trim().toLowerCase() as 'off' | 'salient' | 'all' : current.mode, key === 'memory.auto_writeback_transient_ttl' ? { ttl: value } : {});
      console.log(`Set ${key} = ${value}`);
      return;
    }

    await engine.setConfig(key, value);
    // v0.36.x #892: redact sensitive values in confirmation output. API
    // keys / tokens / passwords are commonly set from terminals with
    // scrollback; echoing the raw value to stderr leaks the secret.
    console.log(`Set ${key} = ${redactConfigValue(key, value)}`);

    // v0.40.3.0 (D3 + Phase 2B): mode-switch UX. Fires only on
    // search.mode writes. Honors GBRAIN_NO_MODE_SWITCH_UX=1 + non-TTY.
    // The hook is best-effort — UX failures must NEVER break a config
    // set that already persisted.
    if (key === 'search.mode') {
      try {
        const { runModeSwitchUx } = await import('../core/search/mode-switch-ux.ts');
        const { isSearchMode } = await import('../core/search/mode.ts');
        await runModeSwitchUx({
          oldMode: oldSearchMode && isSearchMode(oldSearchMode) ? oldSearchMode : null,
          newMode: value,
          engine,
          isTty: Boolean(process.stdout.isTTY && process.stdin.isTTY),
          // CLI doesn't thread --yes here today; reserved for /ship-style
          // automation paths that can opt into auto-submit.
          yesFlag: false,
        });
      } catch (err) {
        console.error(`[mode-switch] UX hook failed (non-fatal): ${(err as Error).message}`);
      }
    }
  } else {
    console.error('Usage: pmbrain config [show|get|set|unset] <key> [value]');
    console.error('       pmbrain config unset --pattern <prefix>');
    process.exit(1);
  }
}
