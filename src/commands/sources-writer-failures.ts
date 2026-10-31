/**
 * #6650 (L3): output of `gbrain sources writer failures <source>` (`terminal-failures.ts` reads, `administration.ts`
 * dispatches, locally or through the resident owner). A person gets a table; `--json` gets one document. Fixes and
 * inspect actions are rendered for the CLI in both, so `fix.next` and `fix.command` follow the agent operator contract.
 */
import { cliRenderContext, renderAction, type RenderedAction } from '../core/agent-output.ts';
import type { TerminalFailureGroup, TerminalFailureListing, TerminalFailureRow } from '../core/persistence/terminal-failures.ts';

type Rendered<T> = Omit<T, 'inspect' | 'fix'> & { inspect: RenderedAction; fix: RenderedAction };
type RenderedGroup = Omit<TerminalFailureGroup, 'fix' | 'samples'> & { fix: RenderedAction; samples: Array<Omit<TerminalFailureGroup['samples'][number], 'inspect'> & { inspect: RenderedAction }> };
type RenderedListing = Exclude<TerminalFailureListing, { status: 'ok' }> | (Omit<Extract<TerminalFailureListing, { status: 'ok' }>, 'rows' | 'groups'> & { rows?: Rendered<TerminalFailureRow>[]; groups?: RenderedGroup[] });

function renderListing(listing: TerminalFailureListing): RenderedListing {
  if (listing.status !== 'ok') return listing;
  const ctx = cliRenderContext();
  const { rows, groups, ...rest } = listing;
  return {
    ...rest,
    ...(rows ? { rows: rows.map(row => ({ ...row, inspect: renderAction(row.inspect, ctx), fix: renderAction(row.fix, ctx) })) } : {}),
    ...(groups ? { groups: groups.map(group => ({ ...group, fix: renderAction(group.fix, ctx),
      samples: group.samples.map(sample => ({ ...sample, inspect: renderAction(sample.inspect, ctx) })) })) } : {}),
  };
}

const pad = (value: string, width: number) => value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);

export function renderWriterFailures(listing: TerminalFailureListing, json: boolean): string {
  const rendered = renderListing(listing);
  if (json) return `${JSON.stringify(rendered, null, 2)}\n`;
  if (rendered.status !== 'ok') return `Terminal write failures of source ${rendered.source_id}: unknown (${rendered.reason}). Nothing is concluded; run the same command again.\n`;
  const lines: string[] = [];
  const scope = `${rendered.state === 'all' ? 'all' : 'unresolved'} receipts of the last ${rendered.window_days} d${rendered.window_clamped ? ' (clamped to persistence.receipt_retention_days)' : ''}`;
  if (rendered.groups) {
    lines.push(`Source ${rendered.source_id}: ${rendered.groups.length} group(s) of ${scope}.`);
    if (rendered.groups.length) lines.push(`  ${pad('ROWS', 6)} ${pad('CATEGORY', 26)} ${pad('CODE', 28)} ${pad('OPERATION', 20)} ${pad('ORIGIN', 18)} ${pad('CLASS', 10)} HUMAN`);
    for (const g of rendered.groups) {
      lines.push(`  ${pad(String(g.rows), 6)} ${pad(g.category, 26)} ${pad(g.code, 28)} ${pad(g.operation ?? '-', 20)} ${pad(g.origin ?? '-', 18)} ${pad(g.class, 10)} ${g.needs_human ? 'yes' : 'no'}`);
      lines.push(`         fix: ${g.fix.command ?? g.fix.why}`);
      lines.push(`         rows: ${g.drill_down.join(' ')}`);
    }
  } else {
    const rows = rendered.rows ?? [];
    lines.push(`Source ${rendered.source_id}: ${rows.length} ${scope}.`);
    if (rows.length) lines.push(`  ${pad('ENDED', 21)} ${pad('STATE', 10)} ${pad('CATEGORY', 22)} ${pad('CODE', 24)} ${pad('DISPOSITION', 15)} ${pad('SLUG', 32)} REQUEST`);
    for (const r of rows) {
      lines.push(`  ${pad(r.ended_at, 21)} ${pad(r.blocking ? `${r.state}*` : r.state, 10)} ${pad(r.category, 22)} ${pad(r.code, 24)} ${pad(r.disposition, 15)} ${pad(r.slug, 32)} ${r.request_id}`);
    }
    if (rows.some(r => r.blocking)) lines.push('  * holds a publication recovery record: it blocks its root now.');
    const first = rows[0];
    if (first) lines.push(`  Next for the newest: ${first.fix.command ?? first.fix.why}`, `  Inspect one: gbrain write-request <request> --json`);
  }
  if (rendered.truncated && rendered.next) lines.push(`  More: ${rendered.next.join(' ')}`);
  if (!rendered.groups?.length && !rendered.rows?.length) lines.push('  Nothing to show: no receipt in the window ended without committing.');
  return `${lines.join('\n')}\n`;
}
