/**
 * gbrain friction — friction reporter CLI.
 *
 * Five subcommands (remaining analytical ones — trend, migration-stub — stay v1.1):
 *   gbrain friction log     Append a friction or delight entry
 *   gbrain friction render  Render a run as markdown or JSON
 *   gbrain friction list    List recent runs with counts
 *   gbrain friction summary Side-by-side friction + delight summary
 *   gbrain friction diff    Compare two runs (or agents): unique-to-each + shared-but-changed
 *
 * Subcommands stay thin (≤ ~30 LOC each). Reader/writer/redaction logic lives
 * in src/core/friction.ts; the diff computation lives here (it is CLI-only).
 *
 * The CLI is dispatched from src/cli.ts. See `gbrain friction --help`.
 */

import { existsSync } from 'fs';
import {
  logFriction, readFriction, listRuns, renderReport, renderSummary,
  activeRunId, frictionFile, frictionDir, redactEntry,
  type FrictionKind, type FrictionSeverity, type FrictionEntry, type ReadResult,
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
    case 'diff':    return cmdDiff(rest);
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
// diff
// ---------------------------------------------------------------------------

/**
 * Entry identity for diffing: (kind, phase, normalized message prefix) —
 * lowercase, whitespace-collapsed, digit runs collapsed (durations, counts,
 * and tempdir suffixes would otherwise make the same friction land in
 * "unique to each" across runs), first 80 chars, with redaction applied
 * FIRST (the caller redacts via redactEntry). Kind IS identity: a delight
 * and a friction with the same text are different findings, and a
 * delight→friction flip must surface, never compare equal. Severity is
 * deliberately EXCLUDED from identity — it is the compared attribute, as a
 * PER-SEVERITY MULTISET (two errors + one nit vs one error + two nits is a
 * reported difference even though the severity sets and totals match).
 */
const IDENTITY_PREFIX_CHARS = 80;

interface DiffIdentityRecord {
  kind: string;
  phase: string;
  /** Redacted message of the first occurrence (display sample). */
  message: string;
  count: number;
  /** Unique severities, sorted (display); counts live in severity_counts. */
  severities: string[];
  severity_counts: Record<string, number>;
}

interface DiffChangedRecord {
  kind: string;
  phase: string;
  message: string;
  base_count: number;
  compare_count: number;
  base_severities: string[];
  compare_severities: string[];
  base_severity_counts: Record<string, number>;
  compare_severity_counts: Record<string, number>;
  count_changed: boolean;
  severity_changed: boolean;
}

interface DiffRunBanner {
  run_id: string;
  agent?: string;
  scenario?: string;
  gbrain_version?: string;
  interrupted: boolean;
  /** Malformed JSONL lines skipped by the reader (surfaced, never hidden). */
  malformed: number;
}

export interface FrictionDiffResult {
  base: string;
  compare: string;
  banner: { base: DiffRunBanner; compare: DiffRunBanner; warnings: string[] };
  unique_to_base: DiffIdentityRecord[];
  unique_to_compare: DiffIdentityRecord[];
  changed: DiffChangedRecord[];
}

/**
 * Resolve a run spec: an exact run-id wins; otherwise treat the spec as an
 * agent name and pick the LATEST run (listRuns is mtime-sorted, newest first)
 * whose entries carry that agent — the run-start marker stamps agent on clean
 * runs, and any agent-stamped entry also counts. Returns undefined if nothing
 * matches.
 */
export function resolveRunSpec(spec: string): string | undefined {
  try {
    if (existsSync(frictionFile(spec))) return spec;
  } catch { /* spec has characters a run-id can't; fall through to agent-name resolution */ }
  for (const run of listRuns()) {
    try {
      const { entries } = readFriction(run.runId);
      if (entries.some(e => e.agent === spec)) return run.runId;
    } catch { /* unreadable file; skip */ }
  }
  return undefined;
}

function normalizeForIdentity(message: string): string {
  return message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, IDENTITY_PREFIX_CHARS);
}

interface IdentityAccum { kind: string; phase: string; message: string; count: number; severities: Map<string, number> }

/** Sorted-key plain object from a severity count map (deterministic JSON). */
function severityCounts(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Diff operates ONLY on kind friction|delight; markers/interruptions feed the banner. */
function collectIdentities(entries: FrictionEntry[]): Map<string, IdentityAccum> {
  const map = new Map<string, IdentityAccum>();
  for (const raw of entries) {
    // Entries from older writers may omit kind; they are friction by contract.
    const kind = raw.kind ?? 'friction';
    if (kind !== 'friction' && kind !== 'delight') continue;
    const e = redactEntry(raw);
    const key = `${kind}\u0000${e.phase}\u0000${normalizeForIdentity(e.message)}`;
    let acc = map.get(key);
    if (!acc) {
      acc = { kind, phase: e.phase, message: e.message, count: 0, severities: new Map() };
      map.set(key, acc);
    }
    acc.count++;
    if (e.severity) acc.severities.set(e.severity, (acc.severities.get(e.severity) ?? 0) + 1);
  }
  return map;
}

function toIdentityRecord(acc: IdentityAccum): DiffIdentityRecord {
  return {
    kind: acc.kind,
    phase: acc.phase,
    message: acc.message,
    count: acc.count,
    severities: [...acc.severities.keys()].sort(),
    severity_counts: severityCounts(acc.severities),
  };
}

function bannerFor(runId: string, read: ReadResult): DiffRunBanner {
  const start = read.entries.find(e => e.kind === 'phase-marker' && e.marker === 'start');
  const agent = start?.agent ?? read.entries.find(e => e.agent)?.agent;
  return {
    run_id: runId,
    agent,
    scenario: start?.scenario,
    gbrain_version: start?.gbrain_version ?? read.entries[0]?.gbrain_version,
    interrupted: read.entries.some(e => e.kind === 'interrupted'),
    malformed: read.malformed,
  };
}

/** Compute the diff between two resolved run-ids. Throws on read errors. */
export function computeFrictionDiff(baseRunId: string, compareRunId: string): FrictionDiffResult {
  const baseRead = readFriction(baseRunId);
  const compareRead = readFriction(compareRunId);
  const baseBanner = bannerFor(baseRunId, baseRead);
  const compareBanner = bannerFor(compareRunId, compareRead);

  const warnings: string[] = [];
  if ((baseBanner.scenario ?? '') !== (compareBanner.scenario ?? '')) {
    warnings.push(`scenario differs: ${baseRunId} ran ${baseBanner.scenario ?? '(unknown)'}, ${compareRunId} ran ${compareBanner.scenario ?? '(unknown)'} — entries may not be comparable`);
  }
  if ((baseBanner.gbrain_version ?? '') !== (compareBanner.gbrain_version ?? '')) {
    warnings.push(`gbrain version differs: ${baseRunId} ran ${baseBanner.gbrain_version ?? '(unknown)'}, ${compareRunId} ran ${compareBanner.gbrain_version ?? '(unknown)'}`);
  }

  const baseIds = collectIdentities(baseRead.entries);
  const compareIds = collectIdentities(compareRead.entries);
  const uniqueToBase: DiffIdentityRecord[] = [];
  const uniqueToCompare: DiffIdentityRecord[] = [];
  const changed: DiffChangedRecord[] = [];
  for (const [key, b] of baseIds) {
    const c = compareIds.get(key);
    if (!c) { uniqueToBase.push(toIdentityRecord(b)); continue; }
    const bCounts = severityCounts(b.severities);
    const cCounts = severityCounts(c.severities);
    const countChanged = b.count !== c.count;
    // severity_changed = the per-severity DISTRIBUTION SHAPE changed — a new
    // severity appeared/disappeared or the mix redistributed (2×error+1×nit →
    // 1×error+2×nit, which the unique-severity set hides). Uniform scaling
    // (1×error → 10×error) is purely a count change and count_changed already
    // reports it. Integer cross-multiplication keeps the proportion test
    // exact.
    const bTotal = Object.values(bCounts).reduce((a, n) => a + n, 0);
    const cTotal = Object.values(cCounts).reduce((a, n) => a + n, 0);
    let severityChanged = (bTotal === 0) !== (cTotal === 0);
    if (!severityChanged) {
      for (const s of new Set([...Object.keys(bCounts), ...Object.keys(cCounts)])) {
        if ((bCounts[s] ?? 0) * cTotal !== (cCounts[s] ?? 0) * bTotal) { severityChanged = true; break; }
      }
    }
    if (countChanged || severityChanged) {
      changed.push({
        kind: b.kind, phase: b.phase, message: b.message,
        base_count: b.count, compare_count: c.count,
        base_severities: Object.keys(bCounts), compare_severities: Object.keys(cCounts),
        base_severity_counts: bCounts, compare_severity_counts: cCounts,
        count_changed: countChanged, severity_changed: severityChanged,
      });
    }
  }
  for (const [key, c] of compareIds) {
    if (!baseIds.has(key)) uniqueToCompare.push(toIdentityRecord(c));
  }
  const byPhaseThenMessage = (a: { phase: string; message: string }, b: { phase: string; message: string }) =>
    a.phase.localeCompare(b.phase) || a.message.localeCompare(b.message);
  uniqueToBase.sort(byPhaseThenMessage);
  uniqueToCompare.sort(byPhaseThenMessage);
  changed.sort(byPhaseThenMessage);

  return {
    base: baseRunId,
    compare: compareRunId,
    banner: { base: baseBanner, compare: compareBanner, warnings },
    unique_to_base: uniqueToBase,
    unique_to_compare: uniqueToCompare,
    changed,
  };
}

function groupByPhase<T extends { phase: string }>(records: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of records) {
    if (!map.has(r.phase)) map.set(r.phase, []);
    map.get(r.phase)!.push(r);
  }
  return map;
}

function fmtSeverityCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([s, n]) => (n > 1 ? `${s}×${n}` : s));
  return parts.length > 0 ? parts.join('/') : '(none)';
}

/** Render the diff as markdown. Sections are labeled by run-id — the diff is
 *  an instrument, not a judge; it never attributes blame to either side. */
function renderDiff(diff: FrictionDiffResult): string {
  const lines: string[] = [];
  lines.push(`# Friction diff — base \`${diff.base}\` vs compare \`${diff.compare}\``);
  lines.push('');
  for (const side of [diff.banner.base, diff.banner.compare]) {
    const bits = [
      `agent=${side.agent ?? '(unknown)'}`,
      `scenario=${side.scenario ?? '(unknown)'}`,
      `gbrain=${side.gbrain_version ?? '(unknown)'}`,
    ];
    if (side.interrupted) bits.push('interrupted');
    if (side.malformed > 0) bits.push(`${side.malformed} malformed line(s) skipped`);
    lines.push(`- \`${side.run_id}\`: ${bits.join(' · ')}`);
  }
  lines.push('');
  for (const w of diff.banner.warnings) lines.push(`> ⚠ WARN: ${w}`);
  if (diff.banner.warnings.length > 0) lines.push('');

  if (diff.unique_to_base.length === 0 && diff.unique_to_compare.length === 0 && diff.changed.length === 0) {
    lines.push('No differences.');
    lines.push('');
  }

  const renderIdentitySection = (title: string, records: DiffIdentityRecord[]) => {
    lines.push(`## ${title} (${records.length})`);
    lines.push('');
    if (records.length === 0) { lines.push('(none)'); lines.push(''); return; }
    for (const [phase, rs] of groupByPhase(records)) {
      lines.push(`### \`${phase}\``);
      lines.push('');
      for (const r of rs) {
        const sev = r.severities.length > 0 ? `[${r.severities.join('/')}] ` : '';
        const kind = r.kind === 'delight' ? '[delight] ' : '';
        const count = r.count > 1 ? ` ×${r.count}` : '';
        lines.push(`- ${kind}${sev}${r.message}${count}`);
      }
      lines.push('');
    }
  };
  renderIdentitySection(`Unique to \`${diff.compare}\``, diff.unique_to_compare);
  renderIdentitySection(`Unique to \`${diff.base}\``, diff.unique_to_base);

  lines.push(`## Shared but changed (${diff.changed.length})`);
  lines.push('');
  if (diff.changed.length === 0) { lines.push('(none)'); lines.push(''); }
  for (const [phase, rs] of groupByPhase(diff.changed)) {
    lines.push(`### \`${phase}\``);
    lines.push('');
    for (const r of rs) {
      const deltas: string[] = [];
      if (r.severity_changed) deltas.push(`severity ${fmtSeverityCounts(r.base_severity_counts)} → ${fmtSeverityCounts(r.compare_severity_counts)}`);
      if (r.count_changed) deltas.push(`count ${r.base_count} → ${r.compare_count}`);
      const kind = r.kind === 'delight' ? '[delight] ' : '';
      lines.push(`- ${kind}${r.message} — ${deltas.join('; ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function cmdDiff(args: string[]): number {
  const flags = parseFlags(args);
  const baseSpec = flags.string('--base');
  const compareSpec = flags.string('--compare');
  if (!baseSpec || !compareSpec) {
    console.error('usage: gbrain friction diff --base <run-or-agent> --compare <run-or-agent> [--json]');
    return 2;
  }
  const baseRun = resolveRunSpec(baseSpec);
  const compareRun = resolveRunSpec(compareSpec);
  if (!baseRun || !compareRun) {
    const unresolved = [!baseRun ? baseSpec : undefined, !compareRun ? compareSpec : undefined]
      .filter((s): s is string => s !== undefined)
      .map(s => JSON.stringify(s)).join(', ');
    const runs = listRuns();
    const available = runs.length > 0 ? runs.map(r => `  ${r.runId}`).join('\n') : '  (none)';
    console.error(`friction diff failed: ${unresolved} matched no run-id or agent\navailable runs under ${frictionDir()}:\n${available}`);
    return 1;
  }
  try {
    const diff = computeFrictionDiff(baseRun, compareRun);
    process.stdout.write((flags.bool('--json') ? JSON.stringify(diff, null, 2) : renderDiff(diff)) + '\n');
    return 0;
  } catch (e) {
    console.error(`friction diff failed: ${e instanceof Error ? e.message : String(e)}`);
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
  diff    Compare two runs: unique-to-each + shared-but-changed entries

Examples:
  gbrain friction log --severity confused --phase install --message "init didn't say which engine"
  gbrain friction render --run-id claw-test-20260428-... --transcripts
  gbrain friction list --json
  gbrain friction summary
  gbrain friction diff --base openclaw --compare hermes --json

Run-id resolution: --run-id > $GBRAIN_FRICTION_RUN_ID > 'standalone'.
Diff run resolution: an exact run-id wins; otherwise the value is treated as
an agent name and resolves to that agent's latest run.`);
}
