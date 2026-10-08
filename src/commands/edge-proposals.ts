/**
 * `gbrain edge-proposals` — review and apply relationship-contradiction
 * proposals from the edge_contradictions dream phase (host-local).
 *
 *   gbrain edge-proposals list [--status proposed|applied|...|all] [--limit N] [--json]
 *   gbrain edge-proposals show <id> [--json]
 *   gbrain edge-proposals accept <id>     append the closure line and re-derive
 *   gbrain edge-proposals reject <id>
 *   gbrain edge-proposals undo <id> | --all-applied
 *   gbrain edge-proposals date <id> <YYYY-MM-DD>   date an undated pair: writes "Started <type> [[target]]"
 *
 * Every proposal names the subject page, the relationship that ends, the close
 * date (from relationship-specific evidence) and why. gbrain never invents a
 * date: undated pairs wait for `date`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { applyEdgeProposal, rejectEdgeProposal, undoEdgeProposal, DREAM_TIMELINE_SOURCE } from '../core/cycle/edge-contradictions.ts';
import { isCalendarDate, dateKey } from '../core/link-validity.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { intFlagValue } from '../cli/flag-values.ts';
import { EDGE_PROPOSALS_SUBCOMMANDS, ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';
import { bigintToStringReplacer } from '../core/utils.ts';

const STATUSES = ['proposed', 'applied', 'rejected', 'undone', 'stale', 'reverted_by_user', 'undated_unresolved', 'ambiguous_same_date', 'compatible', 'error'];

interface Row {
  id: number | string; status: string; link_type: string; subject: string; a_target: string; b_target: string; ending: string | null;
  close_date: unknown; born_closed: boolean; model: string | null; confidence: number | null; generated_line: string | null; created_at: unknown;
}

function usage(): string {
  return [
    'Usage: gbrain edge-proposals <list|show|accept|reject|undo|date> [args]',
    '  list [--status <status|all>] [--limit N] [--json]   default status: proposed + undated_unresolved',
    '  show <id> [--json]',
    '  accept <id>             write the closure line on the subject page and re-derive its links',
    '  reject <id>             keep both relationships',
    '  undo <id> | --all-applied   remove the closure line(s) this phase wrote',
    '  date <id> <YYYY-MM-DD>  record when the newer relationship started (undated pairs), then re-run the dream cycle',
  ].join('\n');
}

/** Postgres returns `bigint` ids as BigInt (#6193): a safe integer stays a number, anything larger an exact string. */
function normalizeId(id: unknown): number | string {
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : String(id);
}

async function rows(engine: BrainEngine, where: string, params: unknown[], limit = 50): Promise<Row[]> {
  const raw = await engine.executeRaw<Row>(
    `SELECT p.id, p.status, p.link_type, f.slug AS subject, ta.slug AS a_target, tb.slug AS b_target, te.slug AS ending,
            p.close_date::text AS close_date, p.born_closed, p.model, p.confidence, p.generated_line, p.created_at
       FROM link_edge_proposals p
       JOIN pages f ON f.id = p.from_page_id JOIN pages ta ON ta.id = p.a_to_page_id JOIN pages tb ON tb.id = p.b_to_page_id
       LEFT JOIN pages te ON te.id = p.ending_to_page_id
      WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`, params);
  return raw.map(r => ({ ...r, id: normalizeId(r.id) }));
}

function describe(r: Row): string {
  const pair = `${r.subject}: ${r.link_type} ${r.a_target} vs ${r.b_target}`;
  if (r.status === 'proposed' || r.status === 'applied') {
    return `#${r.id} [${r.status}] ${pair} → ${r.ending} ended ${dateKey(r.close_date)}${r.born_closed ? ' (recorded out of order)' : ''}`;
  }
  if (r.status === 'undated_unresolved') return `#${r.id} [undated] ${pair} → cannot both hold, but a start date is missing; run: gbrain edge-proposals date ${r.id} <YYYY-MM-DD>`;
  return `#${r.id} [${r.status}] ${pair}`;
}

export { EDGE_PROPOSALS_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

export function printUsage(): void {
  console.log(usage());
}

export async function runEdgeProposals(engine: BrainEngine, args: string[]): Promise<void> {
  if (subcommandHelpRequested(args, ROUTERS['edge-proposals'])) { printUsage(); return; }
  const [sub, ...rest] = args as [(typeof EDGE_PROPOSALS_SUBCOMMANDS)[number] | undefined, ...string[]];
  const json = rest.includes('--json');
  const flag = (name: string) => {
    const at = rest.findIndex(a => a === name || a.startsWith(`${name}=`));
    if (at < 0) return undefined;
    return rest[at] === name ? rest[at + 1] ?? '' : rest[at]!.slice(name.length + 1);
  };
  const id = Number(rest.find(a => /^\d+$/.test(a)));
  const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, bigintToStringReplacer, 2) : text);

  if (!sub) { printUsage(); return; }
  if (sub === 'list') {
    const status = flag('--status');
    if (status && status !== 'all' && !STATUSES.includes(status)) { console.error(`Unknown status ${status}. One of: ${STATUSES.join(', ')}, all`); setCliExitVerdict(2); return; }
    const rawLimit = flag('--limit');
    const limit = rawLimit === undefined ? 50 : intFlagValue(rawLimit, '--limit', { min: 1, example: 50 });
    const list = status === 'all' ? await rows(engine, 'TRUE', [], limit)
      : await rows(engine, 'p.status = ANY($1::text[])', [status ? [status] : ['proposed', 'undated_unresolved']], limit);
    out(list, list.length ? list.map(describe).join('\n') + '\n\nNext: gbrain edge-proposals accept <id> | reject <id>' : 'No open relationship proposals.');
    return;
  }
  if (!Number.isSafeInteger(id) || id <= 0) { console.error(`${usage()}\n\nA proposal id is required (gbrain edge-proposals list shows them).`); setCliExitVerdict(2); return; }
  if (sub === 'show') {
    const [r] = await rows(engine, 'p.id = $1', [id]);
    if (!r) { console.error(`No proposal #${id}.`); setCliExitVerdict(1); return; }
    out(r, `${describe(r)}\nmodel: ${r.model ?? '-'}  confidence: ${r.confidence ?? '-'}\n${r.generated_line ? `line: - **${dateKey(r.close_date)}** | ${DREAM_TIMELINE_SOURCE} — ${r.generated_line}` : ''}`);
    return;
  }
  if (sub === 'accept' || sub === 'reject' || sub === 'undo') {
    if (sub === 'undo' && rest.includes('--all-applied')) {
      const applied = await engine.executeRaw<{ id: number }>(`SELECT id FROM link_edge_proposals WHERE status = 'applied' ORDER BY id`);
      const results = [];
      for (const a of applied) results.push({ id: Number(a.id), ...(await undoEdgeProposal(engine, Number(a.id))) });
      out(results, `${results.filter(r => r.status === 'undone').length} applied proposal(s) undone.`);
      return;
    }
    const result = sub === 'accept' ? await applyEdgeProposal(engine, id) : sub === 'reject' ? await rejectEdgeProposal(engine, id) : await undoEdgeProposal(engine, id);
    out({ id, ...result }, `#${id}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
    if (!['applied', 'rejected', 'undone'].includes(result.status)) setCliExitVerdict(1);
    return;
  }
  if (sub === 'date') {
    const date = rest.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
    if (!isCalendarDate(date)) { console.error('date needs a calendar date YYYY-MM-DD: when the newer relationship started.'); setCliExitVerdict(2); return; }
    const [r] = await rows(engine, `p.id = $1 AND p.status = 'undated_unresolved'`, [id]);
    if (!r) { console.error(`No undated proposal #${id}.`); setCliExitVerdict(1); return; }
    const target = rest.find(a => a.includes('/')) ?? r.b_target;
    const { operations } = await import('../core/operations.ts');
    const op = operations.find(o => o.name === 'add_timeline_entry')!;
    const sourceId = (await engine.executeRaw<{ source_id: string }>(`SELECT source_id FROM link_edge_proposals WHERE id = $1`, [id]))[0].source_id;
    await op.handler({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } } as never,
      { slug: r.subject, date, summary: `Started ${r.link_type} [[${target}]]`, source: 'gbrain edge-proposals' });
    const { autoLinkWrittenPage } = await import('../core/ops/pages.ts');
    await autoLinkWrittenPage(engine, r.subject, { sourceId });
    await engine.executeRaw(`UPDATE link_edge_proposals SET status = 'rejected', detail = 'dated by user', updated_at = now() WHERE id = $1`, [id]);
    out({ id, status: 'dated', target, date }, `#${id}: recorded "Started ${r.link_type} [[${target}]]" on ${date}. The next dream cycle re-judges the pair with this date.`);
    return;
  }
  console.error(usage());
  setCliExitVerdict(2);
}
