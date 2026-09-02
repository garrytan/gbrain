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

import { redactPgUrl } from '../core/url-redact.ts';

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

/**
 * Vendor credential keys that `buildGatewayConfig` folds into the gateway env.
 * That seam reads the FILE plane (~/.gbrain/config.json) plus process.env and
 * never the DB plane, so `config set <vendor>_api_key` must not write the DB:
 * it would report success, `config get` would read it straight back, and every
 * provider call would still fail "requires <VENDOR>_API_KEY".
 *
 * Same bug class the v0.37.11.0 wave closed for embedding_model. That field
 * could only be fixed by refusing, because changing it needs a wipe-and-reinit.
 * A credential carries no such constraint, so the honest fix is to route the
 * write to the plane the consumer actually reads.
 *
 * Keep in sync with the `envFromConfig` mappings in
 * src/core/ai/build-gateway-config.ts.
 */
/** Dotted keys that are FILE-plane canonical (nested under a group in
 * ~/.gbrain/config.json) — read by engine-free processes via
 * loadConfigFileOnly. ONE list for both the `set` and `unset` lanes so the
 * next key cannot be added to only one branch (which would silently route
 * `unset` to the DB plane). */
const FILE_PLANE_DOTTED_KEYS: ReadonlySet<string> = new Set([
  'push.allow_unverified_remote',
  'hooks.stop_push_debounce_min',
  'backup.check_enabled',
  'backup.check_interval_days',
  // #4748: resolveMcpInstructions reads ONLY the file plane (all three MCP
  // transports build their initialize response from loadConfig()); the
  // `mcp.` prefix made a DB-plane write accepted and silently ignored.
  'mcp.instructions',
]);

/** Ambient-writeback keys are DUAL-PLANE (OV2-5): the DB plane is
 * authoritative (the serve-side harvest gate re-checks it before any
 * extraction) while the file plane mirrors it for the engine-free readers
 * (Stop-hook child, stdio boot resolve, the bootstrap-harness advisory's
 * audience gate). ONE leaf list derives both the Set and the unset lane's
 * types so a new key cannot be dual-written on one lane and single-deleted
 * (or silently mistyped) on the other. Write order: file first, then DB —
 * a DB failure leaves the planes briefly diverged and says so (doctor
 * surfaces plane drift). */
const MEMORY_DUAL_PLANE_LEAVES = ['auto_writeback', 'auto_writeback_transient_ttl'] as const;
const MEMORY_DUAL_PLANE_KEYS: ReadonlySet<string> = new Set(
  MEMORY_DUAL_PLANE_LEAVES.map((l) => `memory.${l}`),
);
/** `brain.audience` mirrors the same dual-plane rule (WP8): the declared
 * audience must be readable by the ENGINE-FREE bootstrap-harness lane so a
 * shared-declared brain never gets the enable-nudge advisory. */
const BRAIN_AUDIENCE_KEY = 'brain.audience';

/** Ambient-writeback posture re-stamp (red-team review, this wave): the
 * engine-free bootstrap-harness renderer reads `memory.visibility_posture`
 * from the file mirror, previously refreshed ONLY by `config set memory.*` —
 * so a later `facts.default_visibility` flip left installed instruction
 * blocks ordering the OLD posture (visibility is an EXPLICIT param in the
 * block, so a stale 'world' stamp silently widens an operator's new private
 * default) and doctor's drift warn named a bootstrap re-run that could never
 * converge. Re-stamping on every facts.default_visibility set/unset closes
 * the loop. Best-effort and gated on the mirror already existing: a failed
 * stamp never breaks the DB write that persisted, and brains that never
 * touched ambient writeback don't grow a `memory` slot. */
/** The machine-global config.json mirror belongs to the HOST brain: a
 * `config set/unset --brain <mount>` (or GBRAIN_BRAIN_ID / .gbrain-mount)
 * writes the MOUNT's DB row without touching the host's engine-free readers
 * — enabling ambient writeback on a team mount must never opt the host's
 * Stop hook into banking host conversations (codex re-review, this wave).
 * Unresolvable brain selection also skips the mirror (fail toward not
 * mutating host state); doctor's plane-compare names the re-sync if the
 * HOST's own planes ever diverge. */
async function hostBrainSelected(): Promise<boolean> {
  try {
    const { resolveBrainId } = await import('../core/brain-resolver.ts');
    const { HOST_BRAIN_ID } = await import('../core/brain-registry.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    return resolveBrainId(getCliOptions().brain ?? null) === HOST_BRAIN_ID;
  } catch {
    return false;
  }
}

async function restampVisibilityPosture(newRaw: string | null): Promise<void> {
  try {
    if (!(await hostBrainSelected())) return; // a mount's posture never stamps the host mirror
    const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
    const { visibilityPostureFromRaw } = await import('../core/facts/writeback-config.ts');
    const cfg = loadConfigFileOnly();
    if (!cfg?.memory) return;
    cfg.memory.visibility_posture = visibilityPostureFromRaw(newRaw).visibility;
    saveConfig(cfg);
  } catch { /* best-effort — the authoritative DB write already landed */ }
}

export const FILE_PLANE_API_KEYS: readonly string[] = [
  'openai_api_key',
  'anthropic_api_key',
  'zeroentropy_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'dashscope_api_key',
  'litellm_api_key',
  'together_api_key',
  'google_api_key',
  'azure_openai_api_key', // #4031: mergedProviderEnv reads the file plane only
];

export function redactConfigValue(key: string, value: string): string {
  // Both scheme spellings — the old local regex only matched postgresql://,
  // so a postgres:// DSN's password echoed in the clear. redactPgUrl is the
  // canonical single home (drops the whole userinfo, both schemes).
  if (/postgres(ql)?:\/\//.test(value)) return redactPgUrl(value);
  if (isSensitiveConfigKey(key)) return '***';
  return value;
}

// #3661: the flags `config set` actually honors. Everything else that looks
// like a flag is rejected before the write — see the gate in the `set` branch.
const CONFIG_SET_KNOWN_FLAGS = ['--force', '--coverage-override', '--yes'];

/**
 * db-availability loop (5c): the DB-connection keys are FILE-plane canonical —
 * `loadConfig()` never reads them from the DB plane, so the old fall-through
 * to `engine.setConfig` was a silent no-op that even read back "correctly"
 * via `config get` (from the DB plane). Worse, it was CIRCULAR: `config` sat
 * behind connectEngine, so "fix your URL with config set database_url" died
 * on the exact connection error it was meant to fix.
 *
 *   database_url / database_path → ROUTED to the file plane (the
 *     FILE_PLANE_API_KEYS pattern — the intent is satisfiable as typed);
 *     engine is inferred from whichever key was set.
 *   engine → HARD-REFUSED with the recipe (the embedding_model treatment):
 *     a direct engine flip without a data migration splits the brain across
 *     two stores. No --force escape.
 *
 * Returns true when the key was handled (caller returns). Engine-free by
 * construction — dispatched BEFORE connectEngine via tryRunConfigEngineFree.
 */
export async function handleDbPlaneRoutedKeys(key: string, value: string): Promise<boolean> {
  if (key === 'engine') {
    console.error('[config] engine is INFERRED from database_url / database_path — it is never set directly.');
    console.error('[config] To move your data between engines:  gbrain migrate --to <supabase|pglite>');
    console.error('[config] To point at a different database:   gbrain config set database_url <conn>  (or gbrain init --url <conn>)');
    console.error('[config] No --force escape: an engine flip without a data migration splits the brain across two stores.');
    process.exit(1);
  }
  if (key !== 'database_url' && key !== 'database_path') return false;
  if (key === 'database_url' && !/^postgres(ql)?:\/\//.test(value)) {
    console.error('[config] database_url must be a postgres:// or postgresql:// connection string.');
    process.exit(1);
  }
  const { isThinClient, loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
  const cfg = (loadConfigFileOnly() ?? {}) as Parameters<typeof saveConfig>[0] & Record<string, unknown>;
  // Thin-client guard (same bar as db-repair and init's re-run refusal):
  // writing a local engine + URL into a remote_mcp config would create the
  // hybrid local/remote state init explicitly refuses to create.
  if (isThinClient(cfg as Parameters<typeof isThinClient>[0])) {
    console.error('[config] this machine is a thin client (remote MCP) — a local database_url would conflict with the remote setup.');
    console.error('[config] To convert it to a local brain deliberately: gbrain init --url <conn> --force');
    process.exit(1);
  }
  const priorEngine = cfg.engine;
  if (key === 'database_url') {
    cfg.database_url = value;
    cfg.engine = 'postgres';
    delete cfg.database_path;
  } else {
    cfg.database_path = value;
    cfg.engine = 'pglite';
    delete cfg.database_url;
  }
  saveConfig(cfg);
  console.log(`Set ${key} = ${redactConfigValue(key, value)} (file plane: ~/.gbrain/config.json; engine inferred: ${cfg.engine})`);
  if (priorEngine && priorEngine !== cfg.engine) {
    // Pointing at the other engine's plane is a legitimate re-point, but it
    // does NOT move data — say so, or the flip reads as a lossless switch.
    console.error(
      `[config] note: engine flipped ${priorEngine} → ${cfg.engine}. Existing ${priorEngine} data was NOT moved — ` +
        `to move it, use: gbrain migrate --to ${cfg.engine === 'postgres' ? 'supabase' : 'pglite'}`,
    );
  }
  return true;
}

/**
 * Engine-free `config set` dispatch for the DB-connection keys. Called from
 * handleCliOnly BEFORE connectEngine — these are exactly the keys you need
 * to change when the engine can't connect. Returns true when handled.
 */
export async function tryRunConfigEngineFree(args: string[]): Promise<boolean> {
  if (args[0] !== 'set') return false;
  const key = args[1];
  const value = args.slice(2).find((a) => !a.startsWith('-'));
  if (!key || value === undefined) return false; // let the engine path print usage
  if (key !== 'database_url' && key !== 'database_path' && key !== 'engine') return false;
  return handleDbPlaneRoutedKeys(key, value);
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
      // #575: objects interpolated into the template literal printed
      // `[object Object]` — render them as JSON instead. Sensitive keys
      // stay redacted whether the value is a string or an object.
      const display = typeof v === 'string'
        ? redactConfigValue(k, v)
        : v !== null && typeof v === 'object'
          ? (isSensitiveConfigKey(k) ? '***' : JSON.stringify(v))
          : v;
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
      // Dual-plane keys matching the prefix must ALSO leave the file mirror
      // (codex re-review, this wave): a DB-only pattern delete would report
      // success while the engine-free Stop hook keeps reading the mirror's
      // enabled value — the exact bypass the single-key dual-plane branch
      // below exists to prevent. Swept even when the DB had no matching rows
      // (a previously-failed dual-write leaves the key file-only).
      const fileSwept: string[] = [];
      const dualPlaneMatches = [...MEMORY_DUAL_PLANE_KEYS, BRAIN_AUDIENCE_KEY].filter((k) => k.startsWith(prefix));
      // Mount selection never sweeps the host's machine-local mirror
      // (codex re-review) — same rule as the single-key dual-plane lanes.
      if (dualPlaneMatches.length > 0 && (await hostBrainSelected())) {
        const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
        const cfg = loadConfigFileOnly();
        if (cfg) {
          for (const k of dualPlaneMatches) {
            if (k === BRAIN_AUDIENCE_KEY) {
              if (cfg.brain && 'audience' in cfg.brain) { delete cfg.brain.audience; fileSwept.push(k); }
            } else {
              const leaf = k.slice('memory.'.length) as (typeof MEMORY_DUAL_PLANE_LEAVES)[number];
              if (cfg.memory && leaf in cfg.memory) { delete cfg.memory[leaf]; fileSwept.push(k); }
            }
          }
          if (fileSwept.length > 0) saveConfig(cfg);
        }
      }
      if (keys.length === 0 && fileSwept.length === 0) {
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
      for (const k of fileSwept) {
        if (!keys.includes(k)) console.log(`  - ${k} (file mirror)`);
      }
      if (fileSwept.length > 0) console.log(`File mirror cleared for: ${fileSwept.join(', ')}`);
      return;
    }

    const key = args[1];
    if (!key) {
      console.error('Usage: gbrain config unset <key> | --pattern <prefix>');
      process.exit(1);
    }
    if (MEMORY_DUAL_PLANE_KEYS.has(key) || key === BRAIN_AUDIENCE_KEY) {
      // Dual-plane delete, mirroring the dual-plane set: file mirror AND the
      // authoritative DB row both go. "Not found" only when neither had it.
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const cfg = loadConfigFileOnly();
      let fileHad = false;
      // Mount selection never touches the host's machine-local mirror —
      // same rule as the dual-plane set lane (codex re-review).
      if (await hostBrainSelected()) {
        if (key === BRAIN_AUDIENCE_KEY) {
          if (cfg?.brain && 'audience' in cfg.brain) {
            delete cfg.brain.audience;
            saveConfig(cfg);
            fileHad = true;
          }
        } else {
          const leaf = key.slice('memory.'.length) as (typeof MEMORY_DUAL_PLANE_LEAVES)[number];
          if (cfg?.memory && leaf in cfg.memory) {
            delete cfg.memory[leaf];
            saveConfig(cfg);
            fileHad = true;
          }
        }
      }
      let dbDeleted = 0;
      try {
        dbDeleted = await engine.unsetConfig(key);
      } catch (e) {
        // Same posture as the dual-plane set lane (adversarial review, this
        // wave): the DB row is the authoritative runtime value — a failed
        // delete after the file delete succeeded means the revocation did
        // NOT take effect, so say it and exit non-zero instead of a raw
        // stack (or worse, a success line).
        console.error(`[config] ERROR: file plane cleared but the DB-plane delete failed (${e instanceof Error ? e.message : String(e)}).`);
        console.error(`[config] The authoritative runtime value is UNCHANGED — re-run this command once the database is reachable.`);
        process.exit(1);
      }
      if (fileHad || dbDeleted > 0) {
        console.log(`Unset ${key} (${[fileHad ? 'file plane' : null, dbDeleted > 0 ? 'db plane' : null].filter(Boolean).join(' + ')})`);
        if (key === 'memory.auto_writeback') {
          console.log('Ambient writeback resolves off while unset. If harness instruction blocks were installed, remove them: gbrain bootstrap harness --yes (converges on off).');
        }
      } else {
        console.error(`Config key not found: ${key}`);
        process.exit(1);
      }
      return;
    }
    if (FILE_PLANE_DOTTED_KEYS.has(key)) {
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const cfg = loadConfigFileOnly();
      const [top, leaf] = key.split('.') as ['push' | 'hooks' | 'backup' | 'mcp', string];
      const branch = cfg?.[top] as Record<string, unknown> | undefined;
      if (cfg && branch && leaf in branch) {
        delete branch[leaf];
        saveConfig(cfg);
        console.log(`Unset ${key} (file plane)`);
      } else {
        console.error(`Config key not found: ${key}`);
        process.exit(1);
      }
      return;
    }
    if (key === 'integrations.memorable.enabled') {
      // File-plane like `set` (the gate's readers are engine-free hook
      // children) — the pre-fix fall-through hit the DB plane, printed
      // "Config key not found", and left the file-plane `true` active.
      // Unset is a REVOCATION: the consent stamp goes with the flag.
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const hb = await import('../core/context/hook-heartbeat.ts');
      const cfg = loadConfigFileOnly();
      const memorable = cfg?.integrations?.memorable as Record<string, unknown> | undefined;
      await hb.clearMemorableConsent();
      if (cfg && memorable && 'enabled' in memorable) {
        delete memorable.enabled;
        saveConfig(cfg);
        console.log(`Unset ${key} (file plane) — disclosure consent revoked`);
      } else {
        // The stamp was still cleared above — deliberate: the CLI's full-file
        // config rewrites can drop the flag while the stamp survives, and an
        // orphaned stamp would let a later out-of-band re-enable skip the
        // disclosure. Unset always revokes; say so even on the miss.
        console.error(`Config key not found: ${key} (disclosure consent revoked regardless)`);
        process.exit(1);
      }
      return;
    }
    if (FILE_PLANE_API_KEYS.includes(key)) {
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const cfg = loadConfigFileOnly() as unknown as Record<string, unknown> | null;
      if (cfg && key in cfg) {
        delete cfg[key];
        saveConfig(cfg as unknown as Parameters<typeof saveConfig>[0]);
        console.log(`Unset ${key} (file plane)`);
      } else {
        console.error(`Config key not found: ${key}`);
        process.exit(1);
      }
      return;
    }
    const n = await engine.unsetConfig(key);
    if (n > 0) {
      console.log(`Unset ${key}`);
      if (key === 'facts.default_visibility') await restampVisibilityPosture(null);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
    return;
  }

  // #3943: `--raw` (get's redaction opt-out) may appear before the key, so
  // strip it from the positional scan rather than reading args[1] blindly.
  const rawFlag = args.includes('--raw');
  const positionals = args.filter((a) => a !== '--raw');
  const key = positionals[1];
  const value = positionals[2];

  if (action === 'get' && key) {
    // #2120: `get` used to read only the DB plane, so a runtime-effective key
    // in ~/.gbrain/config.json (or env) reported not-found. Resolve the way
    // the runtime does — env/file plane wins over DB (loadConfig() already
    // overlays env onto the file) — and report which plane answered on
    // stderr, keeping stdout a bare value for scripts.
    const filePlane = loadConfig() as Record<string, unknown> | null;
    // Dotted keys (push.allow_unverified_remote, hooks.stop_push_debounce_min)
    // are stored NESTED by `set`; resolve the path so `get`/`unset` see them.
    const resolveDotted = (obj: Record<string, unknown> | null, k: string): unknown => {
      if (!obj) return undefined;
      if (k in obj) return obj[k];
      return k.split('.').reduce<unknown>((acc, seg) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[seg] : undefined), obj);
    };
    const fileVal = resolveDotted(filePlane, key);
    const dbVal = await engine.getConfig(key);
    // Dual-plane ambient-writeback keys are DB-AUTHORITATIVE at runtime
    // (adversarial review, this wave): reporting the file mirror here after
    // a failed dual-write would show 'off' while every runtime surface still
    // serves the previous DB value — exactly the lie the off switch's
    // non-zero exit exists to prevent. Everything else keeps the #2120
    // file/env-wins resolution.
    const dbAuthoritative = MEMORY_DUAL_PLANE_KEYS.has(key) || key === BRAIN_AUDIENCE_KEY;
    const val = dbAuthoritative
      ? (dbVal ?? fileVal)
      : (fileVal !== undefined && fileVal !== null ? fileVal : dbVal);
    if (val !== null && val !== undefined) {
      // #3943: redact by default like `show`/`set` — `get` output lands in
      // agent transcripts and shell history; scripts opt out with the flag.
      const out = typeof val === 'string' ? val : JSON.stringify(val);
      console.log(rawFlag ? out : redactConfigValue(key, out));
      if (dbAuthoritative) {
        console.error(`[config] source: ${dbVal !== null && dbVal !== undefined ? 'db plane (authoritative for this key)' : 'file mirror (no DB row)'}`);
        if (dbVal !== null && dbVal !== undefined && fileVal !== undefined && fileVal !== null && String(fileVal) !== String(dbVal)) {
          console.error(`[config] WARN: file mirror disagrees ('${String(fileVal)}') — planes diverged; re-run: gbrain config set ${key} ${String(dbVal)}`);
        }
      } else if (fileVal !== undefined && fileVal !== null) {
        const shadow = dbVal !== null && dbVal !== undefined
          ? ' — a DB-plane value also exists and is shadowed at runtime'
          : '';
        console.error(`[config] source: file/env plane (~/.gbrain/config.json or env)${shadow}`);
      } else {
        console.error(`[config] source: db plane`);
      }
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    // #3661: `config set` dropped flags it does not implement and wrote
    // anyway. `--dry-run` — honored by sync/import/extract/quarantine/pages —
    // printed the usual "Set <key> = <value>" confirmation and persisted the
    // mutation, so a caller probing a value silently changed live config.
    // Unknown flags are now refused BEFORE any validation or write runs —
    // regardless of whether they land after the value
    // (`config set <key> <value> --dry-run`) or before it
    // (`config set <key> --dry-run <value>`). Scan every token after the
    // key and resolve the value as the first non-flag one, so a flag
    // sitting in the value slot can't slip through as literal config
    // content.
    const tail = args.slice(2);
    const unknownFlags = tail.filter(a => a.startsWith('-') && !CONFIG_SET_KNOWN_FLAGS.includes(a));
    if (unknownFlags.length > 0) {
      for (const flag of unknownFlags) {
        console.error(`[config] unknown flag: ${flag}`);
      }
      console.error(`[config] \`gbrain config set\` accepts: ${CONFIG_SET_KNOWN_FLAGS.join(', ')}.`);
      console.error(`[config] Nothing was written.`);
      process.exit(1);
    }
    const value = tail.find(a => !a.startsWith('-')) ?? args[2];

    // Bootstrap hook-lane keys are FILE-plane canonical: they are read by
    // engine-free processes (the harness hook children and the detached
    // `sources push` child) via loadConfigFileOnly, which never sees the DB
    // plane — and the DB plane is unreadable anyway while a `gbrain serve`
    // holds the single-writer lock. Route them to ~/.gbrain/config.json.
    // `integrations.memorable.enabled` is deliberately NOT in
    // FILE_PLANE_DOTTED_KEYS: that set is shared with the UNSET lane, where
    // the generic file-plane branch would swallow the key before its
    // dedicated branch below — which must win, because unset is a consent
    // REVOCATION (it clears the disclosure stamp, not just the flag).
    // Ambient-writeback keys DUAL-WRITE (OV2-5): file mirror first (the
    // engine-free readers' plane), then the authoritative DB row. A DB
    // failure leaves the planes briefly diverged — reported, not hidden.
    if (key === BRAIN_AUDIENCE_KEY) {
      // Dual-plane like memory.* (WP8): the engine-free harness lane gates
      // its enable-nudge advisory on the file-plane declared audience.
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
      const audience = value.trim().toLowerCase();
      if (audience !== 'personal' && audience !== 'shared') {
        console.error(`[config] ${key} must be personal | shared (got '${value}'). Nothing was written.`);
        process.exit(1);
      }
      const hostPlane = await hostBrainSelected();
      if (hostPlane) {
        cfg.brain = { ...(cfg.brain ?? {}), audience };
        saveConfig(cfg);
      } else {
        console.log(`[config] mounted brain selected — the machine-local mirror belongs to the host brain and is untouched (DB row only).`);
      }
      try {
        await engine.setConfig(key, audience);
      } catch (e) {
        // Non-zero exit (adversarial review, this wave): the DB plane is
        // authoritative for engine-backed readers — reporting success here
        // would let `config get` show the file value while runtime
        // classification still reads the old declaration.
        console.error(`[config] ERROR: ${hostPlane ? 'file plane written but ' : ''}the DB-plane write failed (${e instanceof Error ? e.message : String(e)}).`);
        console.error(`[config] The authoritative runtime value is UNCHANGED — re-run this command once the database is reachable.`);
        process.exit(1);
      }
      console.log(`Set ${key} = ${audience} (${hostPlane ? 'file + db planes' : 'db plane only — mounted brain'})`);
      return;
    }
    if (MEMORY_DUAL_PLANE_KEYS.has(key)) {
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
      let normalized: string;
      if (key === 'memory.auto_writeback') {
        const { WRITEBACK_MODES } = await import('../core/facts/writeback-config.ts');
        normalized = value.trim().toLowerCase();
        if (!(WRITEBACK_MODES as readonly string[]).includes(normalized)) {
          console.error(`[config] ${key} must be one of: ${WRITEBACK_MODES.join(' | ')} (got '${value}'). Nothing was written.`);
          process.exit(1);
        }
        // WP8: on a shared-classified brain, enabling ambient capture gets a
        // caution (members' words get persisted) — never a refusal.
        if (normalized !== 'off') {
          try {
            const { classifyBrainAudience } = await import('../core/facts/writeback-audience.ts');
            const audience = await classifyBrainAudience(engine, cfg);
            if (audience.audience === 'shared') {
              console.error('[config] CAUTION: this brain looks like a company/team brain (' + audience.reasons.join('; ') + ').');
              console.error('[config] Ambient writeback persists what people say to agents on this brain into a store other');
              console.error('[config] authorized agents can read. Check `facts.default_visibility` and your ACCESS_POLICY.md');
              console.error('[config] before relying on it. Proceeding as requested.');
            }
          } catch { /* classifier is advisory — never blocks an explicit set */ }
        }
      } else {
        // Same predicate as the resolver's degrade path — ONE home in
        // ttl-parse.ts so config-set rejection and runtime fallback agree.
        const { isValidTransientTtl } = await import('../core/facts/ttl-parse.ts');
        normalized = value.trim();
        if (!isValidTransientTtl(normalized)) {
          console.error(`[config] ${key} must be a positive duration shorthand no longer than 365d (e.g. '3d', '12h'; got '${value}'). Nothing was written.`);
          process.exit(1);
        }
      }
      // Stamp the resolved visibility POSTURE into the mirror while we hold
      // an engine: the engine-free bootstrap-harness renderer embeds it in
      // the managed instruction block. A failed read keeps any prior stamp;
      // with NO prior stamp it fail-closes to 'private' — the file resolver
      // defaults an ABSENT stamp to 'world' (F5's readable-unset rule), so
      // leaving it absent here would let a transient blip on an explicitly
      // private brain render world-widening instructions (codex re-review,
      // this wave). A wrongly-private stamp on a world brain only costs a
      // doctor drift warn; the reverse widens facts.
      let posture: string | undefined = cfg.memory?.visibility_posture;
      try {
        const { visibilityPostureFromRaw } = await import('../core/facts/writeback-config.ts');
        posture = visibilityPostureFromRaw(await engine.getConfig('facts.default_visibility')).visibility;
      } catch {
        posture = posture ?? 'private';
      }
      const hostPlane = await hostBrainSelected();
      if (hostPlane) {
        cfg.memory = {
          ...(cfg.memory ?? {}),
          [key.slice('memory.'.length)]: normalized,
          ...(posture ? { visibility_posture: posture } : {}),
        };
        saveConfig(cfg);
      } else {
        // The mirror gates the HOST's engine-free Stop hook — enabling a
        // mount must not opt the host's conversations into banking.
        console.log(`[config] mounted brain selected — the machine-local mirror belongs to the host brain and is untouched (DB row only; the mount's serve reads the DB plane).`);
      }
      try {
        await engine.setConfig(key, normalized);
      } catch (e) {
        // Non-zero exit (adversarial review, this wave): the serve-side gate
        // and the instruction lanes read the DB plane — exiting 0 here would
        // report an off switch as flipped while every runtime surface still
        // serves the PREVIOUS value, and `config get` (file plane) would
        // corroborate the lie. Loud failure is the only honest outcome.
        console.error(`[config] ERROR: ${hostPlane ? 'file plane written but ' : ''}the DB-plane write failed (${e instanceof Error ? e.message : String(e)}).`);
        console.error(`[config] The authoritative runtime value is UNCHANGED (still the previous DB value) — re-run this command once the database is reachable.`);
        process.exit(1);
      }
      console.log(`Set ${key} = ${normalized} (${hostPlane ? 'file + db planes' : 'db plane only — mounted brain'})`);
      if (key === 'memory.auto_writeback' && normalized !== 'off') {
        console.log('Ambient writeback enabled. Running stdio serves pick it up on restart; HTTP serves on the next request.');
        console.log('To install the managed harness instruction blocks: gbrain bootstrap harness --yes');
      }
      if (key === 'memory.auto_writeback' && normalized === 'off') {
        // The off switch gates instructions + extraction immediately, but
        // previously-installed harness instruction blocks keep directing new
        // sessions until converged — say so (red-team review, this wave).
        console.log('Ambient writeback off. If harness instruction blocks were installed, remove them: gbrain bootstrap harness --yes (converges on off).');
      }
      return;
    }
    if (FILE_PLANE_DOTTED_KEYS.has(key) || key === 'integrations.memorable.enabled') {
      const { loadConfigFileOnly, saveConfig, isConfigTruthy } = await import('../core/config.ts');
      const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
      if (key === 'integrations.memorable.enabled') {
        // Same file-plane rule as the other hook-lane keys: the session-end
        // relay gate is read by engine-free hook children via loadConfig.
        //
        // Enabling is a CONSENT event, not just a config write: the relay
        // hands session tool-call traces to a closed-source third-party CLI
        // that sends them off-machine. The gate requires a gbrain-authored
        // consent stamp that ONLY this flow writes (the memorable CLI flips
        // the boolean out-of-band on `memorable enable`, but it can never
        // write the stamp — see hook-heartbeat.ts's consent-stamp section).
        const hb = await import('../core/context/hook-heartbeat.ts');
        const on = isConfigTruthy(value);
        if (!on) {
          cfg.integrations = { ...(cfg.integrations ?? {}), memorable: { ...(cfg.integrations?.memorable ?? {}), enabled: false } };
          saveConfig(cfg);
          await hb.clearMemorableConsent();
          console.log(`Set ${key} = false (file plane: ~/.gbrain/config.json)`);
          console.log('Relay disabled and the disclosure consent was revoked — re-enabling shows the disclosure again.');
          return;
        }
        if (!(await hb.memorableConsentValid())) {
          console.log(hb.MEMORABLE_DISCLOSURE_TEXT);
          const preConsented = tail.includes('--yes');
          if (!preConsented) {
            if (!process.stdin.isTTY) {
              // Skillpack trust-prompt posture: a non-interactive session
              // cannot consent on the operator's behalf. Nothing was written.
              console.error('[config] non-interactive session and no --yes: refusing to enable a third-party relay without explicit consent. Nothing was written.');
              // Deliberately does NOT mention --yes: this line is printed INTO
              // agent sessions (the very sessions whose tool calls the relay
              // egresses), and advertising the non-interactive bypass here
              // hands a prompt-injected agent the exact string that flips the
              // gate. Operators find --yes in the docs.
              console.error('[AGENT] Relay this to your operator: run `gbrain config set integrations.memorable.enabled true` in a terminal and answer the prompt.');
              process.exit(1);
            }
            const { promptYesNo } = await import('../core/confirm-prompt.ts');
            const accepted = await promptYesNo('[gbrain] Enable the Memorable session-end relay? [y/N] ');
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
        console.log(`Set ${key} = true (file plane: ~/.gbrain/config.json)`);
        console.log(
          'Session-end traces will now be offered to the locally-installed `memorable` CLI, ' +
            'which sends redacted tool calls off-machine to its extraction API. ' +
            'Turn off: gbrain config set integrations.memorable.enabled false (or GBRAIN_MEMORABLE=0)',
        );
      } else if (key === 'push.allow_unverified_remote') {
        const on = isConfigTruthy(value);
        cfg.push = { ...(cfg.push ?? {}), allow_unverified_remote: on };
        saveConfig(cfg);
        console.log(`Set ${key} = ${on} (file plane: ~/.gbrain/config.json)`);
        if (on) {
          console.log(
            'WARNING: workspace pushes now SKIP repo-visibility verification. ' +
              'This trusts the remote on your word — unset it once verification works: ' +
              'gbrain config set push.allow_unverified_remote false',
          );
        }
      } else if (key === 'backup.check_enabled') {
        const on = isConfigTruthy(value);
        cfg.backup = { ...(cfg.backup ?? {}), check_enabled: on };
        saveConfig(cfg);
        console.log(`Set ${key} = ${on} (file plane: ~/.gbrain/config.json)`);
      } else if (key === 'backup.check_interval_days') {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          console.error(`[config] ${key} must be an integer >= 1 (days between automatic backup checks)`);
          process.exit(1);
        }
        cfg.backup = { ...(cfg.backup ?? {}), check_interval_days: n };
        saveConfig(cfg);
        console.log(`Set ${key} = ${n} (file plane: ~/.gbrain/config.json)`);
      } else if (key === 'mcp.instructions') {
        // #4748: deployment identity appended to the MCP initialize contract.
        // Takes effect on the next `gbrain serve` start (the response is
        // built once per process from loadConfig()).
        cfg.mcp = { ...(cfg.mcp ?? {}), instructions: value };
        saveConfig(cfg);
        console.log(`Set ${key} (file plane: ~/.gbrain/config.json) — restart \`gbrain serve\` to apply`);
      } else {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          console.error(`[config] ${key} must be an integer >= 0 (minutes; 0 = push every turn)`);
          process.exit(1);
        }
        cfg.hooks = { ...(cfg.hooks ?? {}), stop_push_debounce_min: n };
        saveConfig(cfg);
        console.log(`Set ${key} = ${n} (file plane: ~/.gbrain/config.json)`);
      }
      return;
    }
    // DB-connection keys route to the file plane (or refuse, for `engine`) —
    // single home in handleDbPlaneRoutedKeys, shared with the engine-free
    // pre-connectEngine dispatch.
    if (await handleDbPlaneRoutedKeys(key, value)) return;

    // Vendor credentials are file-plane canonical (see FILE_PLANE_API_KEYS).
    // Routed, not refused: unlike embedding_model there is nothing to re-init,
    // so the user's intent is satisfiable exactly as typed.
    if (FILE_PLANE_API_KEYS.includes(key)) {
      const { loadConfigFileOnly, saveConfig } = await import('../core/config.ts');
      const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
      (cfg as unknown as Record<string, unknown>)[key] = value;
      saveConfig(cfg);
      // #892: redact — the raw secret must not reach scrollback or shell history.
      console.log(`Set ${key} = ${redactConfigValue(key, value)} (file plane: ~/.gbrain/config.json)`);
      return;
    }

    // v0.37.11.0 fix wave (Lane C.2 + CDX2-13): refuse writes to schema-sizing
    // fields unconditionally. These fields size the `content_chunks.embedding`
    // column at init time and are file-plane canonical. `gbrain config set
    // embedding_model X` writes the DB plane, which the embed pipeline
    // never reads — silent lie that took users hours to diagnose.
    //
    // No `--force` escape hatch (CDX2-13): keeping a known-no-op DB-only
    // write preserves the split-brain footgun the wave exists to close.
    // Switching providers requires wipe-and-reinit; the recipe below is
    // paste-ready and uses the actual command path that works after Lane B.
    if (key === 'embedding_model' || key === 'embedding_dimensions') {
      const { gbrainPath } = await import('../core/config.ts');
      const isPgliteEngine = (await import('../core/config.ts')).loadConfig()?.engine === 'pglite';
      const dbPath = gbrainPath('brain.pglite');
      console.error(`[config] ${key} is a file-plane field that sizes the schema.`);
      console.error(`[config] Setting it in the DB has no effect on the embed pipeline (silent no-op).`);
      console.error(`[config]`);
      if (isPgliteEngine) {
        console.error(`[config] To switch embedding models/dimensions on PGLite, wipe and re-init:`);
        console.error(`[config]   mv ${dbPath} ${dbPath}.bak`);
        if (key === 'embedding_model') {
          console.error(`[config]   gbrain init --pglite --embedding-model ${value}`);
        } else {
          console.error(`[config]   gbrain init --pglite --embedding-dimensions ${value}`);
        }
        console.error(`[config]   gbrain sync   # re-imports your brain repo`);
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
        console.error(`[config] Unknown config key "${key}".`);
        // #3748: `budget.*` (e.g. budget.daily_cap_usd) appeared once in old
        // release notes but was never registered and has NO readers — a
        // --force write would set a "cap" that caps nothing, which for a
        // spend control is worse than a rejection. Route the operator to the
        // controls that actually exist.
        if (key === 'budget' || key.startsWith('budget.')) {
          console.error(`[config] budget.* keys are not live controls — nothing in gbrain reads them, so a cap written here caps nothing.`);
          console.error(`[config] The live spend controls are \`gbrain config set spend.posture <gated|tokenmax>\` and the per-command gates in docs/operations/spend-controls.md.`);
        } else {
          const { suggestNearest } = await import('../core/levenshtein.ts');
          const suggestion = suggestNearest(key, KNOWN_CONFIG_KEYS, 3);
          if (suggestion) {
            console.error(`[config] Did you mean "${suggestion}"?`);
          } else {
            console.error(`[config] No similar known key. Run \`gbrain config show\` to see currently-set keys.`);
          }
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
        if (key === 'budget' || key.startsWith('budget.')) {
          // #3748: an operator who believes this caps spend has NO cap at all.
          console.error(`[config] WARN: budget.* is NOT a spend cap — the live controls are spend.posture + docs/operations/spend-controls.md.`);
        }
      }
    }

    // v0.36 (D12 + D14): validate embedding-column keys at set time so a
    // bad config gets rejected loud + early. The `--coverage-override`
    // flag lets the user proceed past the < 90% gate when they know
    // they're mid-backfill.
    const coverageOverride =
      args.includes('--coverage-override') || args.includes('--yes');

    // #4348: validate cycle.timezone at set time — resolveCycleDate falls
    // back loudly at run time, but the typo should be rejected here, at the
    // moment the operator can fix it.
    if (key === 'cycle.timezone') {
      const { isValidTimeZone } = await import('../core/cycle/cycle-date.ts');
      if (!isValidTimeZone(value)) {
        console.error(
          `[config] cycle.timezone must be a valid IANA timezone ` +
          `(for example Asia/Kolkata or America/Los_Angeles; got '${value}').`,
        );
        process.exit(1);
      }
    }

    // Validate sources.default at set time. This key is read by
    // source-resolver.ts tier 5 on EVERY unqualified call, and tier 5 calls
    // assertSourceExists — so a syntactically valid but non-existent id set
    // here would make every later unqualified command throw, far from the
    // typo that caused it. `gbrain sources default <id>` already validates;
    // config set is the lower-level door to the same key and must not be a
    // way around that check.
    if (key === 'sources.default') {
      const { isValidSourceId } = await import('../core/source-id.ts');
      if (!isValidSourceId(value)) {
        console.error(
          `[config] sources.default must be 1-32 lowercase alphanumerics with ` +
          `optional interior hyphens (got '${value}').\n` +
          `[config]   gbrain sources default <id>   # preferred — validates and reports`,
        );
        process.exit(1);
      }
      // No .catch() here: a connection failure or SQL regression must NOT be
      // reported as "source is not registered". fetchSource already absorbs
      // the one expected legacy-column case; anything else is a real error and
      // should surface as itself.
      const { fetchSource } = await import('../core/sources-load.ts');
      const src = await fetchSource(engine, value);
      if (!src) {
        // NOTE: keep flag literals out of this message. The generated flag
        // registry (#2185) scans command sources for flag tokens, so naming a
        // flag in prose would silently grant it to `gbrain config`.
        console.error(
          `[config] source "${value}" is not registered; refusing to set sources.default.\n` +
          `[config]   gbrain sources list      # see registered sources\n` +
          `[config]   gbrain sources add       # register one first`,
        );
        process.exit(1);
      }
    }

    // v0.42.42.0 (#2139): validate spend.posture at set time so a typo
    // ('tokenMax', 'max') doesn't silently fall back to gated.
    if (key === 'spend.posture') {
      const { isValidSpendPosture } = await import('../core/spend-posture.ts');
      if (!isValidSpendPosture(value)) {
        console.error(
          `[config] spend.posture must be 'gated' or 'tokenmax' (got '${value}').\n` +
          `[config]   gbrain config set spend.posture tokenmax   # cost gates become informational\n` +
          `[config]   gbrain config set spend.posture gated       # default — gates enforce`,
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

    await engine.setConfig(key, value);
    // v0.36.x #892: redact sensitive values in confirmation output. API
    // keys / tokens / passwords are commonly set from terminals with
    // scrollback; echoing the raw value to stderr leaks the secret.
    console.log(`Set ${key} = ${redactConfigValue(key, value)}`);
    if (key === 'facts.default_visibility') await restampVisibilityPosture(value);

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
    console.error('Usage: gbrain config [show|get|set|unset] <key> [value]');
    console.error('       gbrain config unset --pattern <prefix>');
    process.exit(1);
  }
}
