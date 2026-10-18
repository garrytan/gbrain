/**
 * gbrain questions — pinned questions (standing answers kept current from
 * evidence). Every path dispatches through the trusted-local op layer
 * (handleToolCall, remote:false) so the CLI and the questions_* MCP tools
 * share one behavior.
 *
 *   gbrain questions pin "<question>" [--source <id>] [--prefix <slug-prefix>] [--entity <slug>] [--defer] [--wait-ms N]
 *   gbrain questions pin --id <id> [--publish]      activate (or re-pin) an existing pin
 *   gbrain questions list [--source <id>] [--include-archived]
 *   gbrain questions status <id>
 *   gbrain questions refresh <id> [--full] [--wait-ms N]
 *   gbrain questions unpin <id>
 * Every subcommand takes --json (the receipt). Exit 1 when the answer is
 * blocked (no key, budget, failed refresh, awaiting consent) or a refresh did
 * not publish.
 */
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { shellQuote } from '../core/agent-output.ts';
import type { QuestionReceipt } from '../core/questions/receipt.ts';

const HELP = [
  'gbrain questions — pinned questions: cited answers kept current from your notes',
  '',
  '  pin "<question>"   pin a question and get its first answer (paid model call)',
  '      --source <id>      evidence source (default: current source)',
  '      --prefix <p>       only pages under this slug prefix, e.g. projects/',
  '      --entity <slug>    the entity page the question is about (context_pack shows its answer)',
  '      --defer            pin without the first answer',
  '      --wait-ms N        max wait for the first answer (default 30000)',
  '  pin --id <id>      activate an inactive pin (made over MCP, or imported from dream.auto_think)',
  '      --publish          publish a draft-only pin',
  '  list               pins with freshness and blocked reason (--include-archived, --source <id>)',
  '  status <id>        the answer with per-sentence stale flags and the next action',
  '  refresh <id>       refresh now (--full recomputes; --wait-ms N)',
  '  unpin <id>         stop refreshing and archive the page',
  '',
  'Every subcommand takes --json. Docs: docs/guides/pinned-questions.md',
].join('\n');

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  const valueFlags = new Set(['--source', '--prefix', '--entity', '--wait-ms', '--id', '--brain']);
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) { i++; continue; }
    if (args[i] === '--') return args[i + 1];
    if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

function waitMs(args: string[]): number | undefined {
  const raw = flag(args, '--wait-ms');
  return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
}

function blocked(r: QuestionReceipt): boolean {
  return r.blocked_reason !== null || (r.refresh !== undefined && !['published', 'skipped'].includes(r.refresh.status));
}

function renderReceipt(r: QuestionReceipt, withAnswer: boolean): string {
  const lines = [`${r.id}  [${r.freshness}${r.state !== 'active' ? `, ${r.state}` : ''}${r.publish_mode === 'draft' ? ', draft' : ''}]`, `  Q: ${r.question}`];
  if (r.refresh) lines.push(`  refresh: ${r.refresh.status}${'blocked_reason' in r.refresh ? ` (${r.refresh.blocked_reason})` : ''}${'detail' in r.refresh ? ` — ${r.refresh.detail}` : ''}`);
  if (withAnswer && r.answer?.length) {
    for (const s of r.answer) lines.push(`  ${s.stale ? '[stale] ' : ''}${s.origin === 'owner' ? '(you) ' : ''}${s.text}`);
  } else if (withAnswer && r.answer_revision > 0) {
    lines.push('  (no answer sentences: the evidence did not answer it)');
  }
  lines.push(`  sentences: ${r.sentences.fresh} fresh, ${r.sentences.stale} stale${r.sentences.withheld ? `, ${r.sentences.withheld} withheld` : ''}; last refresh: ${r.last_refresh_at ?? 'never'}`);
  if (r.blocked_reason) lines.push(`  blocked: ${r.blocked_reason}`);
  if (r.fix) {
    const cmd = r.fix.argv ? shellQuote(r.fix.argv) : r.fix.mcp?.tool;
    lines.push(`  next: ${cmd}`, `        ${r.fix.why}`);
  }
  return lines.join('\n');
}

export async function runQuestions(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  const json = rest.includes('--json');
  const source = flag(rest, '--source');
  const out = (doc: unknown, text: string) => process.stdout.write((json ? JSON.stringify(doc, null, 2) : text) + '\n');

  if (sub === 'pin') {
    const id = flag(rest, '--id');
    const question = id ? undefined : positional(rest);
    if (!id && !question) {
      console.error('Usage: gbrain questions pin "<question>" [--source <id>] [--prefix <p>] [--entity <slug>]  |  gbrain questions pin --id <id>');
      process.exit(2);
    }
    const prefix = flag(rest, '--prefix');
    const entity = flag(rest, '--entity');
    const params: Record<string, unknown> = id ? { id } : {
      question,
      ...(source || prefix || entity ? { scope: { ...(source ? { source } : {}), ...(prefix ? { slug_prefix: prefix } : {}), ...(entity ? { entity } : {}) } } : {}),
    };
    if (rest.includes('--defer')) params.defer = true;
    if (rest.includes('--publish')) params.publish = true;
    const wait = waitMs(rest);
    if (wait !== undefined) params.wait_ms = wait;
    const result = await handleToolCall(engine, 'questions_pin', params) as { created: boolean; activated: boolean; receipt: QuestionReceipt };
    out({ ok: !blocked(result.receipt), ...result }, `${result.created ? 'Pinned' : result.activated ? 'Activated' : 'Already pinned'}: ${renderReceipt(result.receipt, true)}`);
    if (blocked(result.receipt)) setCliExitVerdict(1);
    return;
  }
  if (sub === 'list') {
    const result = await handleToolCall(engine, 'questions_list', { ...(source ? { source } : {}), ...(rest.includes('--include-archived') ? { include_archived: true } : {}) }) as {
      questions: QuestionReceipt[]; counts: Record<string, number>;
    };
    const c = result.counts;
    out({ ok: true, ...result }, result.questions.length === 0
      ? 'No pinned questions. Pin one: gbrain questions pin "<question>"'
      : [...result.questions.map(r => renderReceipt(r, false)), '', `${c.total} pinned: ${c.fresh} fresh, ${c.stale} stale, ${c.awaiting_refresh} awaiting refresh, ${c.blocked} blocked`].join('\n'));
    return;
  }
  if (sub === 'status' || sub === 'refresh' || sub === 'unpin') {
    const id = positional(rest);
    if (!id) {
      console.error(`Usage: gbrain questions ${sub} <id>   (ids: gbrain questions list)`);
      process.exit(2);
    }
    if (sub === 'status') {
      const r = await handleToolCall(engine, 'questions_status', { id }) as QuestionReceipt;
      out({ ok: !blocked(r), ...r }, renderReceipt(r, true));
      if (blocked(r)) setCliExitVerdict(1);
      return;
    }
    if (sub === 'refresh') {
      const wait = waitMs(rest);
      const r = await handleToolCall(engine, 'questions_refresh', { id, ...(rest.includes('--full') ? { full: true } : {}), ...(wait !== undefined ? { wait_ms: wait } : {}) }) as QuestionReceipt;
      out({ ok: !blocked(r), ...r }, renderReceipt(r, true));
      if (blocked(r)) setCliExitVerdict(1);
      return;
    }
    const result = await handleToolCall(engine, 'questions_unpin', { id }) as { unpinned: boolean; receipt: QuestionReceipt };
    out({ ok: true, ...result }, result.unpinned ? `Unpinned ${result.receipt.id}: refreshes stopped and its page is archived.` : `${result.receipt.id} was already unpinned.`);
    return;
  }
  console.error(`Unknown subcommand: ${sub} (try: gbrain questions --help)`);
  process.exit(2);
}
