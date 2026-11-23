/**
 * The provisional shadow report (plan PR S1/S2 read half, plus the S3 seed). Its verdict is always NOT READY:
 * the seeded store does not follow later writes yet, writes are not compared yet, and the full report with
 * readiness rules is S4. It counts comparisons per operation and outcome, names the seed (its age, segmented
 * pages and unseeded gap rows), and says why nothing here can be read as readiness.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHADOW_OUTCOMES, type ShadowOutcome } from './classify.ts';
import { readFaults, readShadowSummary, type ShadowFault, type ShadowSummary } from './ledger.ts';
import { storageLine, storageReport, type StorageReport } from './managed-gate.ts';
import type { ShadowState } from './state.ts';
import { readSeedRecord, type SeedRecord } from './seed.ts';

export const PROVISIONAL_VERDICT = 'NOT READY' as const;

export interface ProvisionalReport {
  schema_version: 1;
  kind: 'provisional';
  verdict: typeof PROVISIONAL_VERDICT;
  why_not_ready: string[];
  generated_at: string;
  brain: string;
  enabled: boolean;
  sample_rate: number | null;
  /** The storage mode `start` recorded, null for a state written before it was recorded. */
  storage: StorageReport | null;
  window: { first_event_at: string | null; last_event_at: string | null };
  totals: Record<ShadowOutcome, number> & { compared: number };
  by_op: Array<{ op: string; total: number } & Record<ShadowOutcome, number>>;
  serving: ShadowSummary['primary'];
  child_shed: number;
  children: number;
  recent_faults: ShadowFault[];
  /** The seed the Rust store holds (`seed.json`), or null before `gbrain engine shadow seed`. */
  seed: ReportSeed | null;
}

export interface ReportSeed {
  seed_id: string;
  finished_at: string;
  age_hours: number;
  segmented_pages: number;
  non_terminal_jobs: number;
  /** The storage mode the seed recorded, null for a seed written before it was recorded. */
  storage: StorageReport | null;
  unseeded_gap_rows_total: number;
  /** Only the gap tables and columns that hold rows. */
  unseeded_gap_rows: Record<string, number>;
}

function reportSeed(record: SeedRecord | null, now: Date): ReportSeed | null {
  if (!record) return null;
  const age = (now.getTime() - Date.parse(record.finished_at)) / 3_600_000;
  return {
    seed_id: record.seed_id,
    finished_at: record.finished_at,
    age_hours: Number.isFinite(age) ? Math.max(0, Math.round(age * 10) / 10) : 0,
    segmented_pages: record.segmented_pages,
    non_terminal_jobs: record.non_terminal_jobs,
    storage: storageReport(record.storage),
    unseeded_gap_rows_total: record.unseeded_gap_rows_total,
    unseeded_gap_rows: Object.fromEntries(Object.entries(record.unseeded_gap_rows).filter(([, n]) => n > 0)),
  };
}

function whyNotReady(seed: ReportSeed | null): string[] {
  const why = ['Provisional report: shadow mode compares reads only (plan S1 and the read half of S2).'];
  if (!seed) {
    why.push('The Rust store is not seeded: run gbrain engine shadow seed. Until then most Rust reads differ or miss; a diff here is expected.');
  } else {
    why.push(`The Rust store holds the seed of ${seed.finished_at} and does not follow later writes yet, so reads of anything written since differ.`);
    if (seed.unseeded_gap_rows_total > 0) {
      why.push(`${seed.unseeded_gap_rows_total} rows of the brain have no Rust home yet (unseeded gap rows); reads that touch them can differ, and a swap is refused while any remain.`);
    }
  }
  why.push('Writes are not compared yet, and readiness rules arrive with the full report in S4.');
  return why;
}

function zeroOutcomes(): Record<ShadowOutcome, number> {
  return Object.fromEntries(SHADOW_OUTCOMES.map((o) => [o, 0])) as Record<ShadowOutcome, number>;
}

export function buildProvisionalReport(dir: string, brain: string, state: ShadowState | null, now = new Date()): ProvisionalReport {
  const summary = readShadowSummary(dir);
  const totals = { ...zeroOutcomes(), compared: 0 };
  const byOp = Object.keys(summary.by_op).sort().map((op) => {
    const row = { op, total: 0, ...zeroOutcomes() };
    for (const outcome of SHADOW_OUTCOMES) {
      const n = summary.by_op[op]?.[outcome] ?? 0;
      row[outcome] = n;
      row.total += n;
      totals[outcome] += n;
      totals.compared += n;
    }
    return row;
  });
  const seed = reportSeed(readSeedRecord(dir), now);
  return {
    schema_version: 1,
    kind: 'provisional',
    verdict: PROVISIONAL_VERDICT,
    why_not_ready: whyNotReady(seed),
    generated_at: now.toISOString(),
    brain,
    enabled: state?.enabled === true,
    sample_rate: state?.sample_rate ?? null,
    storage: storageReport(state?.storage),
    window: { first_event_at: summary.first_event_at, last_event_at: summary.last_event_at },
    totals,
    by_op: byOp,
    serving: summary.primary,
    child_shed: summary.child_shed,
    children: summary.children,
    recent_faults: readFaults(dir, 10),
    seed,
  };
}

export function renderProvisionalMarkdown(r: ProvisionalReport): string {
  const lines: string[] = [];
  lines.push(`# Rust engine shadow report (provisional)`, '');
  lines.push(`Verdict: **${r.verdict}**`, '');
  for (const why of r.why_not_ready) lines.push(`- ${why}`);
  lines.push('', `Brain: ${r.brain}. Shadow mode: ${r.enabled ? 'on' : 'off'}. Generated ${r.generated_at}.`);
  const storage = storageLine(r.storage);
  if (storage) lines.push(`Storage: ${storage}.`);
  lines.push(`Window: ${r.window.first_event_at ?? 'no comparisons yet'} to ${r.window.last_event_at ?? '-'}.`);
  lines.push(renderSeedLine(r.seed), '');
  const cols: ShadowOutcome[] = [...SHADOW_OUTCOMES];
  lines.push(`| operation | total | ${cols.join(' | ')} |`);
  lines.push(`|---|---:|${cols.map(() => '---:').join('|')}|`);
  for (const row of r.by_op) lines.push(`| ${row.op} | ${row.total} | ${cols.map((c) => row[c]).join(' | ')} |`);
  lines.push(`| all | ${r.totals.compared} | ${cols.map((c) => r.totals[c]).join(' | ')} |`, '');
  const s = r.serving;
  lines.push(`Serving processes: ${s.offered} reads offered, ${s.sent} sent, ${s.sampled_out} sampled out, `
    + `${s.shed_queue_full + s.shed_too_large + s.shed_transport + s.shed_unmirrorable} shed, `
    + `${s.skipped_in_transaction} skipped inside transactions. The child shed ${r.child_shed}.`);
  if (r.recent_faults.length) {
    lines.push('', '## Recent faults', '');
    for (const f of r.recent_faults) lines.push(`- ${f.ts} ${f.kind}: ${f.detail}`);
  }
  return lines.join('\n') + '\n';
}

function renderSeedLine(seed: ReportSeed | null): string {
  if (!seed) return 'Seed: none (run gbrain engine shadow seed).';
  const gaps = Object.entries(seed.unseeded_gap_rows).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`);
  return `Seed: ${seed.seed_id}, finished ${seed.finished_at} (${seed.age_hours} hours ago). `
    + `Segmented pages read as shells: ${seed.segmented_pages}. Unfinished jobs not copied: ${seed.non_terminal_jobs}. `
    + `Unseeded gap rows: ${seed.unseeded_gap_rows_total}${gaps.length ? ` (${gaps.join(', ')})` : ''}.`
    + (storageLine(seed.storage) ? ` Storage: ${storageLine(seed.storage)}.` : '');
}

/** Writes `reports/provisional.json` and `.md` (0600) and returns their paths. */
export function writeProvisionalReport(dir: string, report: ProvisionalReport): { json: string; markdown: string } {
  const reports = join(dir, 'reports');
  mkdirSync(reports, { recursive: true, mode: 0o700 });
  const json = join(reports, 'provisional.json');
  const markdown = join(reports, 'provisional.md');
  for (const [path, body] of [[json, JSON.stringify(report, null, 2) + '\n'], [markdown, renderProvisionalMarkdown(report)]] as const) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  }
  return { json, markdown };
}
