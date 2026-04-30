/**
 * gbrain friction — friction reporter CLI.
 *
 * Four subcommands in v1 (analytical/clustering ones move to v1.1):
 *   gbrain friction log     Append a friction or delight entry
 *   gbrain friction render  Render a run as markdown or JSON
 *   gbrain friction list    List recent runs with counts
 *   gbrain friction summary Side-by-side friction + delight summary
 *
 * Subcommands stay thin (≤ ~30 LOC each). Core logic lives in src/core/friction.ts.
 *
 * The CLI is dispatched from src/cli.ts. See `gbrain friction --help`.
 */

import {
  logFriction, readFriction, listRuns, renderReport, renderSummary,
  activeRunId, frictionFile,
  type FrictionKind, type FrictionSeverity,
} from '../core/friction.ts';

const VALID_KINDS = new Set<FrictionKind>(['friction', 'delight', 'phase-marker', 'interrupted']);
const VALID_SEVERITIES = new Set<FrictionSeverity>(['confused', 'error', 'blocker', 'nit']);

export function runFriction(args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'log':     return cmdLog(rest);
    case 'render':  return cmdRender(rest);
    case 'list':    return cmdList(rest);
    case 'summary': return cmdSummary(rest);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error(`unknown subcommand: ${sub}`);
      printHelp();
      return 2;
  }
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

function cmdLog(args: string[]): number {
  const flags = parseFlags(args);
  const phase = flags.string('--phase');
  const message = flags.string('--message');
  if (!phase || !message) {
    console.error('usage: gbrain friction log --phase <name> --message <text> [--severity ...] [--hint ...] [--kind ...] [--run-id ...]');
    return 2;
  }
  const kind = (flags.string('--kind') ?? 'friction') as FrictionKind;
  if (!VALID_KINDS.has(kind)) {
    console.error(`invalid --kind ${kind}; must be one of: ${[...VALID_KINDS].join(', ')}`);
    return 2;
  }
  const severityRaw = flags.string('--severity');
  const severity = severityRaw as FrictionSeverity | undefined;
  if (severity && !VALID_SEVERITIES.has(severity)) {
    console.error(`invalid --severity ${severity}; must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
    return 2;
  }
  try {
    logFriction({
      phase,
      message,
      kind,
      severity,
      hint: flags.string('--hint'),
      runId: flags.string('--run-id'),
      agent: flags.string('--agent'),
      source: 'claw',
    });
  } catch (e) {
    console.error(`friction log failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function cmdRender(args: string[]): number {
  const flags = parseFlags(args);
  const runId = flags.string('--run-id') ?? activeRunId();
  const json = flags.bool('--json');
  const format = json ? 'json' : 'md';
  const transcripts = flags.bool('--transcripts');
  const noRedact = flags.bool('--no-redact');
  // --redact is the default for md output; --no-redact disables.
  const redact = noRedact ? false : (format === 'md');
  try {
    const out = renderReport(runId, {
      format,
      redact,
      transcriptPath: transcripts ? flags.string('--transcript-path') ?? undefined : undefined,
    });
    process.stdout.write(out + '\n');
    return 0;
  } catch (e) {
    console.error(`friction render failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function cmdList(args: string[]): number {
  const flags = parseFlags(args);
  const json = flags.bool('--json');
  const runs = listRuns();
  if (json) {
    console.log(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (runs.length === 0) {
    console.log('no runs yet');
    return 0;
  }
  for (const r of runs) {
    const interrupted = r.counts.interrupted ? ' (interrupted)' : '';
    const sev = Object.entries(r.counts.bySeverity).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`${r.runId}${interrupted}  friction=${r.counts.friction}  delight=${r.counts.delight}  ${sev}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

function cmdSummary(args: string[]): number {
  const flags = parseFlags(args);
  const runId = flags.string('--run-id') ?? activeRunId();
  const json = flags.bool('--json');
  try {
    const out = renderSummary(runId, { format: json ? 'json' : 'md' });
    process.stdout.write(out + '\n');
    return 0;
  } catch (e) {
    console.error(`friction summary failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args: string[]) {
  return {
    string(flag: string): string | undefined {
      const idx = args.indexOf(flag);
      return idx === -1 ? undefined : args[idx + 1];
    },
    bool(flag: string): boolean {
      return args.includes(flag);
    },
  };
}

function printHelp() {
  console.log(`gbrain friction — friction reporter

Subcommands:
  log     Append a friction or delight entry to the active run
  render  Render a run's entries as markdown (default) or JSON
  list    List recent runs with friction/delight counts
  summary Two-column summary of friction + delight for a run

Examples:
  gbrain friction log --severity confused --phase install --message "init didn't say which engine"
  gbrain friction render --run-id claw-test-20260428-... --transcripts
  gbrain friction list --json
  gbrain friction summary

Run-id resolution: --run-id > $GBRAIN_FRICTION_RUN_ID > 'standalone'.`);
}
