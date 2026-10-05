/**
 * `gbrain migrate` engine graduation (PGLite -> Postgres): the CLI over the
 * orchestrator in src/core/persistence/engine-graduation.ts.
 *
 * Dispatched before connectEngine() (src/cli.ts routeEngineFreeSubcommands):
 * the orchestrator owns both connections, so `--plan` and `--status` migrate
 * neither schema, and the run holds the source's kernel lock itself.
 *
 *   gbrain migrate --to postgres|supabase [--url <url> | --url - | --url-env <VAR>]
 *     (no --yes)            the plan as a confirmation_required payload, exit 3
 *     --plan | --dry-run    the read-only plan, exit 0
 *     --yes --expect <hash> the run; ends with the target doctor result
 *   gbrain migrate --status | --resume | --rollback-to-source   (the run in the manifest)
 *   gbrain migrate --discard-source [--dry-run] [--yes --expect <hash>]   (delete the retained copy once graduated)
 *
 * Exit codes: 0 graduated / plan shown / discarded; 3 confirmation_required; 1 refusals;
 * 2 usage; 11 resumable drain stop; 75 graduation_in_progress; 130 SIGINT.
 * `--json` prints one document on stdout; progress goes to stderr.
 */
import { cliRenderContext, shellQuote, type Effect } from '../core/agent-output.ts';
import { buildConsentRefusal, isConsentRefusal, printConsentRefusal, requireConsent, type ConsentRequest } from '../core/consent.ts';
import { loadConfigFileOnly, type GBrainConfig } from '../core/config.ts';
import { cliOptsToProgressOptions, getCliOptions } from '../core/cli-options.ts';
import { setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { readStdinBounded } from '../core/interaction.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { createProgress, type ProgressReporter } from '../core/progress.ts';
import type {
  GraduationCommandOptions, GraduationPhase, GraduationPlan, GraduationProgressSink, GraduationReceipt,
  GraduationRollbackResult, GraduationStatusDoc, GraduationTargetSpelling, TriggerBypass,
} from '../core/persistence/engine-graduation.types.ts';
import type { DiscardOptions, DiscardPlan, DiscardResult } from '../core/persistence/graduation-discard.ts';
import { DEFAULT_TARGET_URL_ENV, discardArgv, planArgv, resumeArgv, statusArgv } from '../core/persistence/graduation-errors.ts';
import { humanBytes } from '../core/pglite-leftovers-check.ts';
import { writeCliError } from '../cli/cli-error.ts';

export type GraduationMode = 'plan' | 'run' | 'status' | 'resume' | 'rollback' | 'discard';

export interface GraduationArgs {
  mode: GraduationMode;
  /** The spelling typed after --to (absent on run-scoped verbs without it). */
  to?: GraduationTargetSpelling;
  url?: string;
  urlFromStdin: boolean;
  urlEnv?: string;
  drainTimeoutSec: number;
  drainTimeoutGiven: boolean;
  triggerBypass?: TriggerBypass;
  batchSize?: number;
  force: boolean;
  yes: boolean;
  expect?: string;
  json: boolean;
  /** `--discard-source --dry-run` (or `--plan`): the read-only discard plan. */
  dryRun: boolean;
}

export const DEFAULT_DRAIN_TIMEOUT_SEC = 60;

/** The orchestrator surface the CLI calls (a test seam; production imports engine-graduation.ts). */
export interface GraduationApi {
  planGraduation(opts: GraduationCommandOptions): Promise<GraduationPlan>;
  runGraduation(opts: GraduationCommandOptions): Promise<GraduationReceipt>;
  graduationStatus(): Promise<GraduationStatusDoc>;
  resumeGraduation(opts: GraduationCommandOptions): Promise<GraduationReceipt>;
  rollbackGraduation(opts: GraduationCommandOptions): Promise<GraduationRollbackResult>;
  planDiscardSource(opts?: DiscardOptions): Promise<DiscardPlan>;
  discardSource(opts: DiscardOptions): Promise<DiscardResult>;
}

export interface GraduationCliDeps {
  api?: GraduationApi;
  env?: NodeJS.ProcessEnv;
  /** One stdout document / human text. */
  out?: (text: string) => void;
  /** Human status lines (stderr). */
  err?: (text: string) => void;
  progress?: ProgressReporter;
  readStdin?: () => Promise<string | null>;
  /** SIGINT wiring; tests pass their own controller. */
  signal?: AbortSignal;
  /** Error writer (default writeCliError); `legacy` keys join the --json envelope. */
  writeError?: (e: unknown, opts: { json: boolean; legacy?: Record<string, unknown> }) => number;
}

export const GRADUATION_USAGE = [
  'Usage: gbrain migrate --to postgres|supabase [--url <url> | --url - | --url-env <VAR>] [--plan | --dry-run] [--yes --expect <plan_hash>]',
  '         [--drain-timeout <seconds>] [--trigger-bypass replica|disable-trigger] [--batch-size <n>] [--force] [--json]',
  '       gbrain migrate --status [--json]',
  '       gbrain migrate --resume [--drain-timeout <seconds>] [--url-env <VAR>] [--json]',
  '       gbrain migrate --rollback-to-source [--yes --expect <hash>] [--json]',
  '       gbrain migrate --discard-source [--dry-run] [--yes --expect <hash>] [--json]',
].join('\n');

const MODE_FLAGS: ReadonlyArray<[string, GraduationMode]> = [
  ['--plan', 'plan'], ['--dry-run', 'plan'], ['--status', 'status'], ['--resume', 'resume'], ['--rollback-to-source', 'rollback'],
  ['--discard-source', 'discard'],
];

function usage(message: string, suggestion: string): OperationError {
  return opError('invalid_params', message, suggestion, {
    fix: { argv: ['gbrain', 'migrate', '--help'], consent: [], actor: 'agent', requires_exclusive: false, why: 'The help lists every graduation flag.' },
  });
}

function flagValue(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const v = args[i + 1];
      if (v === undefined || (v.startsWith('--') && v !== '-')) throw usage(`${name} needs a value.`, `Give ${name} its value right after it, as ${name} VALUE or ${name}=VALUE.`);
      return v;
    }
    if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
  }
  return undefined;
}

function positiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) throw usage(`${name} must be a positive whole number (got "${raw}").`, `Pass ${name} as a positive whole number, e.g. ${name} ${name === '--batch-size' ? 500 : 60}.`);
  return Number(raw);
}

export function parseGraduationArgs(args: readonly string[]): GraduationArgs {
  const modes = MODE_FLAGS.filter(([f]) => args.includes(f));
  let distinct = [...new Set(modes.map(([, m]) => m))];
  // --discard-source previews with --dry-run (or --plan), like the move itself.
  const dryRun = distinct.includes('discard') && distinct.includes('plan');
  if (dryRun) distinct = distinct.filter(m => m !== 'plan');
  if (distinct.length > 1) throw usage(`${modes.map(([f]) => f).join(' and ')} cannot be combined; pick one.`,
    'Run one mode per command: preview with --plan, then the run itself with --yes --expect PLAN_HASH; --status, --resume, --rollback-to-source and --discard-source each run alone.');
  const mode: GraduationMode = distinct[0] ?? 'run';
  const toRaw = flagValue(args, '--to');
  if (toRaw !== undefined && toRaw !== 'postgres' && toRaw !== 'supabase') {
    throw usage(`Engine graduation moves a PGLite brain to Postgres; --to ${toRaw} is not a graduation target.`,
      toRaw === 'pglite'
        ? 'A Postgres -> PGLite move uses the legacy copier and has no plan, status, resume or rollback: run `gbrain migrate --to pglite` without them.'
        : 'Use --to postgres (alias supabase).');
  }
  if ((mode === 'plan' || mode === 'run') && toRaw === undefined) throw usage('Name the target engine: --to postgres (alias supabase).',
    `Preview first with gbrain migrate --to postgres --url-env ${DEFAULT_TARGET_URL_ENV} --plan.`);
  const urlRaw = flagValue(args, '--url');
  const urlEnv = flagValue(args, '--url-env');
  if (urlRaw !== undefined && urlEnv !== undefined) throw usage('--url and --url-env cannot be combined; prefer --url-env so the URL never appears in a command line.',
    `Keep --url-env (e.g. --url-env ${DEFAULT_TARGET_URL_ENV}) and drop --url.`);
  if (mode === 'status' && (args.includes('--yes') || args.includes('--force'))) throw usage('--status is read-only; it takes no --yes or --force.', 'Run gbrain migrate --status (add --json for the machine form) without --yes or --force.');
  if (mode === 'discard' && (toRaw !== undefined || urlRaw !== undefined || urlEnv !== undefined || args.includes('--force'))) {
    throw usage('--discard-source acts on the recorded run; it takes no --to, --url, --url-env or --force.',
      'Run gbrain migrate --discard-source --dry-run; to record a changed target URL first, run gbrain migrate --resume --url-env VAR.');
  }
  const bypass = flagValue(args, '--trigger-bypass');
  if (bypass !== undefined && bypass !== 'replica' && bypass !== 'disable-trigger') throw usage(`--trigger-bypass takes replica or disable-trigger (got "${bypass}").`,
    'Pass --trigger-bypass replica or --trigger-bypass disable-trigger, or omit the flag.');
  const drain = positiveInt(flagValue(args, '--drain-timeout'), '--drain-timeout');
  return {
    mode,
    ...(toRaw ? { to: toRaw } : {}),
    ...(urlRaw !== undefined && urlRaw !== '-' ? { url: urlRaw } : {}),
    urlFromStdin: urlRaw === '-',
    ...(urlEnv !== undefined ? { urlEnv } : {}),
    drainTimeoutSec: drain ?? DEFAULT_DRAIN_TIMEOUT_SEC,
    drainTimeoutGiven: drain !== undefined,
    ...(bypass ? { triggerBypass: bypass === 'replica' ? 'session_replication_role' : 'disable_trigger' } : {}),
    ...(flagValue(args, '--batch-size') !== undefined ? { batchSize: positiveInt(flagValue(args, '--batch-size'), '--batch-size') } : {}),
    force: args.includes('--force'),
    yes: args.includes('--yes'),
    ...(flagValue(args, '--expect') !== undefined ? { expect: flagValue(args, '--expect') } : {}),
    json: args.includes('--json'),
    dryRun,
  };
}

/** `migrate.graduation` (file plane): only an explicit false opts out. */
export function graduationOptedOut(cfg: GBrainConfig | null): boolean {
  const v = (cfg as { migrate?: { graduation?: unknown } } | null)?.migrate?.graduation;
  return v === false || v === 'false' || v === '0' || v === 'off' || v === 'no';
}

/**
 * Whether this `gbrain migrate` invocation is graduation's. Run-scoped verbs
 * and the plan always are; a bare `--to postgres|supabase` is when the
 * durable (file) config is PGLite, graduation is not opted out, and the host
 * is not Windows (history-free Windows brains keep the legacy copier).
 */
export function routesToGraduation(args: readonly string[], fileCfg: GBrainConfig | null, platform: NodeJS.Platform = process.platform): boolean {
  if (args[0] === 'embeddings' || args.includes('--help') || args.includes('-h')) return false;
  if (MODE_FLAGS.some(([f]) => args.includes(f))) return true;
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? args[toIdx + 1] : args.find(a => a.startsWith('--to='))?.slice(5);
  if (to !== 'postgres' && to !== 'supabase') return false;
  if (!fileCfg || (fileCfg.engine ?? 'pglite') !== 'pglite' || fileCfg.database_url) return false;
  if (graduationOptedOut(fileCfg)) return false;
  return platform !== 'win32';
}

/** What leaves this computer and what stays (the confirmation, success output and guide name both). */
export const WHAT_MOVES: readonly string[] = [
  'pages, facts, takes, versions, links and timeline', 'embeddings', 'transcripts and paid model caches',
  'request history, withdrawals and attribution', 'access-token and OAuth rows (hashes only)',
];
export const WHAT_STAYS: readonly string[] = [
  'file storage object bytes', 'git worktrees and their host bindings', 'the MCP endpoint and OAuth issuer URL',
  'the retained PGLite copy (<path>.graduated-<run_id>), which still holds private memory and token hashes',
];

const CREDENTIALS_NOTE = 'Existing access tokens, OAuth clients and local writer credentials stay valid on Postgres.';
const MCP_RESTART_NOTE = 'A gbrain serve handed the brain over during the move: restart your MCP client (or its gbrain server entry) so it reconnects to Postgres.';

function spellingOf(a: GraduationArgs): { to: GraduationTargetSpelling; urlEnv: string } {
  return { to: a.to ?? 'postgres', urlEnv: a.urlEnv ?? DEFAULT_TARGET_URL_ENV };
}

/** The escape hatches that enter the plan hash, echoed into every emitted command. */
function hatchArgs(a: GraduationArgs): string[] {
  return [
    ...(a.drainTimeoutGiven ? ['--drain-timeout', String(a.drainTimeoutSec)] : []),
    ...(a.triggerBypass ? ['--trigger-bypass', a.triggerBypass === 'session_replication_role' ? 'replica' : 'disable-trigger'] : []),
    ...(a.batchSize ? ['--batch-size', String(a.batchSize)] : []),
    ...(a.force ? ['--force'] : []),
  ];
}

function progressSink(p: ProgressReporter): { sink: GraduationProgressSink; done: () => void } {
  let phase: ProgressReporter | null = null;
  let table: ProgressReporter | null = null;
  const closeTable = () => { table?.finish(); table = null; };
  const closePhase = () => { closeTable(); phase?.finish(); phase = null; };
  return {
    sink: {
      phase(name: GraduationPhase, total?: number) { closePhase(); phase = p.child(`migrate.graduation.${name}`, total); phase.start(`migrate.graduation.${name}`, total); },
      table(relation: string, rows: number) { closeTable(); table = (phase ?? p).child(`table.${relation}`, rows); table.start(`table.${relation}`, rows); },
      batch(_relation: string, rows: number) { table?.tick(rows); },
    },
    done: closePhase,
  };
}

function displayHost(plan: GraduationPlan): string {
  return plan.routes.main || `${plan.target.host}:${plan.target.port}/${plan.target.database}`;
}

function planLines(plan: GraduationPlan, next: string): string {
  const carry = plan.tables.filter(t => t.class === 'carry' || t.class === 'rebind');
  const rows = carry.reduce((n, t) => n + t.rows, 0);
  const other = (c: string) => plan.tables.filter(t => t.class === c).map(t => t.relation);
  const lines = [
    `Move this PGLite brain to Postgres at ${displayHost(plan)}`,
    `  Source:   ${plan.source.dataDir} (brain ${plan.source.brainId})${plan.sourceMeasured === 'at_run_start' ? ' — counts measured at run start (a live serve holds it)' : ''}`,
    `  Carry:    ${carry.length} tables, ${rows} rows (keys preserved)`,
    ...(other('rebuild').length ? [`  Rebuild:  ${other('rebuild').join(', ')}`] : []),
    ...(other('discard').length ? [`  Discard:  ${other('discard').join(', ')}`] : []),
    `  Triggers: ${plan.triggerBypass ?? 'not probed'}`,
    `  Estimate: ${Math.ceil(plan.estimateSeconds.total)}s (copy ${Math.ceil(plan.estimateSeconds.copy)}s, verify ${Math.ceil(plan.estimateSeconds.verify)}s, doctor ${Math.ceil(plan.estimateSeconds.doctor)}s)`,
    `  Moves:    ${WHAT_MOVES.join('; ')}`,
    `  Stays:    ${WHAT_STAYS.join('; ')}`,
  ];
  for (const b of plan.blockers) lines.push(`  Blocker:  ${b.kind} ${b.id}: ${b.detail}${b.argv?.length ? ` — ${shellQuote([...b.argv])}` : ''}`);
  lines.push(`  plan_hash ${plan.planHash}`, `Next: ${next}`);
  return `${lines.join('\n')}\n`;
}

function consentRequest(a: GraduationArgs, plan: GraduationPlan, args: readonly string[]): ConsentRequest {
  const s = spellingOf(a);
  const host = displayHost(plan);
  const people = plan.blockers.filter(b => b.needsUser);
  const before = people.length ? ` Before it can run: ${people.map(b => b.detail).join(' ')}` : '';
  const effects: Effect[] = ['egress', 'destructive'];
  return {
    command: 'migrate', effects, actor: 'agent',
    what: 'Moving this brain to Postgres',
    why: `The brain's database (${WHAT_MOVES.join('; ')}) is copied to ${host}, verified table by table, and only then made authoritative; the PGLite data dir is renamed aside and a tombstone takes its place.`,
    risk: `Data leaves this computer for ${host}. Until a rollback, the PGLite copy is read-only history; rolling back after the move drops what changed on Postgres.`,
    user_message: `Move this brain to Postgres at ${host}? That copies ${WHAT_MOVES.join(', ')}. Staying on this computer: ${WHAT_STAYS.join(', ')}.${before}`,
    argv: ['gbrain', 'migrate', '--to', s.to, '--url-env', s.urlEnv, ...hatchArgs(a)],
    preview_argv: planArgv(s, hatchArgs(a)),
    plan_hash: plan.planHash,
    args,
  };
}

function orchestratorOptions(a: GraduationArgs, url: string | undefined, extra: Partial<GraduationCommandOptions>): GraduationCommandOptions {
  return {
    to: a.to ?? 'postgres',
    ...(url !== undefined ? { url } : {}),
    ...(a.urlEnv !== undefined ? { urlEnv: a.urlEnv } : {}),
    drainTimeoutMs: a.drainTimeoutSec * 1000,
    ...(a.triggerBypass ? { triggerBypass: a.triggerBypass } : {}),
    ...(a.batchSize ? { batchSize: a.batchSize } : {}),
    force: a.force,
    yes: a.yes,
    ...(a.expect ? { expectPlanHash: a.expect } : {}),
    ...extra,
  };
}

function successDoc(receipt: GraduationReceipt) {
  return {
    schema_version: 1 as const,
    status: 'graduated' as const,
    state: 'graduated' as const,
    run_id: receipt.runId,
    target: receipt.targetDisplayUrl ?? null,
    retained_path: receipt.retainedPath ?? null,
    doctor: receipt.doctor ?? null,
    receipt,
    credentials: CREDENTIALS_NOTE,
    next_steps: [{ argv: ['gbrain', 'mcp', 'expose'], command: 'gbrain mcp expose', why: 'Share this brain with agents on other machines (multi-machine use).' }],
    ...(receipt.serveHandoff ? { mcp_client_restart: MCP_RESTART_NOTE } : {}),
  };
}

function successLines(receipt: GraduationReceipt): string {
  const rows = receipt.tables.reduce((n, t) => n + t.rows, 0);
  const failing = receipt.doctor?.target ?? [];
  const seconds = Object.values(receipt.timings).reduce((n, v) => n + v, 0) / 1000;
  return [
    `Graduated to Postgres${receipt.targetDisplayUrl ? ` at ${receipt.targetDisplayUrl}` : ''} (run ${receipt.runId}${seconds ? `, ${seconds.toFixed(0)}s` : ''}).`,
    `  Copied ${receipt.tables.length} tables, ${rows} rows; verify passed; replay probe: ${receipt.replay.status}.`,
    `  Target doctor: ${failing.length ? `failing checks: ${failing.join(', ')}` : 'no failing checks'}.`,
    ...(receipt.retainedPath ? [`  Retained PGLite copy: ${receipt.retainedPath} (still holds private memory and token hashes; deleting it is your call: gbrain migrate --discard-source).`] : []),
    `  ${CREDENTIALS_NOTE}`,
    '  Next: share this brain with other machines: gbrain mcp expose',
    ...(receipt.serveHandoff ? [`  ${MCP_RESTART_NOTE}`] : []),
  ].join('\n') + '\n';
}

function statusLines(doc: GraduationStatusDoc): string {
  if (doc.state === 'none') return 'No engine graduation on record.\n';
  const done = doc.tables.filter(t => t.state === 'copied' || t.state === 'verified').length;
  return [
    `Engine graduation ${doc.runId}: ${doc.state}${doc.liveRun ? ` (running, PID ${doc.liveRun.pid})` : ''}`,
    ...(doc.source ? [`  Source: ${doc.source.dataDir} (brain ${doc.source.brainId})${doc.sourceDiscardedAt ? `, retained copy discarded ${doc.sourceDiscardedAt}` : ''}`] : []),
    ...(doc.target ? [`  Target: ${doc.target.displayUrl} (row ${doc.target.row ?? 'absent'}${doc.target.reachable ? '' : ', unreachable'})`] : []),
    ...(doc.tables.length ? [`  Tables: ${done}/${doc.tables.length} copied`] : []),
    ...(doc.splitBrain ?? []).map(p => `  Split brain: ${p.path} (brain ${p.brainId ?? 'unknown'}, ${p.rows} rows, newest write ${p.newestWriteAt ?? 'unknown'})`),
    ...(doc.nextArgv ? [`Next: ${shellQuote([...doc.nextArgv])}`] : []),
  ].join('\n') + '\n';
}

const DISCARD_LABEL: Readonly<Record<DiscardPlan['paths'][number]['kind'], string>> = {
  retained_copy: 'Retained copy', tombstone: 'Tombstone', intent_marker: 'Intent marker',
};

function sizeOf(p: DiscardPlan['paths'][number]): string {
  return `${p.sizeIncomplete ? '>=' : ''}${humanBytes(p.bytes, p.sizeIncomplete)}`;
}

function discardPlanLines(plan: DiscardPlan, next: string): string {
  return [
    `Discard what graduation run ${plan.runId} kept on this computer (the brain is on Postgres at ${plan.target})`,
    ...plan.paths.map(p => `  ${`${DISCARD_LABEL[p.kind]}:`.padEnd(15)}${p.path} (${sizeOf(p)})${p.kind === 'retained_copy' ? ': private memory and access-token hashes' : ''}`),
    '  Afterwards a rollback to PGLite is no longer possible.',
    `  plan_hash ${plan.planHash}`,
    `Next: ${next}`,
  ].join('\n') + '\n';
}

function discardConsentRequest(plan: DiscardPlan, args: readonly string[]): ConsentRequest {
  const copy = plan.paths.find(p => p.kind === 'retained_copy');
  return {
    command: 'migrate', effects: ['destructive'], actor: 'agent',
    what: 'Deleting the PGLite copy kept after the move to Postgres',
    why: `Graduation run ${plan.runId} moved this brain to Postgres at ${plan.target}, which confirms it is authoritative. This deletes ${plan.paths.map(p => p.path).join(', ')}; the copy still holds private memory and access-token hashes.`,
    risk: 'Afterwards `gbrain migrate --rollback-to-source` is no longer possible, and a gbrain client still configured for the old path no longer gets engine_graduated there.',
    user_message: `After moving your brain to Postgres, gbrain kept the old local copy${copy ? ` at ${copy.path}` : ''}. It still contains your private memory and access-token hashes. Should I delete it? You could then no longer roll back to it.`,
    argv: discardArgv(), preview_argv: discardArgv(['--dry-run']), plan_hash: plan.planHash, args,
  };
}

/** `--discard-source`: the plan (dry run or exit-3 confirmation), then the delete against `--yes --expect`. */
async function runDiscard(a: GraduationArgs, api: GraduationApi, args: readonly string[], json: boolean,
  emit: (doc: unknown, human: string) => void, err: (text: string) => void): Promise<number> {
  if (a.yes && a.expect && !a.dryRun) {
    const result = await api.discardSource({ yes: true, expectPlanHash: a.expect });
    const listed = result.deleted.map(p => `${p.path}${p.kind === 'retained_copy' ? ` (${sizeOf(p)})` : ''}`).join(', ');
    emit({ schema_version: 1, status: result.deleted.length ? 'discarded' : 'nothing_to_discard', run_id: result.runId, source_discarded_at: result.sourceDiscardedAt, deleted: result.deleted },
      result.deleted.length
        ? `Discarded what graduation run ${result.runId} kept on this computer: ${listed}.\n  The brain stays on Postgres at ${result.target}; a rollback to PGLite is no longer possible.\n`
        : `Nothing to discard: graduation run ${result.runId} left nothing on this computer.\n`);
    return 0;
  }
  const plan = await api.planDiscardSource();
  if (!plan.paths.length) {
    emit({ schema_version: 1, status: 'nothing_to_discard', run_id: plan.runId, source_discarded_at: plan.sourceDiscardedAt },
      `Nothing to discard: graduation run ${plan.runId} left nothing on this computer.\n`);
    return 0;
  }
  const next = shellQuote(discardArgv(['--yes', '--expect', plan.planHash]));
  if (a.dryRun) {
    emit({ schema_version: 1, status: 'plan', plan, next: { command: next } }, discardPlanLines(plan, next));
    return 0;
  }
  const req = discardConsentRequest(plan, args);
  try {
    await requireConsent(req, { interactive: false, preapprovals: {} });
  } catch (e) {
    if (!isConsentRefusal(e)) throw e;
    Object.assign(e.consent, { plan });
    if (!json) err(discardPlanLines(plan, e.consent.fix.command ?? ''));
    return printConsentRefusal(e, { json });
  }
  throw buildConsentRefusal(req, cliRenderContext());
}

async function resolveUrl(a: GraduationArgs, deps: GraduationCliDeps): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  if (a.urlEnv !== undefined && !env[a.urlEnv]) {
    throw usage(`${a.urlEnv} is not set; --url-env names the environment variable that holds the target URL.`,
      `Export the Postgres connection string as ${a.urlEnv} in this shell, then run the same command again.`);
  }
  if (!a.urlFromStdin) return a.url;
  const text = deps.readStdin ? await deps.readStdin() : await (async () => {
    const r = await readStdinBounded({ maxBytes: 64 * 1024 });
    return r.kind === 'data' ? r.text : null;
  })();
  const url = text?.trim();
  if (!url) throw usage('--url - reads the target URL from stdin, and stdin was empty.', `Pipe the URL in, or export it and use --url-env ${DEFAULT_TARGET_URL_ENV}.`);
  return url;
}

/** Run one graduation invocation; returns the exit code (output already written). */
export async function runMigrateGraduation(args: readonly string[], deps: GraduationCliDeps = {}): Promise<number> {
  const json = args.includes('--json');
  const out = deps.out ?? ((t: string) => { void writeJsonDocument(t.replace(/\n$/, ''), s => { process.stdout.write(`${s}\n`); }); });
  const err = deps.err ?? ((t: string) => { process.stderr.write(t); });
  const emit = (doc: unknown, human: string) => { if (json) out(`${JSON.stringify(doc, null, 2)}\n`); else out(human); };
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) return;
    err('Interrupt received: stopping at the next batch boundary (the move stays resumable).\n');
    controller.abort();
  };
  const signal = deps.signal ?? controller.signal;
  if (!deps.signal) process.on('SIGINT', onSigint);
  const progress = deps.progress ?? createProgress(cliOptsToProgressOptions(getCliOptions()));
  const { sink, done } = progressSink(progress);
  try {
    const a = parseGraduationArgs(args);
    if ((a.mode === 'plan' || a.mode === 'run') && graduationOptedOut(loadConfigFileOnly())) {
      throw usage('Engine graduation is turned off on this machine (migrate.graduation = false), so there is no plan to show.',
        'Turn it back on with `gbrain config unset migrate.graduation`, or run the legacy copier with `gbrain migrate --to postgres --url <url>` (it refuses brains with write history).');
    }
    const api = deps.api ?? { ...await import('../core/persistence/engine-graduation.ts'), ...await import('../core/persistence/graduation-discard.ts') };
    if (a.mode === 'status') {
      const doc = await api.graduationStatus();
      emit(doc, statusLines(doc));
      return 0;
    }
    if (a.mode === 'discard') return await runDiscard(a, api, args, json, emit, err);
    const url = await resolveUrl(a, deps);
    const opts = orchestratorOptions(a, url, { progress: sink, signal });
    if (a.mode === 'plan') {
      const plan = await api.planGraduation(opts);
      const next = shellQuote(['gbrain', 'migrate', '--to', spellingOf(a).to, '--url-env', spellingOf(a).urlEnv, ...hatchArgs(a), '--yes', '--expect', plan.planHash]);
      emit({ schema_version: 1, status: 'plan', plan, what_moves: WHAT_MOVES, what_stays: WHAT_STAYS, next: { command: next } }, planLines(plan, next));
      return 0;
    }
    if (a.mode === 'run' && !(a.yes && a.expect)) {
      const plan = await api.planGraduation(opts);
      const req = consentRequest(a, plan, args);
      try {
        await requireConsent(req, { interactive: false, preapprovals: {} });
      } catch (e) {
        if (!isConsentRefusal(e)) throw e;
        Object.assign(e.consent, { plan, blockers: plan.blockers, what_moves: WHAT_MOVES, what_stays: WHAT_STAYS });
        if (!json) err(planLines(plan, e.consent.fix.command ?? ''));
        return printConsentRefusal(e, { json });
      }
      throw buildConsentRefusal(req, cliRenderContext());
    }
    if (a.mode === 'rollback') {
      const result = await api.rollbackGraduation(opts);
      emit({ schema_version: 1, status: result.state, restored_path: result.restoredPath, dropped: result.dropped },
        `Rolled back: ${result.state === 'abandoned' ? 'the Postgres copy was abandoned; the PGLite brain never stopped being authoritative' : `the PGLite brain at ${result.restoredPath} is authoritative again`}.${result.dropped.length ? ` Dropped operational rows: ${result.dropped.map(d => `${d.relation} (${d.rows})`).join(', ')}.` : ''}\n`);
      return 0;
    }
    const receipt = a.mode === 'resume' ? await api.resumeGraduation(opts) : await api.runGraduation(opts);
    done();
    if (receipt.state === 'rolled_back') {
      emit({ schema_version: 1, status: 'rolled_back', state: 'rolled_back', run_id: receipt.runId, receipt },
        `Rolled back (run ${receipt.runId}): the interrupted rollback finished and the PGLite brain is authoritative again.\n`);
      return 0;
    }
    emit(successDoc(receipt), successLines(receipt));
    return 0;
  } catch (e) {
    done();
    return writeGraduationError(e, signal.aborted, json, deps.writeError ?? ((err, o) => writeCliError(err, 'migrate', o)));
  } finally {
    if (!deps.signal) process.removeListener('SIGINT', onSigint);
  }
}

/** Render a graduation failure; applies the per-reason exit overrides (SIGINT 130, blocked drain 1). */
function writeGraduationError(e: unknown, aborted: boolean, json: boolean,
  write: (e: unknown, opts: { json: boolean; legacy?: Record<string, unknown> }) => number): number {
  if (aborted && !(e instanceof OperationError && e.code === 'interrupted')) {
    const err = opError('interrupted', 'The move stopped at a batch boundary after an interrupt; it is resumable.',
      'Ask the user whether to continue; `gbrain migrate --resume` picks up where it stopped.',
      { why: 'SIGINT stops the copy between batches and records the checkpoint, so nothing is half-written.',
        fix: { argv: resumeArgv(), consent: [], actor: 'agent', requires_exclusive: true, verify: { argv: statusArgv() },
          why: 'Continues from the recorded checkpoint.', user_message: 'The move to Postgres was paused. Should I continue it?' } });
    return write(err, { json, ...(json ? { legacy: { resume_command: resumeArgv() } } : {}) });
  }
  if (e instanceof OperationError && e.code === 'graduation_rollback_writes_lost' && e.reason === 'user_data') {
    // A confirmable loss asks the user (fix.next ask_user, like confirmation_required): exit 3. A final refusal stays 1.
    write(e, { json });
    return 3;
  }
  if (e instanceof OperationError && e.code === 'graduation_drain_timeout') {
    const code = write(e, { json, ...(json ? { legacy: { resume_command: e.fix?.argv ?? resumeArgv() } } : {}) });
    return e.reason === 'blocked' ? 1 : code;
  }
  return write(e, { json });
}

/** Pre-connect route from src/cli.ts: true when graduation handled this invocation. */
export async function tryRunMigrateGraduation(args: string[]): Promise<boolean> {
  if (!routesToGraduation(args, loadConfigFileOnly())) return false;
  setCliExitVerdict(await runMigrateGraduation(args));
  return true;
}
