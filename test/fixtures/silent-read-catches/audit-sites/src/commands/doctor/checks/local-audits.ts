// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/doctor/checks/local-audits.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

export async function runExtractionBacklogs(engine: any) {
  // verbatim src/commands/doctor/checks/local-audits.ts:297-336
  try {
    const { readRecentProgressiveBatchEvents } = await import(
      '../../../core/progressive-batch/audit.ts'
    );
    const events = readRecentProgressiveBatchEvents(7);
    const aborts = events.filter((e) => e.verdict !== 'proceed');
    if (aborts.length === 0) {
      checks.push({
        name: 'progressive_batch_audit_health',
        status: 'ok',
        message:
          events.length === 0
            ? 'No progressive-batch operations in the last 7 days'
            : `${events.length} progressive-batch events; 0 aborts`,
      });
    } else {
      const reasonsCounted: Record<string, number> = {};
      for (const e of aborts) {
        const key = e.abort_reason ?? e.verdict;
        reasonsCounted[key] = (reasonsCounted[key] ?? 0) + 1;
      }
      const breakdown = Object.entries(reasonsCounted)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      checks.push({
        name: 'progressive_batch_audit_health',
        status: 'warn',
        message:
          `${aborts.length}/${events.length} progressive-batch events aborted in last 7d. ` +
          `Breakdown: ${breakdown}. ` +
          `Inspect: cat ~/.gbrain/audit/progressive-batch-*.jsonl | jq 'select(.verdict != "proceed")'`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'progressive_batch_audit_health',
      status: 'ok',
      message: `Skipped (audit file unreachable): ${(err as Error)?.message ?? String(err)}`,
    });
  }
}
