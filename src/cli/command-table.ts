/**
 * CLI-only command table (refactor wave 1, W4 cli).
 *
 * One record per `CLI_ONLY` command. The records are the single source for
 * the membership sets that used to be hand-synced literals in src/cli.ts
 * (`CLI_ONLY`, `CLI_ONLY_SELF_HELP`, `THIN_CLIENT_REFUSED_COMMANDS`,
 * `STARTUP_HOOK_SKIP_COMMANDS`; the `pages` / `calibration` drift class), and
 * for which module runs the command:
 *
 * - `phase: 'pre-connect'` / `'pre-connect-own-engine'`: dispatched by
 *   `dispatchPreConnectCommand` in src/cli.ts handleCliOnly, before the
 *   connectEngine() terminator (engine-free, or the module opens its own
 *   engine through `ctx.connectEngine`). These were plain
 *   `if (command === 'x') { ...; return; }` branches.
 * - `phase: 'post-connect'`: dispatched by `dispatchConnectedCommand` with the
 *   engine the terminator opened. These were the 62 `switch (command)` cases;
 *   records keep master's case order (the thin-client refusal matrix golden
 *   runs them in this order).
 * - `dispatchedBy: 'deferred-persistence'`: capture / forget / call are routed
 *   by handleCliOnly's explicit deferred-persistence step (it also owns
 *   `sources <write-sub>` and `takes <write-sub>`), never by the table step.
 *
 * `thinClient` is the command's thin-client mode (none / refuse /
 * route-then-refuse). Subcommand-aware routing, the thin-client guard itself,
 * degraded-serve recovery and teardown stay an explicit ordered pipeline in
 * handleCliOnly; the table does not express them.
 *
 * Every `load` (and D3 curated `help`, `() => import('./help/<name>.ts')`) is
 * `() => import('<string literal>')` so `bun build --compile` bundles each
 * module and `gbrain --version` loads none of them
 * (test/cli-command-table.test.ts; scripts/check-compile-autoload.sh).
 *
 * Adding a CLI-only command: add a record here plus its module under
 * src/cli/commands/, then `bun run build:flag-registry`.
 */
import type { GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { Effect, Notice } from '../core/agent-output.ts';
import type { OperationContext } from '../core/ops/contract.ts';

export type CliPhase = 'pre-connect' | 'pre-connect-own-engine' | 'post-connect';
export type CliThinClientMode = 'none' | 'refuse' | 'route-then-refuse';

/** What handleCliOnly hands a command module: the dispatcher-owned pieces a moved body used to close over. */
export interface CliDispatchContext {
  connectEngine(opts?: { probeOnly?: boolean }): Promise<BrainEngine>;
  /** A4: finish startup (migrations, marker cleanup, config merge) on an observational command's engine once consent is granted. */
  completeStartup?(engine: BrainEngine): Promise<void>;
  dbMarkerBrainId(): string | undefined;
  SELECTED_CONFIG_BY_ENGINE: Pick<WeakMap<BrainEngine, GBrainConfig>, 'get'>;
  /** import.meta.url of src/cli.ts, for paths the moved bodies resolved relative to it. */
  cliModuleUrl: string;
  /** Agent contract v1 (A6): CLI notice channel (TTY stderr lines, non-TTY `[AGENT]` block, `--json` `notices`). */
  emitNotice?: (n: Notice) => void;
  /** The CLI's trusted-local operation context (src/cli.ts makeContext), for a command that submits coordinated writes. */
  makeContext?: (engine: BrainEngine, params: Record<string, unknown>) => Promise<OperationContext>;
}

/** One curated flag in a lazy help module (D3). */
export interface CliHelpFlag {
  name: string;
  type: 'boolean' | 'string' | 'number' | 'enum';
  values?: readonly string[];
  desc: string;
  /** Effects the flag authorizes or triggers (e.g. `--yes` on paid work). */
  consent?: readonly Effect[];
}

/** Curated help spec loaded lazily from `src/cli/help/<command>.ts` (D3). */
export interface CliHelpSpec {
  summary: string;
  usage: string;
  flags: readonly CliHelpFlag[];
  examples: readonly string[];
  end_of_options?: true;
}

export interface PreConnectCommandModule {
  run(args: string[], ctx: CliDispatchContext): Promise<void>;
}

export interface ConnectedCommandModule {
  run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void>;
}

interface CliCommandBase {
  name: string;
  thinClient: CliThinClientMode;
  /** The handler prints its own --help (member of CLI_ONLY_SELF_HELP). */
  selfHelp?: true;
  /** Skip the startup update check and mark children (member of STARTUP_HOOK_SKIP_COMMANDS). */
  skipStartupHooks?: true;
  /** Agent contract v1 (D2): the command's `--json` output contract; turns the stdout guard on. */
  json?: 'document' | 'ndjson';
  /**
   * D2: per-subcommand `--json` contracts for a record whose subcommands
   * differ in shape (keyed by the first positional after the command); a
   * subcommand not listed keeps its current stdout.
   */
  jsonSubcommands?: Readonly<Record<string, 'document' | 'ndjson'>>;
  /** The whole invocation, startup included, is read-only (eligible as a `fix.verify`). */
  read_only?: true;
  /** A4: consent-gated command; connects probe-only until consent is granted. */
  startup?: 'observational';
  /** Honours a bare `--` as end of options (positionals after it are never flags). */
  end_of_options?: true;
  /**
   * A1: the command's target source resolves through the ambient chain
   * (`--source` → GBRAIN_SOURCE → .gbrain-source → …), so a fix naming it
   * carries `--source <id>` (src/core/fix-routing.ts). Requires consumption
   * evidence in the generated registry (test/fix-routing.test.ts).
   */
  routes_source?: true;
  /** D3: lazy curated help module. */
  help?: () => Promise<{ help: CliHelpSpec }>;
}

export type CliCommandRecord =
  | (CliCommandBase & {
    phase: 'pre-connect' | 'pre-connect-own-engine';
    dispatchedBy?: undefined;
    load: () => Promise<PreConnectCommandModule>;
  })
  | (CliCommandBase & {
    phase: 'post-connect';
    dispatchedBy?: undefined;
    load: () => Promise<ConnectedCommandModule>;
  })
  | (CliCommandBase & {
    phase: 'pre-connect-own-engine';
    dispatchedBy: 'deferred-persistence';
    load: () => Promise<unknown>;
  });

export const CLI_COMMANDS: readonly CliCommandRecord[] = [  // Pre-connect: dispatched by dispatchPreConnectCommand before the connectEngine() terminator.
  // selfHelp: v0.40.6.0 Schema Cathedral v3 — `gbrain schema --help` should hit schema.ts
  // printHelp() with the full 22+ verb taxonomy, not the generic short-circuit's one-line stub.
  { name: 'schema', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/schema.ts') },
  // selfHelp: MEMORY_VERBS v1 (Cathedral 1): protocol ships its own detailed HELP (subcommands,
  // conformance targets, the cost-gated --synthesize flag).
  { name: 'protocol', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/protocol.ts') },
  { name: 'errors', phase: 'pre-connect', thinClient: 'none', selfHelp: true, json: 'document', read_only: true, load: () => import('./commands/errors.ts') },
  { name: 'notices', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/notices.ts') },
  // selfHelp: `gbrain init --help` prints its own usage from runInit; route around the generic
  // one-line short-circuit (matches `connect`). Without this, `init` is in CLI_ONLY but not
  // CLI_ONLY_SELF_HELP, so the dispatcher's generic short-circuit fires and the printInitHelp()
  // guard in init.ts is dead code.
  { name: 'init', phase: 'pre-connect', thinClient: 'none', selfHelp: true, json: 'document', load: () => import('./commands/init.ts') },
  { name: 'bench', phase: 'pre-connect', thinClient: 'none', selfHelp: true, json: 'ndjson', load: () => import('./commands/bench.ts') },
  // selfHelp: v0.37 fix wave (deferred TODO, shipped): reinit-pglite has its own --help in
  // runReinitPglite. Routing through SELF_HELP avoids the generic short-circuit so the
  // destructive-action warning text reaches the user.
  { name: 'reinit-pglite', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/reinit-pglite.ts') },
  // selfHelp: A7 readiness: `embeddings enable` prints its own usage; it opens the selected brain's
  // datastore itself (a mount via --brain), so it runs before the connectEngine terminator.
  { name: 'embeddings', phase: 'pre-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/embeddings.ts') },
  // selfHelp: WAL-repair wave: pglite-repair ships its own --help with the dry-run/repair semantics
  // + the un-checkpointed-tail caveat.
  { name: 'pglite-repair', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/pglite-repair.ts') },
  // CLI_ONLY: db-availability loop: both are ENGINE-FREE by design (status must answer and repair
  // must run when the DB is down) — dispatched in handleCliOnly before the connectEngine terminator,
  // like pglite-repair.
  // selfHelp: db-availability loop: both print their own help (engine-free).
  { name: 'engine', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/engine.ts') },
  { name: 'db-repair', phase: 'pre-connect', thinClient: 'none', selfHelp: true, json: 'document', load: () => import('./commands/db-repair.ts') },
  // selfHelp: #4003: auth ships its own detailed usage (token/OAuth-client commands + flags) in its
  // `default:` switch case, hit whenever the subcommand isn't one of create/list/revoke/etc —
  // including --help. Without this entry the generic short-circuit fires first and that usage block
  // is dead code.
  { name: 'auth', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/auth.ts') },
  // CLI_ONLY: Google connector + generic credential vault (engine-free; vault-only).
  // selfHelp: v0.47 gmail-loops family: google (HELP in google.ts), creds (HELP in creds.ts), loops
  // + waiting (usage blocks in loops.ts). All engine-free or help-before-engine; the generic stub
  // would hide the [SHOW USER] setup contract agents depend on.
  { name: 'google', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/google.ts') },
  { name: 'creds', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/creds.ts') },
  { name: 'remote', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/remote.ts') },
  // selfHelp: `gbrain connect --help` prints its own usage (flags + examples) from runConnect; route
  // around the generic one-line short-circuit.
  { name: 'connect', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/connect.ts') },
  // CLI_ONLY: Agent-bootstrap family (ENG-2 three-touchpoint rule): `bootstrap` + `hook` are
  // ENGINE-FREE (dispatched in handleCliOnly before the connectEngine terminator) and must NEVER
  // enter THIN_CLIENT_REFUSED_COMMANDS. `sweep` is the trusted local sweep entry [CX2-5] and needs
  // the engine (switch case).
  // selfHelp: Agent-bootstrap family: each prints its own detailed usage (BOOTSTRAP_HELP in
  // bootstrap.ts, the hook USAGE block, SWEEP_HELP). Omitting them here would leave that help dead
  // code behind the generic stub (the init.ts:117 trap ENG-2 names).
  { name: 'bootstrap', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/bootstrap.ts') },
  // skipStartupHooks: hook runs once per harness EVENT (user-prompt fires per prompt): a stale
  // update cache would spawn a detached network-touching check-update child per prompt and emit
  // UPGRADE_AVAILABLE stderr per turn. NOTE: this path no-ops under NODE_ENV=test, so membership is
  // pinned by a source grep (test/hook-command.serial.test.ts), not a runtime test.
  { name: 'hook', phase: 'pre-connect', thinClient: 'none', selfHelp: true, skipStartupHooks: true, load: () => import('./commands/hook.ts') },
  // CLI_ONLY: Monthly backup-coverage check (engine via thunk — pre-engine branch, lock-safe).
  // selfHelp: backup ships its own HELP (runBackupCli guard, engine-free — the command dispatches in
  // the pre-engine lane, so help never touches the PGLite lock).
  { name: 'backup', phase: 'pre-connect-own-engine', thinClient: 'none', selfHelp: true, load: () => import('./commands/backup.ts') },
  { name: 'upgrade', phase: 'pre-connect', thinClient: 'none', selfHelp: true, skipStartupHooks: true, load: () => import('./commands/upgrade.ts') },
  { name: 'post-upgrade', phase: 'pre-connect', thinClient: 'none', selfHelp: true, skipStartupHooks: true, json: 'document', load: () => import('./commands/post-upgrade.ts') },
  { name: 'check-update', phase: 'pre-connect', thinClient: 'none', selfHelp: true, skipStartupHooks: true, load: () => import('./commands/check-update.ts') },
  // selfHelp: v0.42 self-upgrade ships its own usage (flags + the agent-skill story).
  { name: 'self-upgrade', phase: 'pre-connect', thinClient: 'none', selfHelp: true, skipStartupHooks: true, load: () => import('./commands/self-upgrade.ts') },
  { name: 'integrations', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/integrations.ts') },
  { name: 'providers', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/providers.ts') },
  { name: 'resolvers', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/resolvers.ts') },
  { name: 'integrity', phase: 'pre-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/integrity.ts') },
  { name: 'publish', phase: 'pre-connect', thinClient: 'none', load: () => import('./commands/publish.ts') },
  { name: 'check-backlinks', phase: 'pre-connect', thinClient: 'none', load: () => import('./commands/check-backlinks.ts') },
  { name: 'frontmatter', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/frontmatter.ts') },
  { name: 'lint', phase: 'pre-connect', thinClient: 'none', load: () => import('./commands/lint.ts') },
  { name: 'check-resolvable', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/check-resolvable.ts') },
  { name: 'mounts', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/mounts.ts') },
  { name: 'cache', phase: 'pre-connect', thinClient: 'route-then-refuse', selfHelp: true, load: () => import('./commands/cache.ts') },
  { name: 'routing-eval', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/routing-eval.ts') },
  { name: 'skillify', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/skillify.ts') },
  { name: 'skillpack', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/skillpack.ts') },
  { name: 'friction', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/friction.ts') },
  { name: 'claw-test', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/claw-test.ts') },
  { name: 'report', phase: 'pre-connect', thinClient: 'none', load: () => import('./commands/report.ts') },
  { name: 'apply-migrations', phase: 'pre-connect', thinClient: 'refuse', json: 'document', help: () => import('./help/apply-migrations.ts'), load: () => import('./commands/apply-migrations.ts') },
  { name: 'repair-jsonb', phase: 'pre-connect', thinClient: 'refuse', load: () => import('./commands/repair-jsonb.ts') },
  { name: 'skillpack-check', phase: 'pre-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/skillpack-check.ts') },
  { name: 'doctor', phase: 'pre-connect-own-engine', thinClient: 'none', json: 'document', help: () => import('./help/doctor.ts'), load: () => import('./commands/doctor.ts') },
  // CLI_ONLY: cathedral-5: deterministic compiled-context views (engine-needing; refused on thin
  // clients; help answers engine-free).
  // selfHelp: cathedral-5: compile-context ships its own detailed usage (targets, check-mode exit
  // codes). Without this the generic stub hides it.
  // thin client: cathedral-5: compiled views read the LOCAL brain (thin clients have no engine to
  // compile from; remote-brain support is a filed follow-up).
  { name: 'compile-context', phase: 'pre-connect-own-engine', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/compile-context.ts') },
  { name: 'smoke-test', phase: 'pre-connect', thinClient: 'none', load: () => import('./commands/smoke-test.ts') },
  // selfHelp: #4152: dream ships its own printHelp AND the `dream retriage --help` subverb help
  // (dispatched engine-free before parseArgs). The generic stub would hide both — `gbrain dream
  // retriage --help` printed the one-line dream stub instead of the retriage contract (outside-voice
  // CX9).
  // thin client: v0.31.1 (CDX-2 op coverage matrix): more local-only commands
  { name: 'dream', phase: 'pre-connect-own-engine', thinClient: 'refuse', selfHelp: true, json: 'document', routes_source: true, load: () => import('./commands/dream.ts') },
  // System One decide: local CLI only (calibrate, receipts and proposals are trusted-local); help and a
  // key-only probe answer without a brain, so the module opens its own engine.
  { name: 'decide', phase: 'pre-connect-own-engine', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/decide.ts') },
  // #5836 facts relink: trusted local CLI only (publishes onto the host's entity pages through the write
  // coordinator); help answers without a brain, so the module opens its own engine.
  { name: 'facts', phase: 'pre-connect-own-engine', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/facts.ts') },
  // #5401: projections drain refuses a resident-held PGLite brain before any engine opens, so the
  // module opens its own engine. Trusted local CLI only (not an operation).
  { name: 'projections', phase: 'pre-connect-own-engine', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/projections.ts') },

  // Dispatched by handleCliOnly's explicit deferred-persistence step (never by the table step).
  // selfHelp: v0.39.3.0 WARN-5: capture's detailed HELP constant (src/commands/capture.ts:90+) was
  // unreachable because the dispatcher's generic short-circuit (printCliOnlyHelp at :204-208) fired
  // before runCapture saw --help. brainstorm + lsd were already in the set; capture was the holdout.
  { name: 'capture', phase: 'pre-connect-own-engine', thinClient: 'none', selfHelp: true, dispatchedBy: 'deferred-persistence', routes_source: true, load: () => import('../commands/persistence-delegate.ts') },
  { name: 'forget', phase: 'pre-connect-own-engine', thinClient: 'none', dispatchedBy: 'deferred-persistence', load: () => import('../commands/persistence-delegate.ts') },
  { name: 'call', phase: 'pre-connect-own-engine', thinClient: 'refuse', dispatchedBy: 'deferred-persistence', load: () => import('../commands/persistence-delegate.ts') },

  // Post-connect: dispatched by dispatchConnectedCommand after connectEngine(), in master switch order.
  { name: 'mcp', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/mcp.ts') },
  { name: 'import', phase: 'post-connect', thinClient: 'none', json: 'document', help: () => import('./help/import.ts'), routes_source: true, load: () => import('./commands/import.ts') },
  { name: 'export', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/export.ts') },
  { name: 'files', phase: 'post-connect', thinClient: 'refuse', routes_source: true, load: () => import('./commands/files.ts') },
  { name: 'embed', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, json: 'document', routes_source: true, startup: 'observational', load: () => import('./commands/embed.ts') },
  { name: 'serve', phase: 'post-connect', thinClient: 'refuse', help: () => import('./help/serve.ts'), load: () => import('./commands/serve.ts') },
  // thin client: Agent-bootstrap [CX2-5]: the maintenance sweep runs against the LOCAL engine (the
  // serve-resident sweep's trusted CLI entry). On a thin client it would fabricate a scratch PGLite
  // and sweep nothing anyone reads. `bootstrap` and `hook` are deliberately NOT here (ENG-2).
  { name: 'sweep', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/sweep.ts') },
  // thin client: scratch-DB audit: `config` get/set operate on the host brain's config plane (DB
  // rows / host file-plane). On a thin client they fabricated an ephemeral local PGLite (full
  // migration replay per call) and read/wrote config nobody would ever see. NOTE: `jobs` is
  // deliberately NOT here — it gets a partial dispatch (list/get route over MCP engine-free, the
  // rest refuse) in the main dispatch before connectEngine().
  { name: 'config', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/config.ts') },
  // thin client: pricing writes the host brain's `pricing.overrides`. Registration is trusted-local
  // only: a remote caller could declare $0 and void a cost cap, so it is never an operation either.
  { name: 'pricing', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/pricing.ts') },
  { name: 'migrate', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/migrate.ts') },
  { name: 'retrieval-upgrade', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/retrieval-upgrade.ts') },
  // selfHelp: #3686 (the #578 residue): eval / storage / reindex each ship real usage — eval's
  // printHelp (15 subcommands), storage's status usage, reindex's target-flag usage — that the
  // generic one-line stub was hiding. Their engine-free --help is answered by pre-engine branches in
  // handleCliOnly (the sync/capture pattern).
  { name: 'eval', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, jsonSubcommands: { export: 'ndjson', replay: 'ndjson', gate: 'ndjson' }, load: () => import('./commands/eval.ts') },
  // selfHelp: jobs ships JOBS_HELP + a per-subcommand record (JOBS_SUBCOMMAND_HELP) in jobs.ts,
  // guarded BEFORE the thin-client refusal and the subcommand switch so `jobs work --help` prints
  // help instead of starting a worker daemon. Without this entry the generic stub hid the worker
  // entry point entirely.
  { name: 'jobs', phase: 'post-connect', thinClient: 'route-then-refuse', selfHelp: true, load: () => import('./commands/jobs.ts') },
  // selfHelp: cathedral-6: agent ships per-subcommand help (run/logs/register) inside runAgent,
  // answered before any engine or queue is touched. Paired with the SELF_HELP_WITHOUT_ENGINE entry
  // below so a brainless machine gets real help, and with the `--`-aware help scan in main() so
  // `agent run -- --help` submits the literal prompt instead.
  { name: 'agent', phase: 'post-connect', thinClient: 'none', selfHelp: true, end_of_options: true, load: () => import('./commands/agent.ts') },
  { name: 'book-mirror', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/book-mirror.ts') },
  // selfHelp: v0.37 fix wave (Lane D.4 + CDX2-12): sync's --no-embed flag was unreachable via help
  // because the dispatcher's generic CLI-only short-circuit fired before runSync could print its own
  // usage block. Adding `sync` here routes `gbrain sync --help` into runSync.
  { name: 'sync', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, json: 'document', routes_source: true, load: () => import('./commands/sync.ts') },
  // selfHelp: #3834: extract ships detailed help for its mode-specific flags. Keep the generic
  // CLI-only stub from hiding that contract.
  { name: 'extract', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/extract.ts') },
  // selfHelp: v0.41.11.0 — extract-conversation-facts ships its own detailed HELP describing segment
  // splitting + checkpointing + budget caps + the unified types config story. Route around the
  // generic short-circuit.
  { name: 'extract-conversation-facts', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/extract-conversation-facts.ts') },
  // selfHelp: v0.41.39 (#1700) — enrich ships its own detailed HELP (ordering, budget best-effort
  // caveat, provenance, --reenrich-after). Route around the stub.
  { name: 'enrich', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/enrich.ts') },
  { name: 'features', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/features.ts') },
  { name: 'autopilot', phase: 'post-connect', thinClient: 'none', help: () => import('./help/autopilot.ts'), load: () => import('./commands/autopilot.ts') },
  { name: 'graph-query', phase: 'post-connect', thinClient: 'none', selfHelp: true, routes_source: true, load: () => import('./commands/graph-query.ts') },
  { name: 'reconcile-links', phase: 'post-connect', thinClient: 'none', load: () => import('./commands/reconcile-links.ts') },
  // selfHelp: gbrain repair prints REPAIR_HELP (kinds + dry-run/apply contract).
  // thin client: Wave 2 repair core: repairs publish coordinated writes on the brain host.
  { name: 'repair', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/repair.ts') },
  { name: 'orphans', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/orphans.ts') },
  // selfHelp: maintain (#3015) prints its own usage block (modes + not-auto-applied list).
  { name: 'maintain', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/maintain.ts') },
  { name: 'reindex', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/reindex.ts') },
  { name: 'salience', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/salience.ts') },
  { name: 'anomalies', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/anomalies.ts') },
  { name: 'feedback', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/feedback.ts') },
  { name: 'status', phase: 'post-connect', thinClient: 'none', help: () => import('./help/status.ts'), load: () => import('./commands/status.ts') },
  { name: 'advisor', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/advisor.ts') },
  { name: 'conversation-parser', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/conversation-parser.ts') },
  { name: 'edges-backfill', phase: 'post-connect', thinClient: 'none', selfHelp: true, routes_source: true, load: () => import('./commands/edges-backfill.ts') },
  // CLI_ONLY: #2035 class (wired the #3502 way): `case 'whoknows'` had a live handler (runWhoknows:
  // ranked table, per-factor explain, thin-client routing) that was shadowed by find_experts'
  // non-hidden cliHints. The op hint is now hidden (ops/insights.ts); this entry makes the richer
  // handler dispatch.
  // selfHelp: whoknows honours --help first (runWhoknows HELP block, whoknows.ts).
  { name: 'whoknows', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/whoknows.ts') },
  { name: 'brainstorm', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/brainstorm.ts') },
  { name: 'lsd', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/lsd.ts') },
  // selfHelp: v0.41.20.0 skillopt's detailed HELP constant lives in src/core/skillopt/help.ts;
  // --help routes there via the dispatcher.
  { name: 'skillopt', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/skillopt.ts') },
  { name: 'calibration', phase: 'post-connect', thinClient: 'none', routes_source: true, load: () => import('./commands/calibration.ts') },
  // selfHelp: cathedral-4: transcripts ships its own HELP (the ingest import lane + the v0.29 recent
  // reader). Without this the generic stub hides both.
  { name: 'transcripts', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/transcripts.ts') },
  { name: 'models', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/models.ts') },
  // selfHelp: `gbrain takes --help` printed the generic one-line stub, so the nine subcommands
  // (add/update/supersede/resolve/scorecard/calibration/revisit/ extract/search) were undiscoverable
  // from the CLI — the detailed usage block in runTakes (src/commands/takes.ts) was unreachable.
  // Same holdout pattern as `capture`, `sync`, and `schema` above.
  // thin client: v0.31.1 CDX-2 audit: takes/sources have multiple subcommands; some
  // (takes_list/takes_search, sources_list/sources_status) have MCP equivalents and others are
  // file-system bound (takes mutate commands edit local .md files). v0.31.1 refuses both at the top
  // level with a hint pointing at the routable MCP tools; per-subcommand splits are a v0.31.x
  // follow-up TODO.
  { name: 'takes', phase: 'post-connect', thinClient: 'route-then-refuse', selfHelp: true, load: () => import('./commands/takes.ts') },
  { name: 'onboard', phase: 'post-connect', thinClient: 'none', help: () => import('./help/onboard.ts'), load: () => import('./commands/onboard.ts') },
  { name: 'founder', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/founder.ts') },
  { name: 'think', phase: 'post-connect', thinClient: 'none', selfHelp: true, routes_source: true, load: () => import('./commands/think.ts') },
  { name: 'recall', phase: 'post-connect', thinClient: 'none', routes_source: true, load: () => import('./commands/recall.ts') },
  // CLI_ONLY: v0.42.58 (#2035 class, caught by the handleCliOnly reachability sweep): full handler
  // at `case 'notability-eval'` but never dispatchable.
  { name: 'notability-eval', phase: 'post-connect', thinClient: 'none', load: () => import('./commands/notability-eval.ts') },
  // selfHelp: sources ships its own printHelp() (sources.ts, wired to `case '--help'`) covering all
  // ~28 subcommands, but was missing from this set — so `gbrain sources --help` hit the generic
  // one-line stub, which itself says "run gbrain --help for the full command list", and the
  // top-level help's own SOURCES block promises `sources --help` as the place to find the long tail
  // (rename, default, attach, current, federate, set-cr-mode, webhook, harden, ...). That made the
  // pointer circular and those subcommands undiscoverable from the CLI in either direction.
  { name: 'sources', phase: 'post-connect', thinClient: 'route-then-refuse', selfHelp: true, load: () => import('./commands/sources.ts') },
  // CLI_ONLY: Open-loop engine CLI (engine-bound; trusted-local op dispatch).
  { name: 'waiting', phase: 'post-connect', thinClient: 'none', selfHelp: true, routes_source: true, load: () => import('./commands/waiting.ts') },
  { name: 'loops', phase: 'post-connect', thinClient: 'none', selfHelp: true, routes_source: true, load: () => import('./commands/loops.ts') },
  // CLI_ONLY: relationship-contradiction proposals (temporal typed edges); host-local, writes canonical timeline lines.
  { name: 'edge-proposals', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/edge-proposals.ts') },
  // selfHelp: core prints its own usage (commands/core.ts). Always-loaded core memory, docs/guides/core-memory.md.
  { name: 'core', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/core.ts') },
  // selfHelp: connectors ships its own printHelp (commands/connectors/index.ts) with the
  // per-subcommand usage; keep the generic short-circuit from hiding it.
  { name: 'connectors', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/connectors.ts') },
  // selfHelp: #3502 sweep: pages + bench print their own usage (pages.ts printHelp, bench-publish.ts
  // printHelp). Both were documented but undispatchable — `pages` had a live handleCliOnly case but
  // was missing from CLI_ONLY (the #2035 calibration bug class); `bench` was never wired at all.
  // thin client: v0.32 thin-client routing audit (Codex round 2 findings #2, #4): - `pages`
  // purge-deleted is admin+localOnly (operations.ts:856-864) - `files` list / file_url MCP ops are
  // localOnly (operations.ts:1769-1879) - `eval` export/prune/replay have no MCP equivalents -
  // `code-def`/`code-refs`/`code-callers`/`code-callees` have NO MCP ops in operations.ts:2630-2671;
  // cannot be "fixed by routing" yet
  { name: 'pages', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/pages.ts') },
  { name: 'quarantine', phase: 'post-connect', thinClient: 'route-then-refuse', load: () => import('./commands/quarantine.ts') },
  // selfHelp: v0.43 (#2095): watch ships WATCH_HELP (flags + the stdin-turn protocol).
  // thin client: v0.43 (#2095): watch streams against a LOCAL engine; thin clients get the
  // volunteer_context MCP op instead.
  { name: 'watch', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, routes_source: true, load: () => import('./commands/watch.ts') },
  { name: 'storage', phase: 'post-connect', thinClient: 'refuse', selfHelp: true, load: () => import('./commands/storage.ts') },
  { name: 'code-def', phase: 'post-connect', thinClient: 'refuse', routes_source: true, load: () => import('./commands/code-def.ts') },
  { name: 'code-refs', phase: 'post-connect', thinClient: 'refuse', routes_source: true, load: () => import('./commands/code-refs.ts') },
  { name: 'reindex-code', phase: 'post-connect', thinClient: 'none', routes_source: true, load: () => import('./commands/reindex-code.ts') },
  { name: 'reindex-search-vector', phase: 'post-connect', thinClient: 'none', load: () => import('./commands/reindex-search-vector.ts') },
  { name: 'reindex-frontmatter', phase: 'post-connect', thinClient: 'none', load: () => import('./commands/reindex-frontmatter.ts') },
  { name: 'backfill', phase: 'post-connect', thinClient: 'none', selfHelp: true, load: () => import('./commands/backfill.ts') },
  { name: 'code-callers', phase: 'post-connect', thinClient: 'refuse', routes_source: true, load: () => import('./commands/code-callers.ts') },
  { name: 'code-callees', phase: 'post-connect', thinClient: 'refuse', routes_source: true, load: () => import('./commands/code-callees.ts') },
  { name: 'repos', phase: 'post-connect', thinClient: 'none', load: () => import('./commands/repos.ts') },
];

const BY_NAME = new Map<string, CliCommandRecord>();
for (const record of CLI_COMMANDS) {
  if (BY_NAME.has(record.name)) throw new Error(`CLI command table: duplicate record '${record.name}' in src/cli/command-table.ts`);
  BY_NAME.set(record.name, record);
}

export function findCliCommand(name: string): CliCommandRecord | undefined {
  return BY_NAME.get(name);
}

/** CLI-only commands that bypass the operation layer. */
export const CLI_ONLY: ReadonlySet<string> = new Set(CLI_COMMANDS.map(c => c.name));

/**
 * CLI-only commands whose handlers print their own --help text. These are
 * excluded from the generic short-circuit so detailed per-command and
 * per-subcommand usage stays reachable.
 */
export const CLI_ONLY_SELF_HELP: ReadonlySet<string> = new Set(CLI_COMMANDS.filter(c => c.selfHelp).map(c => c.name));

/**
 * Thin-client modes whose routing lives in explicit handleCliOnly code rather
 * than the refused set: `cache` and `quarantine` are extra literals in the
 * thin-client guard's condition, and `jobs` routes list/get/stats and refuses
 * the rest inside its own pre-connect branch. Master kept all three out of
 * THIN_CLIENT_REFUSED_COMMANDS; the derived set preserves that.
 */
const THIN_CLIENT_ROUTED_OUTSIDE_REFUSED_SET: ReadonlySet<string> = new Set(['cache', 'quarantine', 'jobs']);

/**
 * Commands the handleCliOnly thin-client guard refuses (after per-subcommand
 * MCP routing for the route-then-refuse ones). `bootstrap` and `hook` must
 * NEVER appear here (ENG-2): they are engine-free and must work on any
 * install shape.
 */
export const THIN_CLIENT_REFUSED_COMMANDS: ReadonlySet<string> = new Set(
  CLI_COMMANDS.filter(c => c.thinClient !== 'none' && !THIN_CLIENT_ROUTED_OUTSIDE_REFUSED_SET.has(c.name)).map(c => c.name),
);

/**
 * v0.42 self-upgrade: commands that must NOT trigger the startup update-check
 * (they ARE the update path, or are trivial/no-DB) and which set
 * GBRAIN_SKIP_STARTUP_HOOKS for any children they spawn.
 */
export const STARTUP_HOOK_SKIP_COMMANDS: ReadonlySet<string> = new Set(CLI_COMMANDS.filter(c => c.skipStartupHooks).map(c => c.name));
