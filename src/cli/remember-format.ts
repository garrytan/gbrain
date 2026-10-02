/**
 * Human rendering of a `remember` result (MEMORY_VERBS v1). Kept out of
 * src/cli.ts, which sits at its module-size ceiling. `--json` is handled by
 * the caller and prints the raw envelope instead.
 */
export function formatRememberResult(r: Record<string, any>): string {
  if (r.dry_run) return `[dry-run] would remember: ${r.fact}\n`;
  const lines = [r.status_text || `${r.status} (fact #${r.id})`];
  if (r.entity_slug) lines.push(`  entity: ${r.entity_slug}${r.entity_inferred ? ' (inferred from mention)' : ''}`);
  if (r.valid_until) lines.push(`  expires: ${r.valid_until}`);
  if (r.degraded_dedup) lines.push('  note: no embedding provider — duplicate detection degraded');
  if (Array.isArray(r.warnings)) for (const warning of r.warnings) lines.push(`  warning: ${warning}`);
  if (r.hint) lines.push(`  hint: ${r.hint}`);
  return lines.join('\n') + '\n';
}
