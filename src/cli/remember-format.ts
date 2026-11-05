/**
 * Human rendering of a `remember` result (MEMORY_VERBS v1). Kept out of
 * src/cli.ts, which sits at its module-size ceiling. `--json` is handled by
 * the caller and prints the raw envelope instead.
 */
export function formatRememberResult(r: Record<string, any>, params: Record<string, unknown> = {}): string {
  if (r.dry_run) return `[dry-run] would remember: ${r.fact}\n`;
  // GST-1387: a batch (`items`) reports per item; a failed item never reads as saved.
  if (Array.isArray(r.items)) {
    const lines = [`saved ${r.saved} of ${r.items.length} fact(s)${r.failed ? `, ${r.failed} failed` : ''}${r.pending ? `, ${r.pending} pending` : ''}`];
    for (const item of r.items) {
      lines.push(item.status === 'failed' ? `  items[${item.index}]: failed [${item.error?.code}] ${item.error?.message ?? ''}`
        : `  items[${item.index}]: ${item.status}${item.id !== undefined ? ` (fact #${item.id})` : ''}${item.entity_slug ? ` entity: ${item.entity_slug}` : ''}`);
    }
    if (r.next) lines.push(`  next: ${r.next}`);
    return lines.join('\n') + '\n';
  }
  const lines = [r.status_text || `${r.status} (fact #${r.id})`];
  if (r.entity_slug) lines.push(`  entity: ${r.entity_slug}${r.entity_inferred ? ' (inferred from mention)' : ''}`);
  if (r.valid_until) lines.push(`  expires: ${r.valid_until}`);
  if (r.degraded_dedup) lines.push('  note: no embedding provider — duplicate detection degraded');
  if (params.visibility === 'private') lines.push('  note: private — local CLI recall only; not pushed into new agent sessions');
  if (Array.isArray(r.warnings)) for (const warning of r.warnings) lines.push(`  warning: ${warning}`);
  if (r.hint) lines.push(`  hint: ${r.hint}`);
  return lines.join('\n') + '\n';
}
