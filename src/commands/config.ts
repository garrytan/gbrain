import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, loadConfigWithEngine } from '../core/config.ts';
import {
  getEmbeddingColumnRegistry,
  validateColumnKey,
  validateColumnConfig,
  quoteIdentifier,
  EmbeddingColumnNotRegisteredError,
  EmbeddingColumnConfigError,
} from '../core/search/embedding-column.ts';

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
  // Word-boundary matches: foo_key, foo.key, key_foo, key, api_key, ...
  return /(^|[._-])(key|secret|token|password|pwd|passwd|auth)([._-]|$)/.test(lower);
}

export function redactConfigValue(key: string, value: string): string {
  if (value.includes('postgresql://')) return redactUrl(value);
  if (isSensitiveConfigKey(key)) return '***';
  return value;
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];

  if (action === 'show') {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: gbrain init');
      process.exit(1);
    }
    console.log('GBrain config:');
    for (const [k, v] of Object.entries(config)) {
      const display = typeof v === 'string' ? redactConfigValue(k, v) : v;
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
        console.error('Usage: gbrain config unset --pattern <prefix>');
        process.exit(1);
      }
      const keys = await engine.listConfigKeys(prefix);
      if (keys.length === 0) {
        console.log(`No keys match prefix "${prefix}".`);
        return;
      }
      let deleted = 0;
      for (const k of keys) {
        const n = await engine.unsetConfig(k);
        if (n > 0) deleted += n;
      }
      console.log(`Unset ${deleted} key(s) matching "${prefix}":`);
      for (const k of keys) console.log(`  - ${k}`);
      return;
    }

    const key = args[1];
    if (!key) {
      console.error('Usage: gbrain config unset <key> | --pattern <prefix>');
      process.exit(1);
    }
    const n = await engine.unsetConfig(key);
    if (n > 0) {
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
    const val = await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    // v0.36 (D12 + D14): validate embedding-column keys at set time so a
    // bad config gets rejected loud + early. The `--coverage-override`
    // flag lets the user proceed past the < 90% gate when they know
    // they're mid-backfill.
    const coverageOverride =
      args.includes('--coverage-override') || args.includes('--yes');

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

    await engine.setConfig(key, value);
    // v0.36.x #892: redact sensitive values in confirmation output. API
    // keys / tokens / passwords are commonly set from terminals with
    // scrollback; echoing the raw value to stderr leaks the secret.
    console.log(`Set ${key} = ${redactConfigValue(key, value)}`);
  } else {
    console.error('Usage: gbrain config [show|get|set|unset] <key> [value]');
    console.error('       gbrain config unset --pattern <prefix>');
    process.exit(1);
  }
}
