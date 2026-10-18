import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import type { AuditReport } from '../../../core/brain-writer.ts';
import { agentFix } from '../check-fix.ts';

/** `GBRAIN_DOCTOR_FM_TIMEOUT_MS` (default 30 s): the wall-clock bound of one frontmatter scan. */
export function frontmatterScanTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_FM_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

/**
 * #5988 `frontmatter_repairable`: files `gbrain repair frontmatter` can fix
 * (recoverable YAML, `needs_interpretation` holds, a `#`-leading title read as
 * a comment, nested quotes, NUL bytes, a missing closing fence, a conflicting
 * slug line). Codes no repair fixes (MISSING_OPEN, EMPTY_FRONTMATTER,
 * NON_STRING_FIELD) stay on `frontmatter_integrity`. Built from the same scan
 * `frontmatter_integrity` reads, so doctor walks each source once. A scan
 * that hit its deadline is `partial` (remediation reports it pending), never ok.
 */
export function frontmatterRepairableFromReport(report: AuditReport, timeoutMs: number): Check {
  const sources = report.per_source.filter(src => (src.repairable?.files ?? 0) > 0).map(src => ({
    source_id: src.source_id, files: src.repairable!.files, by_code: src.repairable!.by_code, sample_paths: src.repairable!.sample.slice(0, 5),
    status: src.status, preview: `gbrain repair frontmatter --source ${src.source_id}`,
  }));
  const files = sources.reduce((sum, src) => sum + src.files, 0);
  const unscanned = report.per_source.filter(src => src.status !== 'scanned').map(src => src.source_id);
  const details = { repairable: files, source_ids: sources.map(src => src.source_id), sources, partial: report.partial, unscanned,
    docs: 'docs/guides/repair.md#frontmatter' };
  const single = sources.length === 1 ? sources[0]!.source_id : undefined;
  const fix = agentFix(['gbrain', 'repair', 'frontmatter', ...(single ? ['--source', single] : [])],
    'Previews the minimal line fix per file (safe quoting first; interpretations only with --include-ambiguous) and prints the hash-bound apply command; it writes nothing.',
    'frontmatter_repairable', { docs: 'docs/guides/repair.md#frontmatter' });
  const partial = report.partial
    ? ` PARTIAL SCAN: the walk stopped after ${timeoutMs / 1000}s, so ${unscanned.join(', ')} ${unscanned.length === 1 ? 'was' : 'were'} not fully checked; raise GBRAIN_DOCTOR_FM_TIMEOUT_MS and run gbrain doctor --only frontmatter_repairable again.`
    : '';
  if (!files && !report.partial) {
    return { name: 'frontmatter_repairable', status: 'ok', details,
      message: report.per_source.length ? 'No file has frontmatter gbrain repair frontmatter would fix.' : 'No registered sources to scan.' };
  }
  if (!files) return { name: 'frontmatter_repairable', status: 'warn', details, fix_unavailable_reason: 'check_errored', message: `No repairable frontmatter found so far.${partial}` };
  return {
    name: 'frontmatter_repairable', status: 'warn', details, fix,
    message: `${files} file(s) have frontmatter gbrain repair frontmatter can fix: `
      + `${sources.map(src => `${src.source_id}: ${src.files} (${Object.entries(src.by_code).map(([code, n]) => `${code}=${n}`).join(', ')})`).join('; ')}. `
      + `Preview with ${sources.map(src => src.preview).join('; ')} (writes nothing; add --include-ambiguous for interpretations after the safe pass).${partial}`,
  };
}

/** The wave-check entry point: one bounded scan of the scoped sources. */
export async function frontmatterRepairableCheck(engine: BrainEngine, sourceId?: string): Promise<Check> {
  const { scanBrainSources } = await import('../../../core/brain-writer.ts');
  const timeoutMs = frontmatterScanTimeoutMs();
  const report = await scanBrainSources(engine, { sourceId, deadline: Date.now() + timeoutMs, signal: AbortSignal.timeout(timeoutMs), frontmatterOnly: true });
  return frontmatterRepairableFromReport(report, timeoutMs);
}
