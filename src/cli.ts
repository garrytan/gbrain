#!/usr/bin/env bun

import { installSigchldHandler } from './core/zombie-reap.ts';
installSigchldHandler();
// v0.41.6.0 D5: cleanup registry + signal handlers for SIGTERM/SIGHUP/SIGPIPE/
// uncaughtException. NOT SIGINT (the existing AbortController path at :254
// owns SIGINT). Installed at module load so locks acquired during boot
// (e.g. during connectEngine's schema-probe path) are covered too.
import { installSignalHandlers as installCleanupSignalHandlers } from './core/process-cleanup.ts';
installCleanupSignalHandlers();

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import {
  readUpdateCache,
  isCacheFresh,
  readSnooze,
  isSnoozeActive,
  resolveSelfUpgradeMode,
  justUpgradedPath,
} from './core/self-upgrade.ts';
import { loadConfig, loadConfigFileOnly, loadConfigWithEngine, toEngineConfig, isThinClient } from './core/config.ts';
import type { GBrainConfig } from './core/config.ts';
import type { AIGatewayConfig } from './core/ai/types.ts';
import type { BrainEngine } from './core/engine.ts';
import { operations, OperationError } from './core/operations.ts';
import { resolveSourceIdEngineFree } from './core/source-resolver.ts';
import { formatVolunteeredPage } from './core/context/volunteer.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { shouldForceExitAfterMain, finishCliTeardown, flushThenExit, currentExitCode, setCliExitVerdict } from './core/cli-force-exit.ts';
import { serializeMarkdown } from './core/markdown.ts';
import { parseGlobalFlags, setCliOptions, getCliOptions } from './core/cli-options.ts';
import type { CliOptions } from './core/cli-options.ts';
import { callRemoteTool, RemoteMcpError, unpackToolResult } from './core/mcp-client.ts';
import { maybePromptForUpgrade } from './core/thin-client-upgrade-prompt.ts';
import { VERSION } from './version.ts';

// Build CLI name -> operation lookup
const cliOps = new Map<string, Operation>();
for (const op of operations) {
  const name = op.cliHints?.name;
  if (name && !op.cliHints?.hidden) {
    cliOps.set(name, op);
  }
}

/**
 * JSON replacer: `bigint` → string, matching the postgres.js wire shape (int8
 * comes back as a string on the routed path). Lets the local-engine output
 * normalizer round-trip bigint columns (e.g. a `BIGSERIAL` `id`) instead of
 * throwing `TypeError: Do not know how to serialize a BigInt`.
 */
export function bigintToStringReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// CLI-only commands that bypass the operation layer
export const CLI_ONLY = new Set(['init', 'reinit-pglite', 'upgrade', 'post-upgrade', 'check-update', 'integrations', 'publish', 'check-backlinks', 'lint', 'report', 'import', 'export', 'files', 'embed', 'serve', 'call', 'config', 'doctor', 'migrate', 'eval', 'sync', 'extract', 'extract-conversation-facts', 'enrich', 'features', 'autopilot', 'graph-query', 'jobs', 'agent', 'apply-migrations', 'skillpack-check', 'skillpack', 'resolvers', 'integrity', 'repair-jsonb', 'orphans', 'maintain', 'sources', 'mounts', 'dream', 'check-resolvable', 'routing-eval', 'skillify', 'smoke-test', 'providers', 'storage', 'repos', 'code-def', 'code-refs', 'reindex', 'reindex-code', 'reindex-frontmatter', 'code-callers', 'code-callees', 'reconcile-links', 'frontmatter', 'auth', 'friction', 'claw-test', 'book-mirror', 'takes', 'think', 'salience', 'anomalies', 'calibration', 'transcripts', 'models', 'remote', 'recall', 'forget', 'edges-backfill', 'cache', 'ze-switch', 'founder', 'brainstorm', 'lsd', 'schema', 'capture', 'onboard', 'conversation-parser', 'status', 'connect', 'skillopt', 'quarantine', 'self-upgrade', 'advisor', 'watch', 'reindex-search-vector']);
// CLI-only commands whose handlers print their own --help text. These are
// excluded from the generic short-circuit so detailed per-command and
// per-subcommand usage stays reachable.
const CLI_ONLY_SELF_HELP = new Set([
  'upgrade', 'post-upgrade', 'check-update',
  'embed', 'config',
  'skillpack', 'skillpack-check',
  'integrations', 'friction',
  'frontmatter', 'check-resolvable',
  'models',
  'cache',
  'brainstorm', 'lsd',
  // v0.41.20.0 skillopt's detailed HELP constant lives in
  // src/core/skillopt/help.ts; --help routes there via the dispatcher.
  'skillopt',
  // v0.39.3.0 WARN-5: capture's detailed HELP constant
  // (src/commands/capture.ts:90+) was unreachable because the dispatcher's
  // generic short-circuit (printCliOnlyHelp at :204-208) fired before
  // runCapture saw --help. brainstorm + lsd were already in the set;
  // capture was the holdout.
  'capture',
  // v0.42 self-upgrade ships its own usage (flags + the agent-skill story).
  'self-upgrade',
  // maintain (#3015) prints its own usage block (modes + not-auto-applied list).
  'maintain',
  // v0.43 (#2095): watch ships WATCH_HELP (flags + the stdin-turn protocol).
  'watch',
  // v0.37 fix wave (Lane D.4 + CDX2-12): sync's --no-embed flag was
  // unreachable via help because the dispatcher's generic CLI-only
  // short-circuit fired before runSync could print its own usage block.
  // Adding `sync` here routes `gbrain sync --help` into runSync.
  'sync',
  // v0.37 fix wave (deferred TODO, shipped): reinit-pglite has its
  // own --help in runReinitPglite. Routing through SELF_HELP avoids
  // the generic short-circuit so the destructive-action warning text
  // reaches the user.
  'reinit-pglite',
  // v0.40.6.0 Schema Cathedral v3 — `gbrain schema --help` should hit
  // schema.ts printHelp() with the full 22+ verb taxonomy, not the
  // generic short-circuit's one-line stub.
  'schema',
  // v0.41.11.0 — extract-conversation-facts ships its own detailed HELP
  // describing segment splitting + checkpointing + budget caps + the
  // unified types config story. Route around the generic short-circuit.
  'extract-conversation-facts',
  // v0.41.39 (#1700) — enrich ships its own detailed HELP (ordering, budget
  // best-effort caveat, provenance, --reenrich-after). Route around the stub.
  'enrich',
  // `gbrain connect --help` prints its own usage (flags + examples) from
  // runConnect; route around the generic one-line short-circuit.
  'connect',
]);

// v114 (#1941): alias -> operation lookup, kept separate from `cliOps` so
// aliases don't double-list in printHelp's auto-generated section. Collisions
// with a primary CLI name, a CLI_ONLY command, or another alias throw at module
// load — a silent route-shadow is worse than a loud boot failure. Placed after
// CLI_ONLY so the collision check can see it.
export const cliAliases = new Map<string, Operation>();
for (const op of operations) {
  if (op.cliHints?.hidden) continue;
  for (const alias of op.cliHints?.aliases ?? []) {
    if (cliOps.has(alias) || CLI_ONLY.has(alias) || cliAliases.has(alias)) {
      throw new Error(
        `CLI alias collision: '${alias}' (op '${op.name}') conflicts with an existing ` +
        `command or alias. Rename the alias in src/core/operations.ts.`,
      );
    }
    cliAliases.set(alias, op);
  }
}

// v0.42 self-upgrade: commands that must NOT trigger the startup update-check
// (they ARE the update path, or are trivial/no-DB) and which set
// GBRAIN_SKIP_STARTUP_HOOKS for any children they spawn.
const STARTUP_HOOK_SKIP_COMMANDS = new Set([
  'upgrade', 'post-upgrade', 'check-update', 'self-upgrade',
]);

/**
 * Emit the self-upgrade marker on the hot path. CACHE-READ-ONLY: a statSync +
 * read, sub-ms. On a stale/missing cache it kicks a DETACHED, single-flighted
 * `gbrain check-update --refresh-cache` and emits nothing this run. NEVER
 * blocks a command and NEVER throws (the marker must not break any command).
 * Mode resolution is file-plane only (no DB; thin clients have no local DB).
 */
function maybeEmitUpdateMarker(command: string): void {
  try {
    if (process.env.GBRAIN_SKIP_STARTUP_HOOKS) return;
    // Never run during the test suite: tests spawn the CLI hundreds of times,
    // each with a fresh (stale-cache) GBRAIN_HOME, which would otherwise fire a
    // detached `gbrain check-update --refresh-cache` per invocation and saturate
    // the machine with real network calls. Bun sets NODE_ENV=test.
    if (process.env.NODE_ENV === 'test') return;
    if (STARTUP_HOOK_SKIP_COMMANDS.has(command)) {
      // We ARE the update path — skip self-check AND mark children so any
      // `gbrain post-upgrade` / `gbrain features` they spawn don't re-enter.
      process.env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
      return;
    }
    if (getCliOptions().quiet) return;

    // JUST_UPGRADED: one-time confirmation after an upgrade (any mode).
    try {
      const jpath = justUpgradedPath();
      if (existsSync(jpath)) {
        const from = String(readFileSync(jpath, 'utf8')).trim();
        if (from) process.stderr.write(`JUST_UPGRADED ${from} ${VERSION}\n`);
        unlinkSync(jpath);
      }
    } catch {
      /* ignore */
    }

    const cfg = loadConfigFileOnly();
    const mode = resolveSelfUpgradeMode(cfg);
    if (mode === 'off') return;

    const now = Date.now();
    const entry = readUpdateCache();
    if (entry && isCacheFresh(entry, now)) {
      if (entry.marker.kind === 'upgrade_available' && entry.marker.latest) {
        // notify mode honors a per-version snooze; auto mode ignores it.
        if (mode === 'notify' && isSnoozeActive(readSnooze(), entry.marker.latest, now)) return;
        process.stderr.write(`UPGRADE_AVAILABLE ${entry.marker.current} ${entry.marker.latest}\n`);
        process.stderr.write(
          `gbrain ${entry.marker.current} -> ${entry.marker.latest} available. Run: gbrain self-upgrade\n`,
        );
      }
      return;
    }

    // Stale/missing cache → kick a detached, single-flighted refresh. The child
    // (`check-update --refresh-cache`) single-flights via the refresh lock and
    // writes the cache for the NEXT invocation. We never wait on it.
    try {
      const child = spawn('gbrain', ['check-update', '--refresh-cache'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
      });
      // ChildProcess is an EventEmitter — an unhandled 'error' (e.g. ENOENT when
      // gbrain isn't on PATH) would throw uncaught. Swallow it; the refresh is
      // best-effort.
      child.on('error', () => {});
      child.unref();
    } catch {
      /* gbrain not on PATH / spawn failed — fail-open, no refresh this run */
    }
  } catch {
    /* the update marker must never break a command */
  }
}

async function main() {
  // Parse global flags (--quiet / --progress-json / --progress-interval)
  // BEFORE command dispatch, so `gbrain --progress-json doctor` works.
  // The stripped argv is what the command sees.
  const rawArgs = process.argv.slice(2);
  const { cliOpts, rest: args } = parseGlobalFlags(rawArgs);
  setCliOptions(cliOpts);

  let command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(`gbrain ${VERSION}`);
    return;
  }

  if (command === '--tools-json') {
    const { printToolsJson } = await import('./commands/tools-json.ts');
    printToolsJson();
    return;
  }

  // v0.42 self-upgrade: ride this invocation as an update heartbeat. Cache-read-
  // only, fail-open, never blocks. Skips the update path's own commands + sets
  // GBRAIN_SKIP_STARTUP_HOOKS for their children. Runs for every real command.
  maybeEmitUpdateMarker(command);

  const subArgs = args.slice(1);

  // DX alias: `ask` is a natural-language alias for `query`
  if (command === 'ask') {
    command = 'query';
  }

  // Local patch 2026-06-11 — mark one-shot CLI processes so the facts
  // backstop routes absorb work to the durable jobs worker instead of the
  // in-process queue that the exit teardown drains-then-aborts after ~1-2s
  // (the `pipeline_error: [chat(...)] The operation was aborted.` class in
  // ingest_log). Daemons keep the in-process queue: their event loop
  // outlives the work. See src/core/facts/cli-process-mode.ts.
  if (!['serve', 'jobs', 'autopilot'].includes(command)) {
    const { markShortLivedCliProcess } = await import('./core/facts/cli-process-mode.ts');
    markShortLivedCliProcess();
  }

  // T5 — `gbrain search modes|stats|tune` is the read-only config dashboard,
  // NOT a free-text search for the literal word "modes". Free-text
  // `gbrain search "<query>"` falls through to the cheap-hybrid `search` op
  // below (T4). Preserves the v0.41.6.0 read-only connect+dispatch timeout.
  if (command === 'search' && ['modes', 'stats', 'tune', 'diagnose'].includes(subArgs[0] ?? '')) {
    const { withTimeout, OperationTimeoutError } = await import('./core/timeout.ts');
    const isDiagnose = subArgs[0] === 'diagnose';
    const label = 'gbrain search';
    // diagnose runs real retrieval (keyword + vector + hybrid) so it gets a
    // longer deadline than the read-only dashboard.
    const timeoutMs = isDiagnose ? 60_000 : 10_000;
    let engine: BrainEngine;
    try {
      engine = await withTimeout(connectEngine(), timeoutMs, `${label}: connect`);
    } catch (e) {
      if (e instanceof OperationTimeoutError) { console.error(`${e.label} timed out.`); process.exit(124); }
      throw e;
    }
    try {
      if (isDiagnose) {
        const { runSearchDiagnose } = await import('./commands/search-diagnose.ts');
        await withTimeout(runSearchDiagnose(engine, subArgs), timeoutMs, label);
      } else {
        const { runSearch } = await import('./commands/search.ts');
        await withTimeout(runSearch(engine, subArgs), timeoutMs, label);
      }
    } finally {
      // #2084: `search diagnose` runs real hybrid retrieval (arms search-cache
      // writes) — route through the shared bounded teardown like every other
      // one-shot path. The connect-timeout process.exit(124) above is reviewed
      // and intentionally unchanged: no engine exists at that point.
      await finishCliTeardown({ engine });
    }
    return;
  }

  // Per-command --help
  if (hasHelpFlag(subArgs)) {
    const op = cliOps.get(command) ?? cliAliases.get(command);
    if (op) {
      printOpHelp(op, command);
      return;
    }
    if (CLI_ONLY.has(command) && !CLI_ONLY_SELF_HELP.has(command)) {
      printCliOnlyHelp(command);
      return;
    }
  }

  // DB-free durability pull (v0.42.44 D2): the harden cron calls
  // `gbrain sources pull --path <dir>` every ~30 min. It must NOT open PGLite
  // (a live long-lived session holds the single-writer lock), so handle it
  // BEFORE connectEngine. The `sources pull <id>` form (no --path) still routes
  // through handleCliOnly → runSources with an engine.
  if (command === 'sources' && subArgs[0] === 'pull' && subArgs.includes('--path')) {
    const { runPull } = await import('./commands/sources-harden.ts');
    await runPull(null, subArgs.slice(1));
    return;
  }

  // CLI-only commands
  if (CLI_ONLY.has(command)) {
    await handleCliOnly(command, subArgs);
    return;
  }

  // Shared operations (fall through to aliases, e.g. link-add -> add_link)
  const op = cliOps.get(command) ?? cliAliases.get(command);
  if (!op) {
    console.error(`Unknown command: ${command}`);
    console.error('Run gbrain --help for available commands.');
    process.exit(1);
  }

  // v0.31.1 (Issue #734, CDX-1): parse CLI args BEFORE engine connect so
  // the routing seam below can decide local-vs-remote without paying a
  // PGLite migration replay on thin-client installs. The arg parser, image
  // transform, and required-param check are all engine-free; refactoring
  // them out of the engine try/catch is safe and unlocks routing.
  const params = parseOpArgs(op, subArgs);

  // v0.27.1 (`gbrain query --image <path>`): swap the `image` param from
  // a filesystem path into base64 bytes + mime. The op accepts base64; the
  // CLI accepts a path. Helper is exported so tests can exercise the
  // transform without spawning a subprocess.
  if (op.name === 'query' && typeof params.image === 'string' && params.image.length > 0) {
    try {
      const { path, base64, mime } = resolveQueryImage(
        params.image as string,
        (params.image_mime as string) || undefined,
      );
      params.image = base64;
      params.image_mime = mime;
      void path;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // Validate required params before calling handler. v0.27.1: the
  // `query` op's positional `query` is required only when --image is
  // NOT supplied. The runtime altRequired check below overrides the
  // generic required-flag check for that op.
  const queryHasAlt = op.name === 'query' && typeof params.image === 'string' && params.image.length > 0;
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && params[key] === undefined) {
      if (queryHasAlt && key === 'query') continue;
      const cliName = op.cliHints?.name || op.name;
      const positional = op.cliHints?.positional || [];
      const usage = positional.map(p => `<${p}>`).join(' ');
      console.error(`Usage: gbrain ${cliName} ${usage}`);
      process.exit(1);
    }
  }

  // v0.31.1 (Issue #734, CDX-1 routing seam): on thin-client installs,
  // route every non-localOnly op through callRemoteTool instead of opening
  // the empty local PGLite. localOnly ops can't run on a thin client at all
  // (no local engine, server intentionally hides them) — refuse with hint.
  // Fix for the silent-empty-results bug class that motivated this whole release.
  const cfgPre = loadConfig();
  if (isThinClient(cfgPre)) {
    if (op.localOnly) {
      refuseThinClient(command, cfgPre!.remote_mcp!.mcp_url);
    }
    // #2098: the local path resolves --source / GBRAIN_SOURCE / .gbrain-source
    // inside makeContext (ctx.sourceId), which this route never reaches — so
    // scope must be mapped onto the op's source_id wire param before the call.
    try {
      applyThinClientSourceScope(op, params);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    await runThinClientRouted(op, params, cfgPre!, cliOpts);
    return;
  }

  // Local engine path (unchanged behavior for local installs).
  const engine = await connectEngine();
  // #2084: the teardown contract (bounded drain of every background-work sink,
  // bounded disconnect, computed-deadline backstop) lives in finishCliTeardown
  // — see src/core/cli-force-exit.ts for the full design. The hard-deadline
  // timer arms at TEARDOWN start inside the helper, never before the handler:
  // the pre-#2084 placement here measured handler + teardown combined, so a
  // slow-but-healthy query burned the teardown budget (the flat-10s-banner
  // bug) and any >10s op was force-killed mid-run with exit 0. The explicit
  // process exit happens once, in the import.meta.main seam at the bottom of
  // this file — NOT here.

  // v0.42.41.0 (merged): wallclock bound for READ-scope op handlers. With the
  // teardown backstop correctly scoped to teardown, a genuinely WEDGED read
  // handler (hung pooler connection mid-query) would otherwise hang the CLI
  // forever — the #1633 zombie class the old pre-try timer accidentally
  // bounded at 10s. 180s sits far above any healthy slow-pooler run
  // (6-10s/connection); --timeout=Ns overrides. Writes/admin stay unbounded:
  // a long import/embed must never be killed by a default deadline. On
  // timeout the abandoned handler may hold ref'd sockets — harmless here,
  // because the import.meta.main seam exits explicitly on every one-shot path.
  const READ_OP_TIMEOUT_MS = 180_000;

  try {
    const { withTimeout, OperationTimeoutError } = await import('./core/timeout.ts');
    const wallclockMs = getCliOptions().timeoutMs ?? READ_OP_TIMEOUT_MS;
    const onWallclockTimeout = (e: InstanceType<typeof OperationTimeoutError>) => {
      const hint = getCliOptions().timeoutMs
        ? ''
        : ` (default ${e.ms}ms; pass --timeout=Ns to override)`;
      console.error(`${e.label} timed out${hint}.`);
      // 124 = timeout convention (matches the read-only dispatch path). Set
      // through the verdict channel — a raw process.exitCode write is invisible
      // to the exit seam and PGLite's WASM runtime can scribble over it.
      setCliExitVerdict(124);
    };

    // Context build does DB I/O (resolveSourceId) and runs for EVERY op —
    // a wedged pooler connection here would otherwise hang reads, writes,
    // and admin alike with no bound at all (adversarial review finding).
    let ctx: Awaited<ReturnType<typeof makeContext>>;
    try {
      ctx = await withTimeout(
        makeContext(engine, params),
        wallclockMs,
        `gbrain ${command}: context`,
      );
    } catch (e: unknown) {
      if (e instanceof OperationTimeoutError) {
        onWallclockTimeout(e);
        return; // the finally drains + disconnects; the import.meta.main seam exits
      }
      throw e;
    }

    let rawResult: unknown;
    if (op.scope === 'read') {
      try {
        rawResult = await withTimeout(
          op.handler(ctx, params),
          wallclockMs,
          `gbrain ${command}`,
        );
      } catch (e: unknown) {
        if (e instanceof OperationTimeoutError) {
          onWallclockTimeout(e);
          return; // the finally drains + disconnects; the import.meta.main seam exits
        }
        throw e;
      }
    } else {
      rawResult = await op.handler(ctx, params);
    }
    // ENG-2 (renderer parity by data shape): JSON-round-trip the local-engine
    // path's return value so renderers see the same shape they'd see on the
    // routed path. Date → ISO string; bigint → string (postgres.js shape);
    // Buffer → object. Microsecond-cost; eliminates a whole drift bug class.
    const result = JSON.parse(JSON.stringify(rawResult, bigintToStringReplacer));
    const output = formatResult(op.name, result);
    if (output) process.stdout.write(output);
  } catch (e: unknown) {
    // v0.42.20.0 (codex D4): on error, set exitCode + return so the `finally`
    // STILL runs (drains every background-work sink + disconnects). A bare
    // process.exit(1) here would skip the finally → skip the drain + disconnect
    // (leaves facts/cache/eval-capture writes racing teardown). The finally's
    // drain bounds teardown; the hard-deadline timer armed at teardown entry
    // bounds a hung one.
    if (e instanceof OperationError) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.suggestion) console.error(`  Fix: ${e.suggestion}`);
    } else {
      console.error(e instanceof Error ? e.message : String(e));
    }
    setCliExitVerdict(1);
  } finally {
    // 1s per-sink drain budget: read paths with no pending work pay the ~0ms
    // fast path; capture/import that DO enqueue pay up to 1s (+ facts shutdown
    // grace) while in-flight Haiku finishes (#1762 drain-before-disconnect).
    await finishCliTeardown({ engine, drainTimeoutMs: 1000 });
  }
}


function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function printCliOnlyHelp(command: string) {
  console.log(`Usage: gbrain ${command}`);
  console.log('');
  console.log(`gbrain ${command} - run gbrain --help for the full command list.`);
}

/**
 * v0.31.1 (Issue #734, CDX-1): route a shared op through the remote MCP
 * server instead of running it locally. Called from main() when
 * `isThinClient(cfg) && !op.localOnly`.
 *
 * Timeout policy (ENG-4): user override via --timeout=Ns wins; otherwise
 * 180s for `think` (LLM calls), 30s for everything else.
 *
 * Error policy (CDX-4): callRemoteTool's hardening pass guarantees every
 * thrown value reaches us as a RemoteMcpError. The switch below is
 * exhaustively typed (TS `never` check); adding a new reason variant fails
 * compilation until this dispatcher knows what to render.
 *
 * Renderer policy: the MCP tool result is unpacked via unpackToolResult
 * (which JSON.parses the text content) and handed to the SAME formatResult
 * the local-engine path uses. Renderer parity is enforced by data shape,
 * not by per-command audit.
 */
async function runThinClientRouted(
  op: Operation,
  params: Record<string, unknown>,
  cfg: GBrainConfig,
  cliOpts: CliOptions,
): Promise<void> {
  // ENG-4: per-op timeout default; user override wins.
  const defaultTimeoutMs = op.name === 'think' ? 180_000 : 30_000;
  const timeoutMs = cliOpts.timeoutMs ?? defaultTimeoutMs;

  // SIGINT support: aborts in-flight HTTP cleanly (exit 130 is the standard
  // SIGINT exit code; our error switch maps `network/aborted` to that).
  const sigintController = new AbortController();
  const onSigint = () => {
    sigintController.abort(new Error('SIGINT'));
  };
  process.on('SIGINT', onSigint);

  // v0.31.1 (Issue #734, cherry-pick B): print identity banner to stderr
  // BEFORE the routed call. Banner failure suppresses the banner only —
  // never the underlying command. Suppression honors --quiet, non-TTY,
  // and GBRAIN_NO_BANNER=1.
  await printIdentityBannerBestEffort(cfg, cliOpts, sigintController.signal);

  try {
    const raw = await callRemoteTool(cfg, op.name, params, {
      timeoutMs,
      signal: sigintController.signal,
    });
    const result = unpackToolResult(raw);
    const output = formatResult(op.name, result);
    if (output) process.stdout.write(output);
  } catch (e: unknown) {
    if (e instanceof RemoteMcpError) {
      const url = cfg.remote_mcp!.mcp_url;
      switch (e.reason) {
        case 'config':
          console.error(e.message);
          break;
        case 'discovery':
          console.error(`OAuth discovery failed at ${cfg.remote_mcp!.issuer_url}.`);
          console.error('Run `gbrain remote doctor` for details.');
          break;
        case 'auth':
          console.error('OAuth auth failed.');
          console.error('On the host, re-register your client:');
          console.error('  gbrain auth register-client <name> --grant-types client_credentials --scopes read,write,admin');
          break;
        case 'auth_after_refresh':
          console.error('OAuth auth failed after token refresh. Credentials may have been revoked.');
          console.error('Run `gbrain remote doctor` to confirm.');
          break;
        case 'network':
          if (e.detail?.kind === 'timeout') {
            const hint = cliOpts.timeoutMs ? '' : ` (default ${defaultTimeoutMs}ms; pass --timeout=Ns to override)`;
            console.error(`Request to ${url} timed out${hint}.`);
          } else if (e.detail?.kind === 'aborted') {
            console.error('Request aborted.');
            process.off('SIGINT', onSigint);
            process.exit(130);
          } else {
            console.error(`Cannot reach ${url}. Run \`gbrain remote doctor\` for details.`);
          }
          break;
        case 'tool_error':
          if (e.detail?.code === 'missing_scope') {
            console.error('Missing OAuth scope on this client.');
            console.error('On the host, re-register the client with broader scopes:');
            console.error('  gbrain auth register-client <name> --grant-types client_credentials --scopes read,write,admin');
          } else {
            console.error(e.message);
            console.error('Run `gbrain remote doctor` if this persists.');
          }
          break;
        case 'parse':
          console.error('Server response was malformed. Run `gbrain remote doctor`.');
          break;
        default: {
          // Exhaustive switch sentinel (TS `never` — fails to build if a
          // new RemoteMcpErrorReason variant is added without a case).
          const _exhaustive: never = e.reason;
          void _exhaustive;
          console.error(`Unhandled remote error: ${e.message}`);
        }
      }
      process.off('SIGINT', onSigint);
      process.exit(1);
    }
    // Defense in depth: callRemoteTool's contract is that everything is
    // RemoteMcpError. If a plain Error escapes, render it generically and
    // exit 1 — but this should never happen post-CDX-4.
    console.error(e instanceof Error ? e.message : String(e));
    process.off('SIGINT', onSigint);
    process.exit(1);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

// ============================================================================
// v0.31.1 (Issue #734, cherry-pick B): thin-client identity banner.
//
// Prints "[thin-client → <host> · brain: 102k pages, 265k chunks · vX.Y.Z]"
// to stderr before each routed command, so users (and agents) know they're
// talking to a real remote brain — not the empty local PGLite that motivated
// this whole release.
//
// Cache: 60s TTL, in-memory Map keyed by mcp_url. Cross-process file cache
// is deferred (marginal benefit; one mint per CLI process is fine).
// Suppression: --quiet, non-TTY, GBRAIN_NO_BANNER=1.
// Failure mode: any error in fetching identity → suppress banner; underlying
// command runs normally. Banner is observability, not load-bearing.
// ============================================================================

export interface BrainIdentity {
  version: string;
  engine: 'postgres' | 'pglite';
  page_count: number;
  chunk_count: number;
  last_sync_iso: string | null;
}

interface CachedIdentity {
  identity: BrainIdentity;
  cached_at_ms: number;
}

const IDENTITY_TTL_MS = 60_000;
const identityCache = new Map<string, CachedIdentity>();

/** Test-only escape hatch — clears the in-memory cache between test runs. */
export function _clearIdentityCacheForTest(): void {
  identityCache.clear();
}

export function bannerSuppressed(cliOpts: CliOptions): boolean {
  if (cliOpts.quiet) return true;
  if (process.env.GBRAIN_NO_BANNER === '1') return true;
  // Non-TTY default is suppressed (clean pipes); explicit env-flag overrides.
  if (!process.stderr.isTTY && process.env.GBRAIN_BANNER !== '1') return true;
  return false;
}

function formatPageCount(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(n >= 100_000 ? 0 : 1);
    return `${k}k`;
  }
  return String(n);
}

function formatBanner(mcpUrl: string, id: BrainIdentity): string {
  const host = mcpUrl.replace(/^https?:\/\//, '').split('/')[0];
  const counts = `brain: ${formatPageCount(id.page_count)} pages, ${formatPageCount(id.chunk_count)} chunks`;
  return `[thin-client → ${host} · ${counts} · v${id.version}]`;
}

async function fetchIdentity(
  cfg: GBrainConfig,
  signal: AbortSignal,
): Promise<BrainIdentity> {
  // 2s timeout for the banner fetch — must not delay the underlying command.
  const raw = await callRemoteTool(cfg, 'get_brain_identity', {}, {
    timeoutMs: 2000,
    signal,
  });
  const id = unpackToolResult<BrainIdentity>(raw);
  return id;
}

async function printIdentityBannerBestEffort(
  cfg: GBrainConfig,
  cliOpts: CliOptions,
  signal: AbortSignal,
): Promise<void> {
  if (bannerSuppressed(cliOpts)) return;
  const mcpUrl = cfg.remote_mcp?.mcp_url;
  if (!mcpUrl) return;

  // Cache lookup keyed by mcp_url so switching hosts via `gbrain init`
  // invalidates cleanly even within a long-lived process.
  const cached = identityCache.get(mcpUrl);
  if (cached && Date.now() - cached.cached_at_ms < IDENTITY_TTL_MS) {
    process.stderr.write(formatBanner(mcpUrl, cached.identity) + '\n');
    // v0.31.11: detect remote-version drift, prompt user to upgrade.
    // bannerIsSuppressed=false here — the early return above guaranteed it.
    await maybePromptForUpgrade(cfg, cached.identity, cliOpts, false);
    return;
  }

  // Cache miss — fetch. Failure is non-fatal: banner is observability,
  // never load-bearing for the underlying command.
  try {
    const id = await fetchIdentity(cfg, signal);
    identityCache.set(mcpUrl, { identity: id, cached_at_ms: Date.now() });
    process.stderr.write(formatBanner(mcpUrl, id) + '\n');
    // v0.31.11: detect remote-version drift, prompt user to upgrade.
    await maybePromptForUpgrade(cfg, id, cliOpts, false);
  } catch {
    // Swallow. Banner suppressed; main command continues. The CDX-4
    // hardened callRemoteTool will surface the same error class on the
    // actual command call if the host is genuinely unreachable.
  }
}

/**
 * v0.27.1: shared transform for `gbrain query --image <path>` (and any future
 * CLI surface that takes an image path). Reads the file, base64-encodes,
 * derives MIME from the extension, enforces the 20MB cap. Exported so tests
 * can verify the transform without spawning a subprocess.
 *
 * Throws Error on any failure (file missing, oversized, etc.). Caller is
 * responsible for routing to process.exit(1) with a user-facing message.
 */
export function resolveQueryImage(
  imagePath: string,
  explicitMime?: string,
): { path: string; base64: string; mime: string } {
  const bytes = readFileSync(imagePath);
  if (bytes.length > 20 * 1024 * 1024) {
    throw new Error(`Error: image too large (${bytes.length} bytes, max 20MB).`);
  }
  const base64 = bytes.toString('base64');
  let mime = explicitMime;
  if (!mime) {
    const lower = imagePath.toLowerCase();
    const mimeFromExt: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.heic': 'image/heic', '.heif': 'image/heif',
      '.avif': 'image/avif',
    };
    const ext = Object.keys(mimeFromExt).find(e => lower.endsWith(e));
    mime = ext ? mimeFromExt[ext] : 'image/jpeg';
  }
  return { path: imagePath, base64, mime };
}

export function parseOpArgs(op: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.cliHints?.positional || [];
  let posIdx = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (arg.startsWith('--no-')) {
        const positiveKey = arg.slice(5).replace(/-/g, '_');
        const positiveDef = op.params[positiveKey];
        if (positiveDef?.type === 'boolean') {
          params[positiveKey] = false;
          continue;
        }
      }
      const key = arg.slice(2).replace(/-/g, '_');
      const paramDef = op.params[key];
      if (paramDef?.type === 'boolean') {
        params[key] = true;
      } else if (i + 1 < args.length) {
        params[key] = args[++i];
        if (paramDef?.type === 'number') params[key] = Number(params[key]);
      }
    } else if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = paramDef?.type === 'number' ? Number(arg) : arg;
    }
  }

  // Read stdin for content params
  if (op.cliHints?.stdin && !params[op.cliHints.stdin] && !process.stdin.isTTY) {
    const stdinContent = readFileSync(0, 'utf-8');
    const MAX_STDIN = 5_000_000; // 5MB
    if (Buffer.byteLength(stdinContent, 'utf-8') > MAX_STDIN) {
      console.error(`Error: stdin content exceeds ${MAX_STDIN} bytes. Split into smaller inputs.`);
      process.exit(1);
    }
    params[op.cliHints.stdin] = stdinContent;
  }

  return params;
}

/**
 * #2098: thin-client source scoping. Locally, --source / GBRAIN_SOURCE /
 * .gbrain-source resolve to ctx.sourceId in makeContext; the thin-client
 * route short-circuits before that, so `gbrain query --source X` against a
 * remote brain silently searched unscoped. This runs the engine-free tiers
 * (flag → env → dotfile; the DB-backed tiers can't run without an engine —
 * the server's grant scoping covers the rest) and maps the result onto the
 * op's `source_id` wire param.
 *
 * Ops that declare their OWN `source` param (facts add, etc.) are left
 * untouched — their --source is an op param, not scope. An explicit --source
 * on an op with no source_id wire param throws (loud beats silent drop);
 * ambient env/dotfile scope with nowhere to send it is ignored, matching the
 * pre-fix behavior for non-scopeable ops. Exported for tests.
 */
// Ops whose `source_id` wire param is NOT read-scope semantics: get_skill's
// source_id flips the lookup from host catalog to brain-resident-pack
// (getResidentSkillDetail). Ambient env/dotfile scope must never leak into
// these; an explicit --source-id still passes through untouched above.
const NON_SCOPE_SOURCE_ID_OPS = new Set(['get_skill']);

export function applyThinClientSourceScope(
  op: Operation,
  params: Record<string, unknown>,
  cwd?: string,
): void {
  if ('source' in op.params) return; // the op owns --source; not a scope flag
  const explicit = typeof params.source === 'string' && params.source.length > 0
    ? (params.source as string)
    : null;
  delete params.source; // never a wire param on these ops — don't leak it
  // Explicit per-call scope already on the wire wins over ambient tiers.
  if (params.source_id !== undefined || params.all_sources === true) {
    if (explicit) {
      throw new Error('Pass either --source or --source-id/--all-sources, not both.');
    }
    return;
  }
  const resolved = resolveSourceIdEngineFree(explicit, cwd);
  if (!resolved) return;
  if (!('source_id' in op.params) || NON_SCOPE_SOURCE_ID_OPS.has(op.name)) {
    if (explicit) {
      const hint = NON_SCOPE_SOURCE_ID_OPS.has(op.name)
        ? `(its source_id parameter is not a scope filter; pass --source-id explicitly if you mean it)`
        : `(the remote op has no source_id parameter; the server scopes it to your grant)`;
      throw new Error(
        `gbrain ${op.cliHints?.name || op.name} does not accept --source on a thin-client install ${hint}.`,
      );
    }
    return; // ambient env/dotfile scope with nowhere to send it
  }
  params.source_id = resolved;
}

async function makeContext(engine: BrainEngine, params: Record<string, unknown>): Promise<OperationContext> {
  // v0.31.8 (D11): resolve sourceId via the canonical 6-tier chain. Honors
  // --source / GBRAIN_SOURCE / .gbrain-source / path-match / brain default /
  // 'default'. Wrapped in try/catch so a doctor / single-source brain that
  // never set up sources still returns 'default' silently.
  let sourceId: string | undefined;
  // #2561: when the source resolved via a NON-explicit tier (path-match /
  // brain default / sole-non-default / seed default), unqualified search-shaped
  // reads span every `config.federated = true` source. Computed here (the
  // trusted local boundary) and consumed by federatedSearchScope in
  // operations.ts, which additionally gates on ctx.remote === false.
  let localFederated: string[] | undefined;
  try {
    const { resolveSourceWithTier, localFederatedSourceIds } = await import('./core/source-resolver.ts');
    // params.source is set when a CLI flag was parsed for the op (rare; most
    // CLI ops don't take --source). Falls through to env/dotfile/path-match.
    const explicit = (params.source as string | undefined) ?? null;
    const resolved = await resolveSourceWithTier(engine, explicit);
    sourceId = resolved.source_id;
    localFederated = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
  } catch {
    // Source resolution failed (e.g. sources table doesn't exist on a fresh
    // pre-init brain). Leave sourceId unset; engine read methods fall through
    // to the cross-source view (D16 back-compat path).
    sourceId = undefined;
  }
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
    // Local CLI invocation — the user owns the machine; do not apply remote-caller
    // confinement (e.g., cwd-locked file_upload).
    remote: false,
    cliOpts: getCliOptions(),
    // v0.34 D4: sourceId is REQUIRED at the type level. Fall back to 'default'
    // when resolveSourceId returned undefined (fresh pre-init brain, no sources
    // table). Matches dispatch.ts's auto-fill so the contract holds across
    // every transport.
    sourceId: sourceId ?? 'default',
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
  };
}

// Exported for tests (same import-safety contract as cliAliases/printOpHelp).
export function formatResult(opName: string, result: unknown): string {
  switch (opName) {
    case 'volunteer_context': {
      const r = result as any;
      // Stats mode (the feedback loop).
      if (r && r.approximate === true && Array.isArray(r.by_arm)) {
        const lines = [
          `volunteered-context precision — last ${r.days} day(s) (${r.note})`,
          `total: ${r.total_volunteered} volunteered, ${r.total_used} used`,
        ];
        for (const a of r.by_arm) {
          lines.push(`  ${a.match_arm}/${a.channel}: ${a.used}/${a.volunteered} used (precision ${a.precision})`);
        }
        if (!r.by_arm.length) lines.push('  (no volunteer events in the window)');
        return lines.join('\n') + '\n';
      }
      const pages = (r?.pages ?? []) as any[];
      if (!pages.length) return 'Nothing volunteered (no entity cleared the confidence gate).\n';
      return pages.map((p) => formatVolunteeredPage(p)).join('\n') + '\n';
    }
    case 'get_page': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', {
        type: r.type, title: r.title, tags: r.tags || [],
      });
    }
    case 'list_pages': {
      const pages = result as any[];
      if (pages.length === 0) return 'No pages found.\n';
      return pages.map(p =>
        `${p.slug}\t${p.type}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`,
      ).join('\n') + '\n';
    }
    case 'search':
    case 'query': {
      const results = result as any[];
      if (results.length === 0) return 'No results.\n';
      // v0.40.4 — --explain switches to per-stage attribution formatter.
      // Reads CliOptions.explain via the module-level singleton.
      const cliOpts = getCliOptions();
      if (cliOpts.explain) {
        // Lazy import keeps formatResult's startup hot path narrow for
        // the common non-explain case.
        const { formatResultsExplain } = require('./core/search/explain-formatter.ts');
        return formatResultsExplain(results);
      }
      return results.map(r =>
        `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_tags': {
      const tags = result as string[];
      return tags.length > 0 ? tags.join(', ') + '\n' : 'No tags.\n';
    }
    case 'get_stats': {
      const s = result as any;
      const lines = [
        `Pages:     ${s.page_count}`,
        `Chunks:    ${s.chunk_count}`,
        `Embedded:  ${s.embedded_count}`,
        `Links:     ${s.link_count}`,
        `Tags:      ${s.tag_count}`,
        `Timeline:  ${s.timeline_entry_count}`,
      ];
      if (s.pages_by_type) {
        lines.push('', 'By type:');
        for (const [k, v] of Object.entries(s.pages_by_type)) {
          lines.push(`  ${k}: ${v}`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_health': {
      const h = result as any;
      // Health score weights: missing_embeddings is the heaviest (2 pts), other
      // graph quality issues are 1 pt each. link_coverage / timeline_coverage below
      // 50% on entity pages indicates the graph needs population.
      const score = Math.max(0, 10
        - (h.missing_embeddings > 0 ? 2 : 0)
        - (h.stale_pages > 0 ? 1 : 0)
        - (h.orphan_pages > 0 ? 1 : 0)
        - ((h.link_coverage ?? 1) < 0.5 ? 1 : 0)
        - ((h.timeline_coverage ?? 1) < 0.5 ? 1 : 0));
      const lines = [
        `Health score: ${score}/10`,
        `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
        `Missing embeddings: ${h.missing_embeddings}`,
        `Stale pages: ${h.stale_pages}`,
        `Orphan pages: ${h.orphan_pages}`,
      ];
      if (h.link_coverage !== undefined) {
        lines.push(`Link coverage (entities): ${(h.link_coverage * 100).toFixed(1)}%`);
      }
      if (h.timeline_coverage !== undefined) {
        lines.push(`Timeline coverage (entity pages): ${(h.timeline_coverage * 100).toFixed(1)}%`);
      }
      if (h.timeline_coverage_score !== undefined) {
        lines.push(`Timeline density (all pages): ${h.timeline_coverage_score}/15 (whole-brain brain-score component)`);
      }
      if (Array.isArray(h.most_connected) && h.most_connected.length > 0) {
        lines.push('Most connected entities:');
        for (const e of h.most_connected) {
          lines.push(`  ${e.slug}: ${e.link_count} links`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_timeline': {
      const entries = result as any[];
      if (entries.length === 0) return 'No timeline entries.\n';
      return entries.map(e =>
        `${e.date}  ${e.summary}${e.source ? ` [${e.source}]` : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_versions': {
      const versions = result as any[];
      if (versions.length === 0) return 'No versions.\n';
      return versions.map(v =>
        `#${v.id}  ${v.snapshot_at?.toString().slice(0, 19) || '?'}  ${v.compiled_truth?.slice(0, 60) || ''}...`,
      ).join('\n') + '\n';
    }
    default:
      return JSON.stringify(result, null, 2) + '\n';
  }
}

/**
 * Multi-topology v1: thin-client refusal set. These commands require a local
 * engine; if `~/.gbrain/config.json` has `remote_mcp` set, the dispatch guard
 * refuses them with a canonical error pointing at the remote host. The check
 * runs before per-command dispatch so the error message is consistent.
 *
 * `serve` is in this set because `gbrain serve` (stdio or http) requires a
 * local engine to expose. Thin clients don't have one to expose.
 *
 * `doctor` is intentionally NOT in this set — task 4 routes it to
 * `runRemoteDoctor` for thin-client installs.
 */
const THIN_CLIENT_REFUSED_COMMANDS = new Set([
  'sync', 'embed', 'extract', 'extract-conversation-facts', 'enrich', 'migrate', 'apply-migrations',
  'repair-jsonb', 'orphans', 'integrity', 'serve',
  // v0.43 (#2095): watch streams against a LOCAL engine; thin clients get
  // the volunteer_context MCP op instead.
  'watch',
  // v0.31.1 (CDX-2 op coverage matrix): more local-only commands
  'dream', 'transcripts', 'storage',
  // v0.31.1 CDX-2 audit: takes/sources have multiple subcommands; some
  // (takes_list/takes_search, sources_list/sources_status) have MCP
  // equivalents and others are file-system bound (takes mutate commands
  // edit local .md files). v0.31.1 refuses both at the top level with a
  // hint pointing at the routable MCP tools; per-subcommand splits are
  // a v0.31.x follow-up TODO.
  'takes', 'sources',
  // v0.32 thin-client routing audit (Codex round 2 findings #2, #4):
  // - `pages` purge-deleted is admin+localOnly (operations.ts:856-864)
  // - `files` list / file_url MCP ops are localOnly (operations.ts:1769-1879)
  // - `eval` export/prune/replay have no MCP equivalents
  // - `code-def`/`code-refs`/`code-callers`/`code-callees` have NO MCP ops
  //   in operations.ts:2630-2671; cannot be "fixed by routing" yet
  'pages', 'files', 'eval', 'code-def', 'code-refs', 'code-callers', 'code-callees',
  // scratch-DB audit: `config` get/set operate on the host brain's config
  // plane (DB rows / host file-plane). On a thin client they fabricated an
  // ephemeral local PGLite (full migration replay per call) and read/wrote
  // config nobody would ever see. NOTE: `jobs` is deliberately NOT here —
  // it gets a partial dispatch (list/get route over MCP engine-free, the
  // rest refuse) in the main dispatch before connectEngine().
  'config',
]);

/**
 * v0.31.1 (Issue #734, CDX-5 + cherry-pick A): pinpoint refusal hints for
 * local-only commands when running on a thin-client install. Each hint names
 * the closest path (remote MCP call, host-side workflow) so users aren't
 * stuck guessing what to do next.
 *
 * Source-of-truth lives here so adding a new local-only command means
 * adding both the THIN_CLIENT_REFUSED_COMMANDS member AND the hint in one
 * place during code review.
 */
const THIN_CLIENT_REFUSE_HINTS: Record<string, string> = {
  sync: 'sync runs on the host. Trigger a remote cycle with `gbrain remote ping` (queues an autopilot-cycle job).',
  embed: 'embed runs on the host as part of the autopilot cycle. `gbrain remote ping` triggers a full cycle including embed.',
  extract: 'extract runs on the host. Use `gbrain remote ping` to trigger a cycle including extract.',
  'extract-conversation-facts': 'extract-conversation-facts runs on the host (requires local engine + chat gateway). Run on the host machine.',
  enrich: 'enrich runs on the host (requires local engine + chat gateway for grounded synthesis). Run on the host machine.',
  migrate: "migrate runs on the host's local engine. Run on the host machine.",
  'apply-migrations': 'schema migrations run on the host. SSH and run there.',
  'repair-jsonb': 'repair-jsonb operates on the local DB only.',
  integrity: 'integrity scans local files. Run on the host machine.',
  serve: 'serve starts a server. Run on the host, not the thin client.',
  dream: 'dream runs the autopilot cycle on the host. `gbrain remote ping` queues one. (Native `gbrain dream` thin-client routing planned for v0.31.2.)',
  orphans: "orphans needs the host's brain. Run on the host or use the `find_orphans` MCP tool from your agent.",
  transcripts: 'transcripts is server-private (raw chat exports stay on the host). Read transcripts on the host machine.',
  storage: 'storage operates on the local repo on disk. Run on the host.',
  takes: 'takes mutate subcommands edit local .md files; routing the read subcommands lands in v0.31.x. For now: use `takes_list` and `takes_search` MCP tools from your agent, or run on the host.',
  sources: 'sources commands manage local DB + config rows. Per-subcommand thin-client routing lands in v0.31.x. For now: use `sources_list` / `sources_status` MCP tools, or run on the host.',
  // v0.32 audit additions
  pages: '`pages purge-deleted` is admin+localOnly (hard-deletes from the local DB). Run on the host.',
  files: '`files list` and `files url` MCP ops are localOnly (paths live on the host filesystem). Use `gbrain files` on the host machine.',
  eval: '`eval` export/prune/replay touch the local engine and have no MCP equivalents. Run `gbrain eval` on the host.',
  'code-def': '`code-def` needs symbol-aware lookup that has no MCP op yet. Run on the host or use `search` from your agent with a symbol-shaped query.',
  'code-refs': '`code-refs` has no MCP op yet. Run on the host.',
  'code-callers': '`code-callers` has no MCP op yet. Run on the host.',
  'code-callees': '`code-callees` has no MCP op yet. Run on the host.',
  // scratch-DB audit additions
  config: "config reads/writes the host brain's config plane. Edit the host's .gbrain/config.json (file-plane keys) or run on the host with GBRAIN_HOME set.",
  jobs: '`jobs list` and `jobs get <id>` are thin-client routable; this subcommand runs against the host queue. Use the submit_job / list_jobs / get_job MCP tools from your agent, or run on the host with GBRAIN_HOME set.',
};

/**
 * v0.31.1: emit a pinpoint refusal hint for a thin-client-incompatible
 * command and exit 1. Falls back to the canonical generic message when no
 * specific hint is registered (defensive — every member of
 * THIN_CLIENT_REFUSED_COMMANDS should have a hint).
 */
function refuseThinClient(command: string, mcpUrl: string): never {
  const hint = THIN_CLIENT_REFUSE_HINTS[command];
  if (hint) {
    console.error(`\`gbrain ${command}\` is not routable. ${hint}`);
    console.error(`(thin-client of ${mcpUrl})`);
  } else {
    console.error(
      `\`gbrain ${command}\` requires a local engine. This install is a thin client of ${mcpUrl}.\n` +
      `Run \`${command}\` on the remote host, or use the corresponding MCP tool from your agent.`,
    );
  }
  process.exit(1);
}

async function handleCliOnly(command: string, args: string[]) {
  // Thin-client guard: refuse DB-bound commands cleanly with a pinpoint
  // hint instead of letting them fail later inside connectEngine or
  // mid-handler. v0.31.1 routes through `refuseThinClient` so every
  // refusal carries an actionable next-step hint (CDX-5 cherry-pick A).
  if (THIN_CLIENT_REFUSED_COMMANDS.has(command)) {
    const cfg = loadConfig();
    if (isThinClient(cfg)) {
      refuseThinClient(command, cfg!.remote_mcp!.mcp_url);
    }
  }

  // Commands that don't need a database connection
  if (command === 'schema') {
    const { runSchema } = await import('./commands/schema.ts');
    await runSchema(args);
    return;
  }
  if (command === 'init') {
    const { runInit } = await import('./commands/init.ts');
    await runInit(args);
    return;
  }
  // v0.37 fix wave (deferred TODO, shipped): one-command wipe-and-reinit.
  // Spawns its own engine internally so no pre-bound engine needed.
  if (command === 'reinit-pglite') {
    const { runReinitPglite } = await import('./commands/reinit-pglite.ts');
    await runReinitPglite(args);
    return;
  }
  if (command === 'auth') {
    const { runAuth } = await import('./commands/auth.ts');
    await runAuth(args);
    return;
  }
  if (command === 'remote') {
    // Multi-topology v1 (Tier B): thin-client-only convenience commands.
    // `runRemote` self-checks for remote_mcp config and exits 1 if local-only.
    const { runRemote } = await import('./commands/remote.ts');
    await runRemote(args);
    return;
  }
  if (command === 'connect') {
    // No local DB: connect generates/wires a Claude Code MCP connection to a
    // REMOTE gbrain over HTTP from a bearer token. Print mode touches nothing;
    // --install talks to the remote, not the local engine.
    const { runConnect } = await import('./commands/connect.ts');
    await runConnect(args);
    return;
  }
  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(args);
    return;
  }
  if (command === 'post-upgrade') {
    const { runPostUpgrade } = await import('./commands/upgrade.ts');
    await runPostUpgrade(args);
    return;
  }
  if (command === 'check-update') {
    const { runCheckUpdate } = await import('./commands/check-update.ts');
    await runCheckUpdate(args);
    return;
  }
  if (command === 'self-upgrade') {
    const { runSelfUpgrade } = await import('./commands/self-upgrade.ts');
    await runSelfUpgrade(args);
    return;
  }
  if (command === 'integrations') {
    const { runIntegrations } = await import('./commands/integrations.ts');
    await runIntegrations(args);
    return;
  }
  if (command === 'providers') {
    const { runProviders } = await import('./commands/providers.ts');
    const [sub, ...rest] = args;
    await runProviders(sub, rest);
    return;
  }
  if (command === 'auth') {
    const { runAuth } = await import('./commands/auth.ts');
    await runAuth(args);
    return;
  }
  if (command === 'resolvers') {
    const { runResolvers } = await import('./commands/resolvers.ts');
    await runResolvers(args);
    return;
  }
  if (command === 'integrity') {
    const { runIntegrity } = await import('./commands/integrity.ts');
    await runIntegrity(args);
    return;
  }
  if (command === 'publish') {
    const { runPublish } = await import('./commands/publish.ts');
    await runPublish(args);
    return;
  }
  if (command === 'check-backlinks') {
    const { runBacklinks } = await import('./commands/backlinks.ts');
    await runBacklinks(args);
    return;
  }
  if (command === 'frontmatter') {
    const { runFrontmatter } = await import('./commands/frontmatter.ts');
    await runFrontmatter(args);
    return;
  }
  if (command === 'lint') {
    const { runLint } = await import('./commands/lint.ts');
    await runLint(args);
    return;
  }
  if (command === 'check-resolvable') {
    const { runCheckResolvable } = await import('./commands/check-resolvable.ts');
    await runCheckResolvable(args);
    return;
  }
  if (command === 'mounts') {
    // No DB needed: mounts.json is a local config file. Registry will
    // connect mount engines lazily on first use by op dispatch.
    const { runMounts } = await import('./commands/mounts.ts');
    await runMounts(args);
    return;
  }
  if (command === 'cache') {
    // v0.32.x search-lite: semantic query cache management. Dispatch the
    // subcommand handler (stats / clear / prune); the handler opens its
    // own engine connection.
    const { runCache } = await import('./commands/cache.ts');
    await runCache(args);
    return;
  }
  if (command === 'routing-eval') {
    const { runRoutingEvalCli } = await import('./commands/routing-eval.ts');
    await runRoutingEvalCli(args);
    return;
  }
  if (command === 'skillify') {
    const { runSkillify } = await import('./commands/skillify.ts');
    // `args` here is subArgs (command already stripped by caller), so
    // args[0] is the subcommand (scaffold|check).
    await runSkillify(args);
    return;
  }
  if (command === 'skillpack') {
    const { runSkillpack } = await import('./commands/skillpack.ts');
    // subArgs already has `skillpack` stripped; args[0] is the subcommand.
    await runSkillpack(args);
    return;
  }
  if (command === 'friction') {
    const { runFriction } = await import('./commands/friction.ts');
    // #2084 inner-exit sweep: verdict + return so teardown + the flush seam run.
    setCliExitVerdict(runFriction(args));
    return;
  }
  if (command === 'claw-test') {
    const { runClawTest } = await import('./commands/claw-test.ts');
    setCliExitVerdict(await runClawTest(args));
    return;
  }
  if (command === 'report') {
    const { runReport } = await import('./commands/report.ts');
    await runReport(args);
    return;
  }
  if (command === 'apply-migrations') {
    // Does not need connectEngine — each phase (schema, smoke, host-rewrite)
    // manages its own subprocess or file-layer access directly. Avoids
    // connecting a second time when the orchestrator shells out to
    // `gbrain init --migrate-only` and `gbrain jobs smoke`.
    const { runApplyMigrations } = await import('./commands/apply-migrations.ts');
    await runApplyMigrations(args);
    return;
  }
  if (command === 'repair-jsonb') {
    const { runRepairJsonbCli } = await import('./commands/repair-jsonb.ts');
    await runRepairJsonbCli(args);
    return;
  }
  if (command === 'skillpack-check') {
    // Agent-readable health report. Shells out to doctor + apply-migrations
    // internally; does not need its own DB connection.
    const { runSkillpackCheck } = await import('./commands/skillpack-check.ts');
    await runSkillpackCheck(args);
    return;
  }
  if (command === 'doctor') {
    // Multi-topology v1: thin-client doctor. When `~/.gbrain/config.json`
    // has remote_mcp set, every DB-bound check is irrelevant. Route to the
    // outbound-HTTP probe set in `src/core/doctor-remote.ts` and return
    // before any local-engine work.
    const cfgForDoctor = loadConfig();
    if (isThinClient(cfgForDoctor)) {
      const { runRemoteDoctor } = await import('./core/doctor-remote.ts');
      await runRemoteDoctor(cfgForDoctor!, args);
      return;
    }

    // v0.36+ brain-health-100: --remediation-plan and --remediate go
    // through dedicated functions that compute from engine.getHealth()
    // (cheap path D7), NOT the full doctor walk.
    if (args.includes('--remediation-plan')) {
      const { runRemediationPlan } = await import('./commands/doctor.ts');
      const eng = await connectEngine();
      try { await runRemediationPlan(eng, args); } finally { await finishCliTeardown({ engine: eng }); }
      return;
    }
    if (args.includes('--remediate')) {
      const { runRemediate } = await import('./commands/doctor.ts');
      const eng = await connectEngine();
      try { await runRemediate(eng, args); } finally { await finishCliTeardown({ engine: eng }); }
      return;
    }

    // Doctor runs filesystem checks first (no DB needed), then DB checks.
    // --fast skips DB checks entirely.
    const { runDoctor } = await import('./commands/doctor.ts');
    const { getDbUrlSource } = await import('./core/config.ts');
    if (args.includes('--fast')) {
      // Pass the DB URL source so doctor can tell "no config at all" from
      // "user chose --fast while config is present".
      await runDoctor(null, args, getDbUrlSource());
    } else {
      // #2084: both failure kinds (connect throw, runDoctor(eng) throw) still
      // fall back to filesystem-only checks — identical to the prior shape.
      // The finally closes the gap where a runDoctor(eng) throw used to skip
      // the in-try disconnect. NOTE: runDoctor normally calls process.exit
      // itself, which preempts this finally — in-command exit sites bypassing
      // teardown are a pre-existing class, tracked as a TODOS.md follow-up.
      let eng: BrainEngine | null = null;
      try {
        eng = await connectEngine();
        await runDoctor(eng, args);
      } catch {
        // DB unavailable — still run filesystem checks
        await runDoctor(null, args, getDbUrlSource());
      } finally {
        if (eng) await finishCliTeardown({ engine: eng });
      }
    }
    return;
  }

  if (command === 'ze-switch') {
    // v0.36.0.0 — manual ZE-default switch lever. Owns its own engine lifecycle
    // to mirror the doctor pattern.
    const { runZeSwitch } = await import('./commands/ze-switch.ts');
    const eng = await connectEngine();
    try {
      await runZeSwitch(args, eng);
    } finally {
      await finishCliTeardown({ engine: eng });
    }
    return;
  }

  if (command === 'smoke-test') {
    // Run smoke tests — no DB connection needed, the script handles its own checks
    const { execSync } = await import('child_process');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = resolve(scriptDir, '..', 'scripts', 'smoke-test.sh');
    try {
      execSync(`bash "${scriptPath}"`, { stdio: 'inherit', env: { ...process.env } });
    } catch (e: any) {
      // Non-zero exit = some tests failed (exit code = failure count)
      setCliExitVerdict(e.status ?? 1);
    }
    return;
  }

  if (command === 'dream') {
    // Dream mirrors doctor's pattern: filesystem phases run without a DB,
    // so an engine connection failure is non-fatal. runCycle honestly
    // reports DB phases as skipped when engine is null. v0.41.13 (#1422):
    // bind + surface the error on stderr so the user knows WHY DB phases
    // were skipped instead of seeing a silent "lint + backlinks done"
    // and assuming the cycle actually ran. Pre-fix, foxhoundinc reported
    // the cycle exiting 0 on PostgreSQL with every DB phase silently no-op.
    const { runDream } = await import('./commands/dream.ts');
    let eng: BrainEngine | null = null;
    try {
      eng = await connectEngine();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[dream] WARNING: could not connect to DB (${msg}). ` +
        `Running filesystem-only phases (lint, backlinks, extract). ` +
        `DB-dependent phases (sync, embed, synthesize, etc.) will report as skipped.\n`
      );
    }
    try {
      await runDream(eng, args);
    } finally {
      // #1471 invariant tripwire (the dream-cycle owner): `eng` created the
      // module singleton (first module connector) and is torn down LAST,
      // here, after the whole cycle. The ownership fix relies on this owner's
      // lifetime strictly dominating every borrower (lint/doctor probe engines
      // created mid-cycle). Do NOT tear down `eng` before runDream returns, or
      // a borrower could outlive the owner and lose the shared singleton.
      // #2084: routed through the shared bounded teardown — dream runs as an
      // overnight cron, where a lingering-socket hang is a silent zombie
      // (closes the TODOS.md drain-before-owner-disconnect item).
      if (eng) await finishCliTeardown({ engine: eng });
    }
    return;
  }

  // `eval cross-modal` is a pure API-call command — no DB, no brain. Bypass
  // connectEngine entirely so first-run users (no `gbrain init` yet) can
  // run the quality gate. Mirrors the dream/doctor no-DB pattern but
  // doesn't even attempt the connect (T3=A in plans/radiant-napping-lerdorf.md).
  // The handler self-configures the AI gateway from loadConfig() + process.env.
  if (command === 'eval' && args[0] === 'cross-modal') {
    const { runEvalCrossModal } = await import('./commands/eval-cross-modal.ts');
    setCliExitVerdict(await runEvalCrossModal(args.slice(1)));
    return;
  }

  // v0.32 EXP-5 (codex review #10): `eval takes-quality replay <receipt>`
  // is the ONLY sub-subcommand that doesn't need a brain — it reads a
  // receipt JSON file from disk and re-renders it. Bypass connectEngine
  // here so users can replay a receipt on a machine without DATABASE_URL.
  // run/trend/regress need the brain and fall through to the regular
  // engine-required path below.
  if (command === 'eval' && args[0] === 'takes-quality' && args[1] === 'replay') {
    const { runReplayNoBrain } = await import('./commands/eval-takes-quality.ts');
    setCliExitVerdict(await runReplayNoBrain(args.slice(2)));
    return;
  }

  // v0.28.8: longmemeval brings its own in-memory PGLite. Bypassing
  // connectEngine here keeps `gbrain eval longmemeval --help` and benchmark
  // runs working on machines that have no `~/.gbrain/config.json` configured.
  //
  // v0.35.1.1: still need to configureGateway() so the in-memory brain's
  // import + hybridSearch can embed via the configured provider. Reads
  // ~/.gbrain/config.json when present; falls back to env vars otherwise
  // (GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS).
  if (command === 'eval' && args[0] === 'longmemeval') {
    const { runEvalLongMemEval } = await import('./commands/eval-longmemeval.ts');
    if (!(args.length > 1 && (args[1] === '--help' || args[1] === '-h'))) {
      const config = loadConfig() ?? ({
        embedding_model: process.env.GBRAIN_EMBEDDING_MODEL,
        embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS
          ? Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) : undefined,
      } as GBrainConfig);
      const { configureGateway } = await import('./core/ai/gateway.ts');
      configureGateway(buildGatewayConfig(config));
    }
    await runEvalLongMemEval(args.slice(1));
    return;
  }

  // v0.42.x (#2390): `gbrain eval chronicle` is deterministic — brings its own
  // in-memory PGLite, no DB/gateway. CI fixture gate runs anywhere.
  if (command === 'eval' && args[0] === 'chronicle') {
    const { runEvalChronicle } = await import('./commands/eval-chronicle.ts');
    setCliExitVerdict(await runEvalChronicle(args.slice(1)));
    return;
  }

  // v0.41.13.0: `gbrain eval conversation-parser` is pure-function
  // (parses fixture JSONL, runs parseConversation, scores results).
  // No DB access; bypass connectEngine entirely so the CI fixture
  // gate runs on machines with no `~/.gbrain/config.json`.
  if (command === 'eval' && args[0] === 'conversation-parser') {
    const { runEvalConversationParser } = await import('./commands/eval-conversation-parser.ts');
    setCliExitVerdict(await runEvalConversationParser(args.slice(1)));
    return;
  }

  // v0.41.13.0: `gbrain conversation-parser list-builtins | validate
  // | --help` are pure (no DB access). Bypass connectEngine so the
  // operator can run them on machines with no brain configured.
  // `scan <slug>` needs a brain and falls through.
  if (
    command === 'conversation-parser' &&
    (args.length === 0 ||
      args[0] === '--help' ||
      args[0] === '-h' ||
      args[0] === 'list-builtins' ||
      args[0] === 'validate')
  ) {
    const { runConversationParser } = await import('./commands/conversation-parser.ts');
    await runConversationParser(null, args);
    return;
  }

  // v0.33.1.3: `gbrain eval whoknows` on thin-client installs bypasses
  // connectEngine entirely — the eval routes per-query through the remote
  // `find_experts` MCP op (the v0.31.1 routing seam). Local mode falls
  // through to the engine-connected path below.
  if (command === 'eval' && args[0] === 'whoknows') {
    const cfgPre = loadConfig();
    if (isThinClient(cfgPre)) {
      const { runEvalWhoknows } = await import('./commands/eval-whoknows.ts');
      setCliExitVerdict(await runEvalWhoknows(null, args.slice(1)));
      return;
    }
  }

  // v0.41.19.0: `gbrain status` on thin-client installs bypasses connectEngine
  // entirely — Sync + Cycle route through the `get_status_snapshot` MCP op,
  // and local-only sections render as "N/A on remote brain". Local mode falls
  // through to the engine-connected dispatch path below. (`args` here is the
  // subArgs slice already — no need to re-slice past the command.)
  if (command === 'status') {
    const cfgPre = loadConfig();
    if (cfgPre && isThinClient(cfgPre)) {
      const { runStatus } = await import('./commands/status.ts');
      const result = await runStatus(null, args);
      setCliExitVerdict(result.exitCode);
      return;
    }
  }

  // v0.37 fix wave (Lane D.4 + CDX2-12): short-circuit `gbrain sync --help`
  // BEFORE the engine bind. runSync has its own --help branch but can't
  // reach it without an engine — which means a user running `--help` from
  // a fresh tmpdir with no config gets a no-such-config error instead of
  // help text. Importing runSync without the engine + passing null works
  // because runSync's --help path doesn't touch the engine argument.
  if (command === 'sync' && (args.includes('--help') || args.includes('-h'))) {
    const { runSync } = await import('./commands/sync.ts');
    await runSync(null as any, args);
    return;
  }

  // v0.39.3.0 WARN-5: same pattern for `capture --help`. CLI_ONLY_SELF_HELP
  // now includes 'capture' so the generic short-circuit at :101 stays out
  // of the way, but the dispatch case at :1229 still needs an engine. The
  // pre-engine-bind branch here exposes the HELP constant without requiring
  // a configured brain (fresh-tmpdir parity with brainstorm/lsd/sync).
  if (command === 'capture' && (args.includes('--help') || args.includes('-h'))) {
    const { runCapture } = await import('./commands/capture.ts');
    await runCapture(null, args);
    return;
  }

  // v0.41.39 (#1700): same pattern for `enrich --help`. enrich is in
  // CLI_ONLY_SELF_HELP so the generic stub stays out of the way; this
  // pre-engine-bind branch exposes the HELP constant without a configured
  // brain. runEnrich's --help path returns before touching the engine.
  if (command === 'enrich' && (args.includes('--help') || args.includes('-h'))) {
    const { runEnrich } = await import('./commands/enrich.ts');
    await runEnrich(null as never, args);
    return;
  }

  // v0.41.6.0 D3 (per outside-voice F1): connect-time + dispatch-time wallclock
  // timeouts for read-only commands whose hang would otherwise spin at 100% CPU
  // (the production "10-day zombie gbrain search ping" bug class). The wrap
  // covers connectEngine (so a hung schema probe / PgBouncer freeze actually
  // surfaces a timeout) AND the dispatch body (so a wedged runSearch /
  // runList honors the same deadline).
  // Per-command default: search 30s, sources list 10s. User --timeout=Ns wins.
  // Other commands (import, embed, doctor, etc.) keep their existing
  // unbounded connect — destructive / long-running commands shouldn't get
  // a default kill switch.
  const readOnlyDefaultTimeoutMs =
    command === 'search' ? 30_000 :
    command === 'sources' && (args[0] === 'list' || args[0] === undefined) ? 10_000 :
    null;
  const cliOptsResolved = getCliOptions();
  const userTimeoutMs = cliOptsResolved.timeoutMs;
  const readOnlyTimeoutMs = userTimeoutMs ?? readOnlyDefaultTimeoutMs;

  if (readOnlyTimeoutMs !== null) {
    const { withTimeout, OperationTimeoutError } = await import('./core/timeout.ts');
    const label = `gbrain ${command}`;
    let engine: BrainEngine;
    try {
      engine = await withTimeout(connectEngine(), readOnlyTimeoutMs, `${label}: connect`);
    } catch (e) {
      if (e instanceof OperationTimeoutError) {
        const hint = userTimeoutMs ? '' : ` (default ${e.ms}ms; pass --timeout=Ns to override)`;
        console.error(`${e.label} timed out${hint}.`);
        process.exit(124);
      }
      throw e;
    }
    try {
      await withTimeout(dispatchReadOnlyCommand(engine, command, args), readOnlyTimeoutMs, label);
    } catch (e) {
      if (e instanceof OperationTimeoutError) {
        const hint = userTimeoutMs ? '' : ` (default ${e.ms}ms; pass --timeout=Ns to override)`;
        console.error(`${e.label} timed out${hint}.`);
        process.exit(124);
      }
      throw e;
    } finally {
      await finishCliTeardown({ engine });
    }
    return;
  }

  // #1633: out-of-band hard-deadline watchdog for `gbrain sync`. Installed
  // BEFORE connectEngine so a connect-phase hang (the reported zombie class) is
  // bounded too. A Bun Worker on its own OS thread SIGKILLs the process at the
  // deadline even when the main event loop is starved by a synchronous spin —
  // the only thing that stops the cron orphan-pileup. Disposed in the finally.
  let syncWatchdog: { dispose(): void } | null = null;
  if (command === 'sync') {
    try {
      const { resolveSyncHardDeadline } = await import('./commands/sync.ts');
      const res = resolveSyncHardDeadline(args, {
        isTty: Boolean(process.stdout.isTTY),
        env: process.env,
      });
      if (res) {
        const { installProcessWatchdog } = await import('./core/process-watchdog.ts');
        syncWatchdog = installProcessWatchdog({
          deadlineMs: res.deadlineMs,
          graceMs: res.graceMs,
          label: 'sync-watchdog',
          heartbeatMs: 60_000,
        });
        process.stderr.write(
          `[sync-watchdog] hard deadline armed: ${Math.round(res.deadlineMs / 1000)}s ` +
          `+ ${Math.round(res.graceMs / 1000)}s grace (${res.reason}); disable with --no-hard-deadline\n`,
        );
      }
    } catch (e) {
      // A bad --hard-deadline value throws here (same posture as --timeout).
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  // Thin-client `jobs` dispatch: `list` and `get` route over MCP (v0.32
  // routing branches in commands/jobs.ts) and never touch a local engine —
  // but falling through to connectEngine() below fabricates an empty
  // scratch PGLite in the thin-client GBRAIN_HOME and replays the entire
  // migration chain on every invocation before the remote call even runs.
  // Dispatch them engine-free here; every other jobs subcommand is
  // host-queue-bound, so refuse with a pinpoint hint instead of building
  // the scratch store.
  if (command === 'jobs') {
    const cfgJobs = loadConfig();
    if (isThinClient(cfgJobs)) {
      const jobsSub = args[0];
      if (jobsSub === 'list' || jobsSub === 'get') {
        const { runJobs } = await import('./commands/jobs.ts');
        await runJobs(null, args);
        return;
      }
      refuseThinClient('jobs', cfgJobs!.remote_mcp!.mcp_url);
    }
  }

  // All remaining CLI-only commands need a DB connection
  const engine = await connectEngine();
  try {
    switch (command) {
      case 'import': {
        const { runImport } = await import('./commands/import.ts');
        // v0.41 (Codex r2 #3 fix): honor errors counter for exit code.
        // runImport's per-file catch already records failures, but the
        // CLI was discarding the result so the process exited 0 even
        // when files failed (e.g. content-sanity hard-block throws,
        // size-cap throws, parse errors). Surface non-zero on errors > 0
        // so wrappers (sync, CI scripts, `&& gbrain doctor`) propagate.
        const importResult = await runImport(engine, args);
        if (importResult.errors > 0) {
          setCliExitVerdict(1);
        }
        break;
      }
      case 'export': {
        const { runExport } = await import('./commands/export.ts');
        await runExport(engine, args);
        break;
      }
      case 'files': {
        const { runFiles } = await import('./commands/files.ts');
        await runFiles(engine, args);
        break;
      }
      case 'embed': {
        const { runEmbed } = await import('./commands/embed.ts');
        await runEmbed(engine, args);
        break;
      }
      case 'serve': {
        const { runServe } = await import('./commands/serve.ts');
        await runServe(engine, args);
        return; // serve doesn't disconnect
      }
      case 'call': {
        const { runCall } = await import('./commands/call.ts');
        await runCall(engine, args);
        break;
      }
      case 'config': {
        const { runConfig } = await import('./commands/config.ts');
        await runConfig(engine, args);
        break;
      }
      // doctor is handled before connectEngine() above
      case 'migrate': {
        const { runMigrateEngine } = await import('./commands/migrate-engine.ts');
        await runMigrateEngine(engine, args);
        break;
      }
      case 'eval': {
        // v0.32 EXP-5: `eval takes-quality {run,trend,regress}` requires a
        // brain (samples takes from DB / reads runs table). `replay` was
        // already routed through the no-DB bypass above and never reaches
        // this case. Other `eval` subcommands (export/prune/replay-capture/
        // longmemeval/cross-modal) go to the generic dispatcher.
        if (args[0] === 'takes-quality') {
          const { runEvalTakesQuality } = await import('./commands/eval-takes-quality.ts');
          await runEvalTakesQuality(engine, args.slice(1));
          break;
        }
        const { runEvalCommand } = await import('./commands/eval.ts');
        await runEvalCommand(engine, args);
        break;
      }
      case 'jobs': {
        const { runJobs } = await import('./commands/jobs.ts');
        await runJobs(engine, args);
        break;
      }
      case 'agent': {
        const { runAgent } = await import('./commands/agent.ts');
        await runAgent(engine, args);
        break;
      }
      case 'book-mirror': {
        const { runBookMirrorCmd } = await import('./commands/book-mirror.ts');
        await runBookMirrorCmd(engine, args);
        break;
      }
      case 'sync': {
        const { runSync } = await import('./commands/sync.ts');
        await runSync(engine, args);
        break;
      }
      case 'extract': {
        const { runExtract } = await import('./commands/extract.ts');
        await runExtract(engine, args);
        break;
      }
      case 'extract-conversation-facts': {
        const { runExtractConversationFacts } = await import('./commands/extract-conversation-facts.ts');
        await runExtractConversationFacts(engine, args);
        break;
      }
      case 'enrich': {
        const { runEnrich } = await import('./commands/enrich.ts');
        await runEnrich(engine, args);
        break;
      }
      case 'features': {
        const { runFeatures } = await import('./commands/features.ts');
        await runFeatures(engine, args);
        break;
      }
      case 'autopilot': {
        const { runAutopilot } = await import('./commands/autopilot.ts');
        await runAutopilot(engine, args);
        return; // autopilot doesn't disconnect (long-running)
      }
      case 'graph-query': {
        const { runGraphQuery } = await import('./commands/graph-query.ts');
        await runGraphQuery(engine, args);
        break;
      }
      case 'reconcile-links': {
        // v0.20.0 Cathedral II Layer 8 D3: batch-recompute doc↔impl edges
        // for any markdown page that cites code files. Idempotent; safe to
        // re-run. Closes the v0.19.0 Layer 6 order-dependency bug where
        // guides imported before their code never got their edges written.
        const { runReconcileLinksCli } = await import('./commands/reconcile-links.ts');
        await runReconcileLinksCli(engine, args);
        break;
      }
      case 'orphans': {
        const { runOrphans } = await import('./commands/orphans.ts');
        await runOrphans(engine, args);
        break;
      }
      case 'maintain': {
        const { runMaintain } = await import('./commands/maintain.ts');
        await runMaintain(engine, args);
        break;
      }
      // v0.32.7 CJK wave — post-upgrade markdown re-chunk sweep.
      // v0.36 Phase 3 wave — `gbrain reindex --multimodal` re-embeds content_chunks
      // into the unified Voyage multimodal-3 column.
      case 'reindex': {
        if (args.includes('--multimodal')) {
          const { runReindexMultimodal } = await import('./commands/reindex-multimodal.ts');
          const { parseWorkers } = await import('./core/sync-concurrency.ts');
          const limitIdx = args.indexOf('--limit');
          const limitVal = limitIdx >= 0 && limitIdx + 1 < args.length ? parseInt(args[limitIdx + 1], 10) : undefined;
          // v0.41.15.0 (T9, D9): --workers N for parallel UPDATEs within
          // each Voyage batch. Honored by the inner write loop only;
          // the outer batch loop is one Voyage round-trip per batch.
          const workersIdx = args.indexOf('--workers');
          const concurrencyIdx = args.indexOf('--concurrency');
          const workersValIdx = workersIdx >= 0 ? workersIdx + 1 : (concurrencyIdx >= 0 ? concurrencyIdx + 1 : -1);
          const workers = workersValIdx > 0 && workersValIdx < args.length
            ? parseWorkers(args[workersValIdx])
            : undefined;
          const result = await runReindexMultimodal(engine, {
            limit: Number.isFinite(limitVal as number) ? (limitVal as number) : undefined,
            dryRun: args.includes('--dry-run'),
            costEstimate: args.includes('--cost-estimate'),
            noEmbed: args.includes('--no-embed'),
            json: args.includes('--json'),
            yes: args.includes('--yes'),
            workers,
          });
          if (args.includes('--json')) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`reindex --multimodal: ${result.reembedded} re-embedded, ${result.failed} failed, ${result.pending_after} pending. est. cost: $${result.cost_usd_estimate.toFixed(2)}`);
          }
          break;
        }
        if (args.includes('--aliases')) {
          // T8 — backfill the free-text alias layer (page_aliases) for existing
          // pages whose frontmatter `aliases:` predate the import-time projection.
          const { runReindexAliases } = await import('./commands/reindex-aliases.ts');
          await runReindexAliases(engine, args);
          break;
        }
        const { runReindex } = await import('./commands/reindex.ts');
        await runReindex(engine, args);
        break;
      }
      // v0.29 — Salience + Anomaly Detection
      case 'salience': {
        const { runSalience } = await import('./commands/salience.ts');
        await runSalience(engine, args);
        break;
      }
      case 'anomalies': {
        const { runAnomalies } = await import('./commands/anomalies.ts');
        await runAnomalies(engine, args);
        break;
      }
      // v0.41.19.0 — `gbrain status`: single-screen brain health dashboard.
      // CLI-only with own thin-client branch INSIDE runStatus (per D2 + codex
      // MAJOR-4 architecture). Composes existing exports: buildSyncStatusReport,
      // readSupervisorEvents, gbrain_cycle_locks, minion_jobs.
      case 'status': {
        const { runStatus } = await import('./commands/status.ts');
        const result = await runStatus(engine, args);
        // #2084 inner-exit sweep: a mid-switch exit skips the finally teardown.
        setCliExitVerdict(result.exitCode);
        break;
      }
      // v0.43 (#2180) — `gbrain advisor`: ranked, read-only "what to do next".
      // CLI surface; the same signals are exposed over MCP via the `advisor` op.
      case 'advisor': {
        const { runAdvisorCli } = await import('./commands/advisor.ts');
        const result = await runAdvisorCli(engine, args);
        process.exit(result.exitCode);
        // eslint-disable-next-line no-unreachable
        break;
      }
      // v0.38 — Capture: single human-facing entrypoint for ingestion.
      case 'capture': {
        const { runCapture } = await import('./commands/capture.ts');
        await runCapture(engine, args);
        break;
      }
      case 'conversation-parser': {
        // v0.41.13.0 — debug + introspection CLI for the new parser
        // cathedral. `scan <slug>` requires a connected brain; the
        // other subcommands are pure (`list-builtins`, `validate`).
        const { runConversationParser } = await import('./commands/conversation-parser.ts');
        await runConversationParser(engine, args);
        break;
      }
      case 'edges-backfill': {
        // v0.34 W6 — operator escape hatch for the symbol-resolution backfill.
        // Resumable via the edges_backfilled_at watermark; per-batch transactions
        // commit so Ctrl-C leaves a clean resumable state.
        const { runEdgesBackfill } = await import('./commands/edges-backfill.ts');
        await runEdgesBackfill(engine, args);
        break;
      }
      case 'whoknows': {
        // v0.33 (Issue #?): expertise + relationship-proximity routing.
        // MCP op `find_experts` (read-scoped) backs the same code path; CLI
        // dispatch here is the user-facing surface. Thin-client routing
        // happens inside runWhoknows via isThinClient(cfg) (v0.31.1 pattern).
        const { runWhoknows } = await import('./commands/whoknows.ts');
        await runWhoknows(engine, args);
        break;
      }
      case 'brainstorm': {
        // v0.37.0 (Open Collider wave): bisociation idea generator grounded
        // in the user's own brain. Prefix-stratified domain-bank (D14) +
        // shared judges + citation transparency (D6). LSD MCP exposure
        // deferred to D7; this is CLI-only.
        const { runBrainstormCommand } = await import('./commands/brainstorm.ts');
        await runBrainstormCommand(engine, args);
        break;
      }
      case 'lsd': {
        // v0.37.0 — Lateral Synaptic Drift. Inverted-judge / stale-bias
        // variant of brainstorm. Shares the orchestrator + judges via
        // LSD_PROFILE config. Local-only by design (cost + weirdness gate).
        const { runLsdCommand } = await import('./commands/lsd.ts');
        await runLsdCommand(engine, args);
        break;
      }
      case 'skillopt': {
        // v0.41.20.0 — Self-evolving skill optimization (SkillOpt-paper-grounded).
        // Mutating CLI: validation-gated (D12), budget-capped (D3), per-skill
        // DB-locked (D14), bundled-skill-gated (D16), bootstrap-sentinel-reviewed
        // (D15). See: src/core/skillopt/ + plan at
        // ~/.claude/plans/system-instruction-you-are-working-drifting-falcon.md.
        const { runSkillOptCommand } = await import('./commands/skillopt.ts');
        await runSkillOptCommand(engine, args);
        break;
      }
      case 'calibration': {
        // v0.36.1.0 (T7): print/regenerate the active calibration profile.
        // MCP op `get_calibration_profile` (read-scoped) backs the same data path.
        const { runCalibration } = await import('./commands/calibration.ts');
        const calibrationConfig = loadConfig() ?? ({} as never);
        await runCalibration(engine, args, calibrationConfig);
        break;
      }
      case 'transcripts': {
        const { runTranscripts } = await import('./commands/transcripts.ts');
        await runTranscripts(engine, args);
        break;
      }
      case 'models': {
        const { runModels } = await import('./commands/models.ts');
        await runModels(engine, args);
        break;
      }
      case 'search': {
        // v0.32.3 search-lite — `gbrain search modes/stats/tune`.
        const { runSearch } = await import('./commands/search.ts');
        await runSearch(engine, args);
        break;
      }
      case 'takes': {
        const { runTakes } = await import('./commands/takes.ts');
        await runTakes(engine, args);
        break;
      }
      case 'onboard': {
        // v0.41.18.0 (T13) — gbrain onboard. Thin shell over T2 library
        // + T4 onboard checks + T12 render layer.
        const { runOnboard } = await import('./commands/onboard.ts');
        await runOnboard(engine, args);
        break;
      }
      case 'founder': {
        // v0.35.4 (T7) — founder scorecard. `gbrain founder scorecard <slug>`
        // rolls up Phase 2's typed-claim substrate into the four scorecard
        // metrics (claim accuracy, consistency, growth trajectory, red flags).
        // Thin-client routing handled inside the command file.
        const { runFounder } = await import('./commands/founder-scorecard.ts');
        await runFounder(engine, args);
        break;
      }
      case 'think': {
        const { runThinkCli } = await import('./commands/think.ts');
        await runThinkCli(engine, args);
        break;
      }
      case 'recall': {
        // v0.31: hot memory recall surface — `gbrain recall <entity>`,
        // `--since DUR`, `--session ID`, `--today`, `--grep TEXT`,
        // `--supersessions`, `--include-expired`, `--as-context`, `--json`.
        const { runRecall } = await import('./commands/recall.ts');
        await runRecall(engine, args);
        break;
      }
      case 'forget': {
        // v0.31: shorthand for expireFact. `gbrain forget <fact-id>`.
        const { runForget } = await import('./commands/recall.ts');
        await runForget(engine, args);
        break;
      }
      case 'notability-eval': {
        // v0.31.2: notability gate eval suite. Two subcommands:
        //   gbrain notability-eval mine    — sample paragraphs, write candidates
        //   gbrain notability-eval review  — TTY hand-confirm tiers
        const { runNotabilityEval } = await import('./commands/notability-eval.ts');
        const subcmd = args[0] || 'help';
        const flags: Record<string, string | boolean> = {};
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
              flags[key] = next;
              i++;
            } else {
              flags[key] = true;
            }
          }
        }
        // sync.repo_path resolution (matches dream phase pattern).
        let repoPath: string | undefined;
        try {
          repoPath = (flags.repo as string) || (await engine.getConfig('sync.repo_path')) || undefined;
        } catch { /* engine may not be connected for help */ }
        await runNotabilityEval({ cmd: subcmd, flags, engine, repoPath });
        break;
      }
      case 'sources': {
        const { runSources } = await import('./commands/sources.ts');
        await runSources(engine, args);
        break;
      }
      case 'pages': {
        // v0.26.5: page-level operator commands (purge-deleted escape hatch).
        const { runPages } = await import('./commands/pages.ts');
        await runPages(engine, args);
        break;
      }
      case 'quarantine': {
        // v0.42 (#1699): content-quality gate operator surface.
        const { runQuarantine } = await import('./commands/quarantine.ts');
        await runQuarantine(engine, args);
        break;
      }
      case 'watch': {
        // v0.43 (#2095): push-based context transport. Blocks in the stdin
        // iteration (interactive stays alive; piped exits at EOF), then the
        // finally below runs finishCliTeardown (volunteer events drain with
        // every other sink) and the import.meta.main seam flush-exits.
        const { runWatch } = await import('./commands/watch.ts');
        await runWatch(engine, args);
        break;
      }
      case 'storage': {
        const { runStorage } = await import('./commands/storage.ts');
        await runStorage(engine, args);
        break;
      }
      case 'code-def': {
        const { runCodeDef } = await import('./commands/code-def.ts');
        await runCodeDef(engine, args);
        break;
      }
      case 'code-refs': {
        const { runCodeRefs } = await import('./commands/code-refs.ts');
        await runCodeRefs(engine, args);
        break;
      }
      case 'reindex-code': {
        // v0.20.0 Cathedral II Layer 13 (E2): explicit code-page reindex
        // for users upgrading from v0.19.0. Cost-preview gated; TTY prompt
        // or ConfirmationRequired envelope for non-TTY/JSON callers.
        const { runReindexCodeCli } = await import('./commands/reindex-code.ts');
        await runReindexCodeCli(engine, args);
        break;
      }
      case 'reindex-search-vector': {
        // Explicit recreate of FTS trigger functions + batched backfill,
        // honoring GBRAIN_FTS_LANGUAGE. Use after changing the language
        // env var on a brain that already ran the configurable_fts_language
        // migration.
        const { runReindexSearchVectorCli } = await import('./commands/reindex-search-vector.ts');
        await runReindexSearchVectorCli(engine, args);
        break;
      }
      case 'reindex-frontmatter': {
        // v0.29.1: recovery / explicit-rebuild path for pages.effective_date.
        // Mirror of reindex-code shape. Wraps the shared library function in
        // src/core/backfill-effective-date.ts (same code path the v0.29.1
        // migration orchestrator uses). The orchestrator runs once on
        // upgrade; this command is for after-the-fact frontmatter edits.
        //
        // v0.30.1: still works; canonical entrypoint is now `gbrain backfill
        // effective_date`. This command stays as a thin alias for back-compat.
        const { reindexFrontmatterCli } = await import('./commands/reindex-frontmatter.ts');
        await reindexFrontmatterCli(args);
        return; // reindexFrontmatterCli handles its own engine lifecycle
      }
      case 'backfill': {
        // v0.30.1: first-class generic backfill command. Subcommand dispatch
        // is inside runBackfillCommand (kind | list | --help).
        const { runBackfillCommand } = await import('./commands/backfill.ts');
        await runBackfillCommand(args);
        return;
      }
      case 'code-callers': {
        // v0.20.0 Cathedral II Layer 10 (C4): "who calls <symbol>?"
        const { runCodeCallers } = await import('./commands/code-callers.ts');
        await runCodeCallers(engine, args);
        break;
      }
      case 'code-callees': {
        // v0.20.0 Cathedral II Layer 10 (C5): "what does <symbol> call?"
        const { runCodeCallees } = await import('./commands/code-callees.ts');
        await runCodeCallees(engine, args);
        break;
      }
      case 'repos': {
        // v0.19.0: `gbrain repos ...` is an alias into the v0.18.0 sources
        // subsystem. The repos abstraction (Garry's OpenClaw baseline) was
        // redundant with sources and carried per-user config state that
        // couldn't participate in federation / RLS / multi-tenancy. We
        // keep the alias so scripts like `gbrain repos add .` keep
        // working, with a nudge toward the canonical command.
        console.error('[gbrain] Note: "repos" is an alias for "sources" as of v0.19.0. Prefer `gbrain sources <subcommand>`.');
        const { runSources } = await import('./commands/sources.ts');
        await runSources(engine, args);
        break;
      }
    }
  } finally {
    syncWatchdog?.dispose(); // #1633: tear down the hard-deadline watchdog on clean exit
    // #2084 — the CLI_ONLY fall-through teardown (drain every background-work
    // sink, THEN disconnect, under a computed-deadline backstop) lives in
    // finishCliTeardown. `gbrain capture`'s fire-and-forget facts:absorb job
    // gets its drain window before PGLite's db.close() can race it into the
    // re-pump busy-loop (#1762). #1471: this is also the fall-through
    // OWNER-disconnect — the owner is torn down LAST (after the drain), so
    // module-singleton borrowers never outlive it. `serve` skips teardown
    // entirely: the daemon owns its lifecycle.
    if (command !== 'serve') {
      await finishCliTeardown({ engine });
    }
  }
}

/**
 * v0.41.6.0 D3: dispatch helper for the read-only commands that take a
 * default wallclock timeout (`gbrain search`, `gbrain sources list`).
 * Keeps the timeout-wrap site in main() small and the per-command
 * dispatch logic colocated for easy extension. Pure dispatcher; no engine
 * lifecycle (caller owns connect/disconnect).
 */
async function dispatchReadOnlyCommand(engine: BrainEngine, command: string, args: string[]): Promise<void> {
  switch (command) {
    case 'search': {
      const { runSearch } = await import('./commands/search.ts');
      await runSearch(engine, args);
      return;
    }
    case 'sources': {
      const { runSources } = await import('./commands/sources.ts');
      await runSources(engine, args);
      return;
    }
    default:
      throw new Error(`dispatchReadOnlyCommand: unsupported command "${command}"`);
  }
}

// Build the AIGatewayConfig payload from a GBrainConfig. Both configureGateway
// sites in connectEngine() pass through this helper so adding a new field
// touches one place.
// v0.42 (#1780): moved to src/core/ai/build-gateway-config.ts so core modules
// (init-embed-check) can reuse it without importing the CLI entrypoint. Still
// re-exported here for back-compat with `test/ai/build-gateway-config.test.ts`
// and other callers that import it from `../../src/cli.ts`. Imported (not just
// re-exported) so cli.ts's own connectEngine() call sites bind it locally.
import { buildGatewayConfig } from './core/ai/build-gateway-config.ts';
export { buildGatewayConfig };

async function connectEngine(opts?: { probeOnly?: boolean }): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Configure the AI gateway BEFORE engine connect — initSchema needs embedding dims.
  // Env is read once here; the gateway never reads process.env at call time (Codex C3).
  const { configureGateway } = await import('./core/ai/gateway.ts');
  configureGateway(buildGatewayConfig(config));

  const { createEngine } = await import('./core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  const noRetry = process.argv.includes('--no-retry-connect') ||
                  process.env.GBRAIN_NO_RETRY_CONNECT === '1';
  const { connectWithRetry } = await import('./core/db.ts');
  await connectWithRetry(engine, toEngineConfig(config), { noRetry });

  // v0.30.1 (Codex X1 / C2): probeOnly skips both hasPendingMigrations() probe
  // AND initSchema(). Used by `get_health` MCP op + `gbrain upgrade --status`
  // + doctor's migration_wedge check — these surfaces report wedge state and
  // must NEVER themselves start or block on migrations.
  if (opts?.probeOnly === true) {
    return engine;
  }

  // v0.41.6.0 D4: race-tolerant CLI-side migration runner. Replaces the
  // pre-v0.41.6.0 `try { hasPendingMigrations && initSchema() } catch warn`
  // block that fired the alarming "Schema probe/migrate failed: deadlock
  // detected" warning on EVERY sync when two CLIs raced on schema probe.
  // The retry+poll loop quiets the warning when the race resolves
  // itself (the common case); the revised wording fires only when
  // migrations are genuinely stuck.
  try {
    const { tryRunPendingMigrations } = await import('./core/migrate.ts');
    const result = await tryRunPendingMigrations(engine);
    if (result.status === 'persistent') {
      console.warn(
        '  Schema migrations are pending. Another process attempted to apply them ' +
        'but the migration didn\'t complete within the retry window. This is usually transient.',
      );
      console.warn('  If it persists:');
      console.warn('    1. Check `gbrain doctor` for stale locks or stuck advisory locks.');
      console.warn('    2. Check `gbrain jobs supervisor status` for crashed migration workers.');
      console.warn('    3. Re-run: `gbrain apply-migrations --yes`');
    } else if (result.status === 'error') {
      // Non-deadlock error during initSchema. Surface the message and continue;
      // subsequent operations will resurface the real schema error in context.
      console.warn(`  Schema probe failed: ${result.error.message}`);
      console.warn('  Re-run: `gbrain apply-migrations --yes`');
    }
    // 'ok', 'not_needed', 'race_resolved' → silent (the common-case outcomes).
  } catch (err) {
    // Last-resort defense in case the helper itself throws unexpectedly.
    console.warn(`  Schema probe failed (unexpected): ${(err as Error).message}`);
    console.warn('  Re-run: `gbrain apply-migrations --yes`');
  }

  // v0.27.1 (F3 fix): re-merge DB-plane config now that the engine is up.
  // Flags like `embedding_multimodal` are user-mutable via `gbrain config set`
  // (DB plane) and need to flow into the gateway after connect. Schema-sizing
  // fields (embedding_dimensions etc.) keep their pre-connect file/env values
  // — those drove initSchema and the merged config respects file/env first.
  try {
    const merged = await loadConfigWithEngine(engine, config);
    if (merged) {
      // Stash gate flags on process.env for downstream readers (import-file.ts
      // dispatches on GBRAIN_EMBEDDING_MULTIMODAL, OCR consumer reads
      // GBRAIN_EMBEDDING_IMAGE_OCR_*). The gateway itself doesn't read these
      // flags; this preserves the contract without changing the gateway shape.
      if (merged.embedding_multimodal !== undefined) {
        process.env.GBRAIN_EMBEDDING_MULTIMODAL = String(merged.embedding_multimodal);
      }
      if (merged.embedding_image_ocr !== undefined) {
        process.env.GBRAIN_EMBEDDING_IMAGE_OCR = String(merged.embedding_image_ocr);
      }
      if (merged.embedding_image_ocr_model !== undefined) {
        process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL = merged.embedding_image_ocr_model;
      }
      // Always re-configure with merged values when DB merge succeeded. The
      // trigger used to be field-name-gated (only when embedding_multimodal_model
      // was set); that coupled the gate to the field set and would silently
      // miss future DB-mutable gateway fields. One extra cache+shrinkState
      // clear per startup is microseconds, no hot path.
      configureGateway(buildGatewayConfig(merged));
    }
    // v0.31.12: re-resolve gateway defaults through resolveModel so
    // `models.tier.*` and `models.default` overrides apply to expansion +
    // chat. Per Codex F3 — configureGateway is sync; this is the async
    // re-stamp seam after engine.connect() makes config reads possible.
    const { reconfigureGatewayWithEngine } = await import('./core/ai/gateway.ts');
    await reconfigureGatewayWithEngine(engine);
  } catch {
    // Non-fatal. Pre-v39 brains may not have a usable config table yet.
  }

  return engine;
}

export function printOpHelp(op: Operation, invokedName?: string) {
  const positional = (op.cliHints?.positional || []).map(p => `<${p}>`).join(' ');
  // v114 (#1941): when invoked via an alias (e.g. `gbrain link-add --help`),
  // show the alias the user typed, not the primary op name.
  const name = invokedName || op.cliHints?.name || op.name;
  console.log(`Usage: gbrain ${name} ${positional} [options]\n`);
  console.log(op.description + '\n');
  const entries = Object.entries(op.params);
  if (entries.length > 0) {
    console.log('Options:');
    for (const [key, def] of entries) {
      const isPos = op.cliHints?.positional?.includes(key);
      const req = def.required ? ' (required)' : '';
      const prefix = isPos ? `  <${key}>` : `  --${key.replace(/_/g, '-')}`;
      console.log(`${prefix.padEnd(28)} ${def.description || ''}${req}`);
    }
  }
}

function printHelp() {
  // Gather shared operations grouped by category
  const cliNames = Array.from(cliOps.entries())
    .map(([name, op]) => ({ name, desc: op.description }));

  console.log(`gbrain ${VERSION} -- personal knowledge brain

USAGE
  gbrain <command> [options]

SETUP
  init [--pglite|--supabase|--url]   Create brain (PGLite default, no server)
  migrate --to <supabase|pglite>     Transfer brain between engines
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json] [--fast]            Health check (resolver, skills, pgvector, RLS, embeddings)
  integrations [subcommand]          Manage integration recipes (senses + reflexes)

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)
  ask <question> [--no-expand]       Alias for query

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  sync --watch [--interval N]        Continuous sync (loops until stopped)
                                     See also: autopilot --install (continuous daemon).
  export [--dir ./out/]              Export to markdown
  export --restore-only [--repo <p>] Restore missing supabase-only files
        [--type T] [--slug-prefix S] With optional filters

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files upload-raw <file> --page <s> Smart upload (size routing + .redirect.yaml)
  files signed-url <path>            Generate signed URL (1-hour)
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS
  link <from> <to>                   Create typed link (alias: link-add)
        [--link-type T] [--link-source S]   provenance defaults to 'manual'
  unlink <from> <to>                 Remove link (alias: link-rm)
        [--link-type T] [--link-source S]   filter which edges to remove
  link-sources                       List provenances in use, with edge counts
  backlinks <slug>                   Incoming links
  graph <slug> [--depth N]           Traverse link graph (returns nodes)
  graph-query <slug> [--type T]      Edge-based traversal with type/direction filters
        [--depth N] [--direction in|out|both]

TAGS
  tags <slug>                        List tags
  tag <slug> <tag>                   Add tag
  untag <slug> <tag>                 Remove tag

TIMELINE
  timeline [<slug>]                  View timeline
  timeline-add <slug> <date> <text>  Add timeline entry

TOOLS
  extract <links|timeline|all>       Extract links/timeline (idempotent)
        [--source fs|db]             fs (default) walks .md files; db iterates engine pages
        [--dir <brain>]              brain dir for fs source
        [--type T] [--since DATE]    filters (db source)
        [--dry-run] [--json]
  publish <page.md> [--password]     Shareable HTML (strips private data, optional AES-256)
  check-backlinks <check|fix> [dir]  Find/fix missing back-links across brain
  lint <dir|file> [--fix]            Catch LLM artifacts, placeholder dates, bad frontmatter
  orphans [--json] [--count]         Find pages with no inbound wikilinks
  salience [--days N] [--kind P]     v0.29: pages ranked by emotional + activity salience
  anomalies [--since D] [--sigma N]  v0.29: cohort-based statistical anomalies (tag, type)
  transcripts recent [--days N]      v0.29: recent raw .txt transcripts (local-only)
  dream [--dry-run] [--json]         Run the overnight maintenance cycle once (cron-friendly).
                                     See also: autopilot --install (continuous daemon).
  check-resolvable [--json] [--fix]  Validate skill tree (reachability/MECE/DRY)
  report --type <name> --content ... Save timestamped report to brain/reports/

BRAIN (capture / ideate / explore — v0.37/v0.38)
  capture [content] [--file PATH]    Single entrypoint for getting content into the brain
        [--stdin] [--slug s] [--type t]   Inline content / file / stdin; writes to inbox/ by default
        [--source ID] [--quiet|--json]    Multi-source brains: route to a non-default source
  brainstorm <question> [--json]     Bisociation idea generator (hybrid search + far-set + judge)
        [--save|--no-save] [--limit N]
  lsd <question> [--json]            Lateral Synaptic Drift: inverted-judge brainstorm
        [--save|--no-save] [--limit N]    rewarding far-from-obvious + axiomatic inversions

SOURCES (multi-repo / multi-brain)
  sources list                       Show registered sources
  sources add <id> --path <p>        Register a source (id = short name, e.g. 'wiki')
  sources remove <id>                Remove a source + its pages (--confirm-destructive)
  sources archive <id>               Soft-delete: hide from search, recoverable for 72h
  sources restore <id>               Un-archive a soft-deleted source
  sources archived                   List soft-deleted sources and their purge expiry
  sources purge [<id>]               Permanently delete archived sources
  sources status                     Per-source dashboard (sync lag, embed coverage)
  sources --help                     Full subcommand list (rename, default, attach,
                                     current, federate, set-cr-mode, webhook, harden, ...)
  sync --all                         Sync all sources with a local_path
  sync --source <id>                 Sync one specific source
  repos ...                          DEPRECATED alias for 'sources' (v0.19.0)

CODE INDEXING (v0.19.0 / v0.20.0 Cathedral II)
  code-def <symbol> [--lang l]       Find the definition of a symbol across code pages
  code-refs <symbol> [--lang l]      Find all references to a symbol (JSON-first)
  code-callers <symbol>              Who calls this symbol? (v0.20.0 A1)
  code-callees <symbol>              What does this symbol call? (v0.20.0 A1)
  query <q> --lang <l>               Filter hybrid search to one language (v0.20.0)
  query <q> --symbol-kind <k>        Filter to symbol type (function|class|method|...) (v0.20.0)
  reconcile-links [--dry-run]        Batch-recompute doc↔impl edges (v0.20.0)
  reindex-code [--source id] [--yes] Explicit code-page reindex (v0.20.0)
  reindex-search-vector [--dry-run] [--yes] [--json]
                                Recreate FTS triggers + backfill under
                                $GBRAIN_FTS_LANGUAGE (default 'english')
  sync --strategy code               Sync code files into the brain

JOBS (Minions)
  jobs submit <name> [--params JSON]  Submit background job [--follow] [--dry-run]
  jobs list [--status S] [--limit N]  List jobs
  jobs get <id>                       Job details + history
  jobs cancel <id>                    Cancel job
  jobs retry <id>                     Re-queue failed/dead job
  jobs prune [--older-than 30d]       Clean old jobs
  jobs stats                          Job health dashboard
  jobs work [--queue Q]               Start worker daemon (Postgres only)

ADMIN
  stats                              Brain statistics
  health                             Brain health dashboard
  history <slug>                     Page version history
  revert <slug> <version-id>         Revert to version
  features [--json] [--auto-fix]     Scan usage + recommend unused features
  autopilot [--repo] [--interval N]  Self-maintaining brain daemon
  config [show|get|set] <key> [val]  Brain config
  storage status [--repo <path>]     Storage tier status and health
        [--json]                     (git-tracked vs supabase-only)
  serve                              MCP server (stdio)
  serve --http [--port N]            HTTP MCP server with OAuth 2.1
    --token-ttl N                    Access token TTL in seconds (default: 3600)
    --enable-dcr                     Enable Dynamic Client Registration (DCR clients default to authorization_code)
    --enable-dcr-insecure            Also allow the consent-bypassing client_credentials grant on DCR (implies --enable-dcr)
    --public-url URL                 Public issuer URL (required behind proxy/tunnel)
  connect <mcp-url> --token <t>      Wire Claude Code to a remote gbrain (bearer token)
        [--install] [--json]         Print the paste-ready command, or --install to run it
  watch [--json]                     Push-based context: pipe conversation turns in,
                                     volunteered brain pages stream out (#2095)
  call <tool> '<json>'               Raw tool invocation
  version                            Version info
  --tools-json                       Tool discovery (JSON)

Run gbrain <command> --help for command-specific help.
`);
}

// Only auto-run when invoked as the entry point (the compiled binary or
// `bun src/cli.ts`). Guarded so tests can import cliAliases / printOpHelp
// without triggering argv parsing + main(). v114 (#1941).
//
// #2084 — the ONE process-exit seam for one-shot commands. Every teardown site
// routes through finishCliTeardown (which returns); the exit itself happens
// here, after main() settles, so the CLI never waits on Bun's event loop to
// drain (stuck PgBouncer sockets kept it alive — endPoolBounded races PAST a
// stuck pool.end() by design). flushThenExit fences stdout/stderr and holds a
// short aliveness grace so piped output is delivered before exit (#1959).
// Daemons (`serve`) are excluded by shouldForceExitAfterMain and keep the
// pre-#2084 behavior: main() resolves and the server's own work keeps the
// process alive. A fatal error still exits 1 for every command, daemons
// included (matches the prior unconditional process.exit(1) on rejection).
if (import.meta.main) {
  main().then(
    () => {
      if (shouldForceExitAfterMain()) flushThenExit(currentExitCode());
    },
    (e) => {
      console.error(e.message || e);
      flushThenExit(1);
    },
  );
}
