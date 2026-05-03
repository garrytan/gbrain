import type { BrainEngine } from '../core/engine.ts';
import type { EvalCaptureToolName, EvalCandidate } from '../core/types.ts';

const READ_TOOLS = new Set<EvalCaptureToolName>([
  'get_page',
  'list_pages',
  'traverse_graph',
  'get_links',
  'get_backlinks',
  'get_timeline',
  'get_tags',
  'find_orphans',
  'resolve_slugs',
  'get_chunks',
]);

function parseDurationMs(s: string): number | null {
  const m = s.match(/^(\d+)\s*(ms|s|m|h|d|w)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  if (u === 'ms') return n;
  if (u === 's') return n * 1000;
  if (u === 'm') return n * 60_000;
  if (u === 'h') return n * 3_600_000;
  if (u === 'd') return n * 86_400_000;
  return n * 7 * 86_400_000;
}

function printHelpReads(): void {
  process.stderr.write(`gbrain audit reads — browse captured read/query/search audit rows

USAGE:
  gbrain audit reads [--since DUR] [--slug HINT] [--tool NAME] [--token NAME]
                    [--limit N] [--include-query-search] [--json]

FLAGS:
  --since DUR         Only rows newer than now - DUR (default 24h).
  --slug HINT          Substring match on query text or params_jsonb (ILIKE).
  --tool NAME          eval_candidates.tool_name filter.
  --token NAME         mcp_token_name equals this value (exact).
  --limit N           Max rows (default 500, max 100000).
  --include-query-search  Include query + search rows (default: reads only).
  --json               JSON array output.
`);
}

function printHelpPrune(): void {
  process.stderr.write(`gbrain audit prune — delete old read-audit rows (not query/search)

USAGE:
  gbrain audit prune --older-than DUR [--dry-run]

Requires --older-than. Does not delete tool_name query or search rows.
Use \`gbrain eval prune\` to prune retrieval rows only.
`);
}

export async function runAudit(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'reads') {
    if (rest.includes('--help') || rest.includes('-h')) {
      printHelpReads();
      return;
    }
    const json = rest.includes('--json');
    let sinceMs = 24 * 3_600_000;
    const si = rest.indexOf('--since');
    if (si >= 0 && rest[si + 1]) {
      const ms = parseDurationMs(rest[si + 1]);
      if (ms === null) {
        console.error(`Invalid --since: ${rest[si + 1]}`);
        process.exit(1);
      }
      sinceMs = ms;
    }
    const slugHint = (() => {
      const i = rest.indexOf('--slug');
      return i >= 0 ? rest[i + 1] : undefined;
    })();
    const tool = (() => {
      const i = rest.indexOf('--tool');
      return i >= 0 ? (rest[i + 1] as EvalCaptureToolName) : undefined;
    })();
    const token = (() => {
      const i = rest.indexOf('--token');
      return i >= 0 ? rest[i + 1] : undefined;
    })();
    const actor = (() => {
      const i = rest.indexOf('--actor');
      return i >= 0 ? rest[i + 1] : undefined;
    })();
    const includeQS = rest.includes('--include-query-search');
    let limit = 500;
    const li = rest.indexOf('--limit');
    if (li >= 0 && rest[li + 1]) limit = Math.min(100000, Math.max(1, Number(rest[li + 1])));

    const since = new Date(Date.now() - sinceMs);
    const rowsAll = await engine.listEvalCandidates({
      since,
      limit,
      tool,
      slugHint,
      mcpTokenName: token,
    });

    let rows: EvalCandidate[] = rowsAll;
    if (!includeQS) {
      rows = rows.filter(r => READ_TOOLS.has(r.tool_name));
    }
    if (actor) {
      rows = rows.filter(r => {
        const pj = JSON.stringify(r.params_jsonb ?? {});
        return pj.includes(actor) || (r.query && r.query.includes(actor));
      });
    }

    if (json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    for (const r of rows) {
      const ts = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
      process.stdout.write(
        `${ts}\t${r.tool_name}\t${r.remote ? 'remote' : 'local'}\t${r.mcp_token_name ?? '-'}\t${(r.query ?? '').slice(0, 80)}\n`,
      );
    }
    return;
  }

  if (sub === 'prune') {
    if (rest.includes('--help') || rest.includes('-h')) {
      printHelpPrune();
      return;
    }
    let olderMs: number | null = null;
    const oi = rest.indexOf('--older-than');
    if (oi >= 0 && rest[oi + 1]) olderMs = parseDurationMs(rest[oi + 1]);
    if (olderMs === null) {
      console.error('audit prune requires --older-than DUR (e.g. 30d)');
      process.exit(1);
    }
    const dry = rest.includes('--dry-run');
    const cutoff = new Date(Date.now() - olderMs);
    if (dry) {
      process.stdout.write(JSON.stringify({ dry_run: true, cutoff: cutoff.toISOString(), read_tools_only: true }, null, 2) + '\n');
      return;
    }
    const n = await engine.deleteEvalCandidatesBefore(cutoff, { readToolsOnly: true });
    process.stdout.write(`Deleted ${n} read-audit row(s) older than ${cutoff.toISOString()}.\n`);
    return;
  }

  console.error('Usage: gbrain audit reads | gbrain audit prune');
  process.exit(1);
}
