/**
 * gbrain waiting / gbrain loops — the open-loop engine's human CLI.
 *
 *   gbrain waiting [--top N] [--json] [--stale-ok]
 *     The killer output: ranked people waiting on you, what you promised,
 *     evidence quotes + Gmail deep links, entity-card context.
 *     REFUSES (with the exact fix) when the google sources haven't synced
 *     within 24h — stale-but-confident output on a trust-critical surface is
 *     worse than none (outside-voice F2). --stale-ok bypasses.
 *
 *   gbrain loops list [--status s] [--type t] [--limit N] [--offset N] [--all] [--json]
 *   gbrain loops show <id> [--json]
 *   gbrain loops done <id> / drop <id>
 *   gbrain loops drop sender <email> [--source <id>] [--note <text>] [--dry-run]
 *   gbrain loops drop --older-than <N>d [--type t] [--source <id>] [--note <text>] [--dry-run]
 *   gbrain loops drop --undo-age-drop [--type t] [--source <id>] [--dry-run]
 *   gbrain loops mute <sender|thread> <value> [--source <id>] [--dry-run]
 *   gbrain loops unmute <sender|thread> <value> [--source <id>] [--dry-run]
 *
 * All paths dispatch through the trusted-local op layer (handleToolCall,
 * remote:false) so CLI and MCP share one behavior. Reads default to the
 * `__all__` brain span (loops live in google sources, not 'default' — an
 * unqualified dispatch would silently scope to 'default' and answer "You are
 * clean" while people wait); `--source <id>` narrows explicitly.
 */

import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { ALL_SOURCES } from '../core/source-id.ts';
import { exitCliError, usageError, writeCliError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { LOOPS_SUBCOMMANDS, ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';

export { LOOPS_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

export function printUsage(): void {
  process.stdout.write(
    [
      'gbrain loops — inspect and manage open loops',
      '  list  [--status open|done|dropped|stale] [--type <loop_type>] [--source <id>] [--limit N] [--offset N] [--all] [--json]',
      '        default: the 200 most recently active; --all pages through every match',
      '  show  <id> [--json]',
      '  done  <id> [--note <text>]   mark handled',
      '  drop  <id> [--note <text>]   not going to do it',
      '  drop  sender <email> [--source <id>] [--note <text>] [--dry-run]',
      '        close every open reply-owed loop from one sender (preview with --dry-run; cannot be undone)',
      '  drop  --older-than <N>d [--type <loop_type>] [--source <id>] [--note <text>] [--dry-run]',
      '        close every open loop idle for N days or more (preview with --dry-run)',
      '  drop  --undo-age-drop [--type <loop_type>] [--source <id>] [--dry-run]',
      '        reopen loops an --older-than drop closed (loops that carried a commitment fact stay closed)',
      '  mute  sender <email> | thread <thread-id>   [--source <id>] [--type <loop_type>] [--dry-run]',
      '        stop new loops and close its open loops (every type unless --type narrows it)',
      '  unmute sender <email> | thread <thread-id>  [--source <id>] [--dry-run]',
      '        undo a mute; loops it closed are re-checked on the next sync',
      '',
      'The ranked digest lives at: gbrain waiting',
    ].join('\n') + '\n',
  );
}

const LIST_DEFAULT = 200;
/** The most loops one open_loops call returns. */
const LIST_PAGE = 500;

/** A whole-number flag value; absent returns `fallback`, malformed exits with a usage error. */
function intFlag(args: string[], flag: string, json: boolean, fallback?: number): number | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isSafeInteger(n) || n < (flag === '--offset' ? 0 : 1)) {
    exitCliError(usageError(`gbrain loops list: ${flag} needs a whole number${flag === '--offset' ? ' of 0 or more' : ' of 1 or more'}.`,
      'Usage: gbrain loops list [--limit N] [--offset N] [--all] [--json].'), 'loops', { json });
  }
  return n;
}

function sourceFlag(args: string[]): string | undefined {
  const i = args.indexOf('--source');
  return i !== -1 ? args[i + 1] : undefined;
}

/** Non-archived sources whose config says kind=google (mute's default scope). */
async function googleSourceIds(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string; config: unknown }>(
    `SELECT id, config FROM sources WHERE archived IS NOT TRUE`,
    [],
  );
  return rows
    .filter((r) => {
      const c =
        typeof r.config === 'string'
          ? (JSON.parse(r.config) as Record<string, unknown>)
          : ((r.config ?? {}) as Record<string, unknown>);
      return c.kind === 'google';
    })
    .map((r) => r.id);
}

interface WaitingResult {
  groups: Array<{
    counterparty: string;
    loop_count: number;
    nearest_due_at: string | null;
    loops: Array<{
      id: number;
      loop_type: string;
      summary: string;
      due_at: string | null;
      quote?: string;
      deep_link?: string;
      page_slug: string | null;
    }>;
    context?: { summary?: string; last_touched?: { last_timeline_date?: string | null } };
  }>;
  /** #5871: loops that name no counterparty, listed apart from the people; null when none. */
  no_counterparty?: { loop_count: number } | null;
  /** #5012: open reply-owed loops the automated-mail rule would not have opened; null when none. */
  withheld_noise?: { loop_count: number; sender_count: number; senders: Array<{ email: string; open_loops: number; preview_command: string }> } | null;
  google_sources_out_of_scope?: string[];
  count: number;
  stale: boolean;
  sources: Array<{ id: string; last_sync_at: string | null; stale: boolean }>;
  /** Fix wave 4: `partial` when a held Gmail thread falls inside the window (listed in `held`). */
  completeness?: 'complete' | 'partial';
  held?: Array<{ source_id: string; key: string; sender: string | null; subject?: string | null; retry_command: string }>;
  text?: string;
}

const WAITING_NOISE_SHOWN = 10;

export async function runWaiting(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'gbrain waiting — who is waiting on you, what you promised, the context to respond',
        '  --top N        max counterparties (default 3)',
        '  --source <id>  scope to one source (default: every source in the brain)',
        '  --json         agent envelope (groups, staleness, completeness, held items, sources)',
        '  --noise        list every sender whose open reply-owed loops the detector would now withhold',
        '  --stale-ok     show possibly-outdated loops even when google sources have not synced in 24h',
        '  --as-of <iso>  rank and age loops as of this time (default: now), to reproduce an order',
        '',
        'Manage loops: gbrain loops --help · Setup: gbrain google setup · Docs: docs/guides/open-loops.md',
      ].join('\n') + '\n',
    );
    return;
  }
  const json = args.includes('--json');
  const staleOk = args.includes('--stale-ok');
  const topIdx = args.indexOf('--top');
  const top = topIdx !== -1 ? Number(args[topIdx + 1]) || 3 : 3;
  const asOfIdx = args.indexOf('--as-of');

  const result = (await handleToolCall(
    engine,
    'open_loops',
    { group_by: 'counterparty', limit: top, include_context: true, ...(asOfIdx !== -1 ? { as_of: args[asOfIdx + 1] } : {}) },
    { sourceId: sourceFlag(args) ?? ALL_SOURCES },
  )) as WaitingResult;

  if (result.stale && !staleOk) {
    const staleSrc = result.sources.filter((s) => s.stale);
    const lines = [
      'Refusing to answer from stale data — every google source is out of date:',
      ...staleSrc.map(
        (s) => `  ${s.id}: last successful sync ${s.last_sync_at ?? 'never'}`,
      ),
      '',
      'Fix: run a sync first, then retry:',
      ...staleSrc.map((s) => `  gbrain sync --source ${s.id}`),
      '',
      '(or pass --stale-ok to see the possibly-outdated loops anyway)',
    ];
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, status: 'stale', sources: result.sources, next_action: { command: staleSrc[0] ? `gbrain sync --source ${staleSrc[0].id}` : 'gbrain sync --all' } }, null, 2) + '\n',
      );
    } else {
      process.stderr.write(lines.join('\n') + '\n');
    }
    setCliExitVerdict(1);
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, status: 'ok', ...result }, null, 2) + '\n');
    return;
  }
  process.stdout.write((result.text ?? 'No open loops.') + '\n');
  const noise = result.withheld_noise;
  if (noise) {
    // The JSON carries every sender; the digest shows the top few unless --noise asks for all of them (#7285).
    const shown = args.includes('--noise') ? noise.senders : noise.senders.slice(0, WAITING_NOISE_SHOWN);
    process.stdout.write(`\n${noise.loop_count} open reply-owed loop(s) come from ${noise.sender_count} sender(s) whose mail is automated; `
      + `the detector would not open them now. Preview closing them, sender by sender:\n`
      + shown.map((x) => `  ${x.preview_command}   (${x.open_loops})`).join('\n') + '\n'
      + (noise.sender_count > shown.length ? `  … and ${noise.sender_count - shown.length} more sender(s): gbrain waiting --noise\n` : ''));
  }
  if (result.groups.length > 0 || result.no_counterparty) {
    process.stdout.write(
      `\n(close: gbrain loops done <id> · mute a sender: gbrain loops mute sender <email> · details: gbrain loops list)\n`,
    );
  }
}

/**
 * `loops show <id>`: asks open_loops for that one id rather than scanning a
 * listed page, so the loop is found at any status and any recency rank.
 * `--status` / `--type` still narrow, and the source span is the same one
 * `loops list` reads.
 */
async function showLoop(
  engine: BrainEngine,
  rest: string[],
  narrowing: Record<string, unknown>,
  readScope: { sourceId: string },
  json: boolean,
): Promise<void> {
  const token = rest.find((a) => /^\d+$/.test(a));
  const loopId = token === undefined ? NaN : Number(token);
  if (!Number.isSafeInteger(loopId) || loopId < 1) {
    exitCliError(usageError('gbrain loops show needs a loop id of 1 or more.',
      'Usage: gbrain loops show <id> [--json]. Example: gbrain loops show 42 (`gbrain loops list` prints ids).'), 'loops', { json });
  }
  const { loops } = (await handleToolCall(
    engine,
    'open_loops',
    { group_by: 'none', id: loopId, ...narrowing },
    readScope,
  )) as { loops: Array<Record<string, unknown>> };
  const loop = loops[0];
  if (loop === undefined) {
    setCliExitVerdict(writeCliError(opError('not_found', `No loop ${loopId} in the sources this command reads.`,
      'Run `gbrain loops list` to see loop ids.', {
        why: 'A loop in a source this command does not read, or one excluded by --status or --type, is reported the same way as an id that does not exist.',
        fix: { argv: ['gbrain', 'loops', 'list'], consent: [], actor: 'agent', why: 'Prints the loops this command can read, with their ids.', requires_exclusive: false },
      }), 'loops', { json }));
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, status: 'ok', loop }, null, 2) + '\n');
    return;
  }
  const due = loop.due_at ? `  due ${String(loop.due_at).slice(0, 10)}` : '';
  process.stdout.write(`#${String(loop.id)} [${String(loop.loop_type)}] ${String(loop.status)}${due}\n${String(loop.summary)}\n`);
  const quote = (loop as { quote?: string }).quote;
  if (quote) process.stdout.write(`> "${quote}"\n`);
  const link = (loop as { deep_link?: string }).deep_link;
  if (link) process.stdout.write(`${link}\n`);
}

function idList(ids: number[]): string {
  if (ids.length === 0) return '';
  return `: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? `, +${ids.length - 20} more` : ''}`;
}

/**
 * #5012: `gbrain loops drop sender <email>` closes every open reply-owed
 * (unanswered_inbound) loop from one sender as `dropped`, one `loops_close`
 * per loop, so each id reports its own outcome. `--dry-run` is the consent
 * step: it lists the ids and count and changes nothing. A drop is final: no
 * command reopens a dropped loop (`mute` is the reversible path).
 */
async function dropSender(engine: BrainEngine, rest: string[], json: boolean): Promise<void> {
  const email = rest[1]?.trim().toLowerCase();
  if (!email || email.startsWith('-') || !email.includes('@')) {
    exitCliError(usageError('gbrain loops drop sender needs an email address.',
      'Usage: gbrain loops drop sender <email> [--source <id>] [--note <text>] [--dry-run]. Preview first with --dry-run.'), 'loops', { json });
  }
  const source = sourceFlag(rest);
  const noteIdx = rest.indexOf('--note');
  const note = noteIdx !== -1 ? rest[noteIdx + 1] : undefined;
  const { listSenderInboundLoops } = await import('../core/loops/loops-store.ts');
  const loops = await listSenderInboundLoops(engine, email!, source ? [source] : null);
  const ids = loops.map((l) => l.id);
  const apply = `gbrain loops drop sender ${email}${source ? ` --source ${source}` : ''}${note !== undefined ? ` --note ${JSON.stringify(note)}` : ''}`;
  if (rest.includes('--dry-run')) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: 'dry_run', sender: email, source_id: source ?? null, would_close: ids, count: ids.length,
        ...(ids.length > 0 ? { apply_command: apply } : {}) }, null, 2) + '\n');
    } else if (ids.length === 0) {
      process.stdout.write(`No open reply-owed loops from ${email}. Nothing to drop.\n`);
    } else {
      process.stdout.write(`Dry run: ${ids.length} open reply-owed loop(s) from ${email} would be dropped${idList(ids)}. Nothing changed.\n`
        + `To drop them (cannot be undone): ${apply}\n`);
    }
    return;
  }
  const closed: number[] = [];
  const failed: Array<{ id: number; reason: string }> = [];
  for (const loop of loops) {
    try {
      const result = (await handleToolCall(engine, 'loops_close', { id: loop.id, status: 'dropped', source_id: loop.source_id,
        note: note ?? `drop sender ${email}` })) as { closed: boolean; reason?: string };
      if (result.closed) closed.push(loop.id);
      else failed.push({ id: loop.id, reason: result.reason ?? 'not_closed' });
    } catch (e) {
      failed.push({ id: loop.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, status: failed.length === 0 ? 'dropped' : 'partial', sender: email,
      source_id: source ?? null, closed, failed, count: closed.length }, null, 2) + '\n');
  } else {
    process.stdout.write(`Dropped ${closed.length} open reply-owed loop(s) from ${email}${idList(closed)}.\n`
      + (failed.length > 0 ? `${failed.length} could not be dropped: ${failed.slice(0, 10).map((f) => `${f.id} (${f.reason})`).join(', ')}\n` : '')
      + (closed.length > 0 ? `To stop new loops from this sender too: gbrain loops mute sender ${email}${source ? ` --source ${source}` : ''}\n` : ''));
  }
  if (failed.length > 0) setCliExitVerdict(1);
}

/** `--older-than 30d` or `--older-than 30`: whole days, 1 or more. */
function parseOlderThanDays(raw: string | undefined): number | null {
  const m = /^(\d+)d?$/.exec(raw ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const LOOP_TYPES = ['commitment_owed_by_me', 'commitment_owed_to_me', 'unanswered_inbound', 'unanswered_outbound', 'decision_pending'];

/**
 * #7288: `gbrain loops drop --older-than <N>d` closes every open loop idle for
 * N days or more as `dropped` (closed_by `age_drop`), one `loops_close` per loop
 * so a commitment loop's fact retires with it. `--dry-run` is the consent step.
 * `--undo-age-drop` reopens what an age drop closed.
 */
async function dropByAge(engine: BrainEngine, rest: string[], json: boolean): Promise<void> {
  const typeIdx = rest.indexOf('--type');
  const loopType = typeIdx !== -1 ? rest[typeIdx + 1] : undefined;
  if (loopType !== undefined && !LOOP_TYPES.includes(loopType)) {
    exitCliError(usageError(`gbrain loops drop: --type must be one of ${LOOP_TYPES.join(', ')}.`,
      'Usage: gbrain loops drop --older-than <N>d [--type <loop_type>] [--source <id>] [--note <text>] [--dry-run].'), 'loops', { json });
  }
  const source = sourceFlag(rest);
  const dryRun = rest.includes('--dry-run');
  const { listLoopsByAge, undoAgeDrop } = await import('../core/loops/loops-store.ts');
  const filterArgs = `${loopType ? ` --type ${loopType}` : ''}${source ? ` --source ${source}` : ''}`;
  if (rest.includes('--undo-age-drop')) {
    const undone = await undoAgeDrop(engine, { sourceIds: source ? [source] : null, ...(loopType ? { loopType: loopType as never } : {}) }, !dryRun);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: dryRun ? 'dry_run' : 'reopened', [dryRun ? 'would_reopen' : 'reopened']: undone.reopened,
        count: undone.reopened.length, skipped_with_fact: undone.skipped_with_fact }, null, 2) + '\n');
    } else {
      process.stdout.write(`${dryRun ? 'Dry run: would reopen' : 'Reopened'} ${undone.reopened.length} loop(s) an age drop closed${idList(undone.reopened)}.`
        + `${dryRun ? ' Nothing changed.' : ''}`
        + `${undone.skipped_with_fact > 0 ? ` ${undone.skipped_with_fact} that carried a commitment fact stay closed.` : ''}\n`);
    }
    return;
  }
  const days = parseOlderThanDays(rest[rest.indexOf('--older-than') + 1]);
  if (days === null) {
    exitCliError(usageError('gbrain loops drop --older-than needs a whole number of days, 1 or more.',
      'Usage: gbrain loops drop --older-than <N>d [--type <loop_type>] [--source <id>] [--note <text>] [--dry-run]. Example: --older-than 30d.'), 'loops', { json });
  }
  const noteIdx = rest.indexOf('--note');
  const note = noteIdx !== -1 ? rest[noteIdx + 1] : undefined;
  const loops = await listLoopsByAge(engine, { olderThanDays: days!, sourceIds: source ? [source] : null, ...(loopType ? { loopType: loopType as never } : {}) });
  const ids = loops.map((l) => l.id);
  const apply = `gbrain loops drop --older-than ${days}d${filterArgs}${note !== undefined ? ` --note ${JSON.stringify(note)}` : ''}`;
  const undo = `gbrain loops drop --undo-age-drop${filterArgs}`;
  if (dryRun) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: 'dry_run', older_than_days: days, would_close: ids, count: ids.length,
        ...(ids.length > 0 ? { apply_command: apply, undo_command: undo } : {}) }, null, 2) + '\n');
    } else if (ids.length === 0) {
      process.stdout.write(`No open loops idle for ${days} day(s) or more. Nothing to drop.\n`);
    } else {
      process.stdout.write(`Dry run: ${ids.length} open loop(s) idle for ${days} day(s) or more would be dropped${idList(ids)}. Nothing changed.\n`
        + `To drop them: ${apply}\nTo reverse it afterwards: ${undo}\n`);
    }
    return;
  }
  const closed: number[] = [];
  const failed: Array<{ id: number; reason: string }> = [];
  for (const loop of loops) {
    try {
      const result = (await handleToolCall(engine, 'loops_close', { id: loop.id, status: 'dropped', source_id: loop.source_id,
        note: AGE_DROP_NOTE })) as { closed: boolean; reason?: string };
      if (result.closed) closed.push(loop.id);
      else failed.push({ id: loop.id, reason: result.reason ?? 'not_closed' });
    } catch (e) {
      failed.push({ id: loop.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, status: failed.length === 0 ? 'dropped' : 'partial', older_than_days: days,
      closed, failed, count: closed.length, undo_command: undo }, null, 2) + '\n');
  } else {
    process.stdout.write(`Dropped ${closed.length} open loop(s) idle for ${days} day(s) or more${idList(closed)}.\n`
      + (failed.length > 0 ? `${failed.length} could not be dropped: ${failed.slice(0, 10).map((f) => `${f.id} (${f.reason})`).join(', ')}\n` : '')
      + (closed.length > 0 ? `Undo: ${undo}\n` : ''));
  }
  if (failed.length > 0) setCliExitVerdict(1);
}

/** `closed_by` stamped by `dropByAge`; matches AGE_DROP in loops-store (undo reads it). */
const AGE_DROP_NOTE = 'age_drop';

export async function runLoops(engine: BrainEngine, args: string[]): Promise<void> {
  const [first, ...rest] = args;
  const sub = first as (typeof LOOPS_SUBCOMMANDS)[number] | undefined;
  const json = rest.includes('--json') || args.includes('--json');

  // cli.ts answers help before dispatch (#6114 router, #6521: `loops show --help` used to exit 2 "needs a loop id").
  if (!sub || subcommandHelpRequested(args, ROUTERS.loops)) {
    printUsage();
    return;
  }

  if (sub === 'list' || sub === 'show') {
    const statusIdx = rest.indexOf('--status');
    const typeIdx = rest.indexOf('--type');
    const narrowing = {
      ...(statusIdx !== -1 ? { status: rest[statusIdx + 1] } : {}),
      ...(typeIdx !== -1 ? { loop_type: rest[typeIdx + 1] } : {}),
    };
    const readScope = { sourceId: sourceFlag(rest) ?? ALL_SOURCES };
    if (sub === 'show') {
      await showLoop(engine, rest, narrowing, readScope, json);
      return;
    }
    const limit = intFlag(rest, '--limit', json);
    const offset = intFlag(rest, '--offset', json, 0);
    type ListPage = { loops: Array<Record<string, unknown>>; count: number; total: number; offset: number; truncated: boolean };
    const fetchPage = (pageLimit: number, pageOffset: number) => handleToolCall(
      engine, 'open_loops', { group_by: 'none', limit: pageLimit, offset: pageOffset, ...narrowing }, readScope) as Promise<ListPage>;
    let result: ListPage;
    if (rest.includes('--all')) {
      // Page through every match; the op serves at most LIST_PAGE per call.
      result = await fetchPage(LIST_PAGE, offset ?? 0);
      const all = [...result.loops];
      while (result.truncated && result.loops.length > 0) {
        result = await fetchPage(LIST_PAGE, (offset ?? 0) + all.length);
        all.push(...result.loops);
      }
      result = { ...result, loops: all, offset: offset ?? 0, truncated: false };
    } else {
      result = await fetchPage(Math.min(limit ?? LIST_DEFAULT, LIST_PAGE), offset ?? 0);
    }
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: 'ok', ...result, returned: result.loops.length,
        ...(result.truncated ? { next_offset: result.offset + result.loops.length } : {}) }, null, 2) + '\n');
      return;
    }
    if (result.loops.length === 0) {
      process.stdout.write('No loops match.\n');
      return;
    }
    for (const l of result.loops) {
      const due = l.due_at ? `  due ${String(l.due_at).slice(0, 10)}` : '';
      process.stdout.write(`#${String(l.id).padEnd(5)} [${String(l.loop_type)}]${due}  ${String(l.summary)}\n`);
    }
    if (result.truncated) {
      process.stdout.write(`Showing ${result.loops.length} of ${result.total}. More: gbrain loops list --offset ${result.offset + result.loops.length} (or --all).\n`);
    }
    return;
  }

  if (sub === 'drop' && rest[0] === 'sender') {
    await dropSender(engine, rest, json);
    return;
  }

  if (sub === 'drop' && (rest.includes('--older-than') || rest.includes('--undo-age-drop'))) {
    await dropByAge(engine, rest, json);
    return;
  }

  if (sub === 'done' || sub === 'drop') {
    const id = Number(rest.find((a) => /^\d+$/.test(a)));
    if (!Number.isFinite(id) || id <= 0) {
      console.error(`Usage: gbrain loops ${sub} <id>`);
      process.exit(2);
    }
    const noteIdx = rest.indexOf('--note');
    const note = noteIdx !== -1 ? rest[noteIdx + 1] : undefined;
    const result = (await handleToolCall(
      engine,
      'loops_close',
      {
        id,
        status: sub === 'done' ? 'done' : 'dropped',
        ...(note !== undefined ? { note } : {}),
      },
      { sourceId: ALL_SOURCES },
    )) as { closed: boolean; reason?: string; status?: string };
    if (json) {
      // Envelope `status` is the outcome; the loop's terminal state rides as
      // `loop_status` (spreading the op result last would clobber the envelope).
      const { status: loopStatus, ...opResult } = result;
      process.stdout.write(
        JSON.stringify(
          {
            ok: result.closed,
            ...opResult,
            status: result.closed ? 'closed' : 'not_closed',
            ...(loopStatus !== undefined ? { loop_status: loopStatus } : {}),
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(result.closed ? `Loop ${id} ${sub === 'done' ? 'done' : 'dropped'}.\n` : `Not closed: ${result.reason}\n`);
    }
    if (!result.closed) setCliExitVerdict(1);
    return;
  }

  if (sub === 'mute' || sub === 'unmute') {
    const kind = rest[0];
    const value = rest[1];
    if ((kind !== 'sender' && kind !== 'thread') || !value) {
      console.error(`Usage: gbrain loops ${sub} sender <email> | thread <thread-id> [--source <id>]`);
      process.exit(2);
    }
    // A suppression row is only consulted by the detector inside ITS source —
    // an unqualified mute/unmute must land in the google source, never
    // 'default'. Both directions share this resolution so an unmute can never
    // aim at a different source than the mute it is reversing.
    let sourceId = sourceFlag(rest);
    if (!sourceId) {
      const gs = await googleSourceIds(engine);
      if (gs.length === 1) sourceId = gs[0];
      else {
        console.error(
          gs.length === 0
            ? `No google source found — pass --source <id> to scope the ${sub} (gbrain sources list).`
            : `Multiple google sources — pass --source <id> (one of: ${gs.join(', ')}).`,
        );
        process.exit(2);
      }
    }
    const dryRun = rest.includes('--dry-run');
    if (sub === 'mute') {
      const muteType = rest.indexOf('--type') !== -1 ? rest[rest.indexOf('--type') + 1] : undefined;
      if (muteType !== undefined && !LOOP_TYPES.includes(muteType)) {
        console.error(`Usage: gbrain loops mute ... --type <${LOOP_TYPES.join('|')}>`);
        process.exit(2);
      }
      const result = (await handleToolCall(engine, 'loops_mute', {
        kind,
        value,
        source_id: sourceId,
        ...(muteType ? { loop_type: muteType } : {}),
        ...(dryRun ? { dry_run: true } : {}),
      })) as { muted?: boolean; reason?: string; closed?: number[]; would_close?: number[]; undo_command: string };
      if (dryRun) {
        const ids = result.would_close ?? [];
        if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'dry_run', ...result }, null, 2) + '\n');
        else process.stdout.write(`Dry run: muting ${kind} ${value} would close ${ids.length} open loop(s)${idList(ids)}. Nothing changed.\n`);
        return;
      }
      if (json) {
        process.stdout.write(JSON.stringify({ ok: result.muted, status: result.muted ? 'muted' : 'not_muted', ...result }, null, 2) + '\n');
      } else if (result.muted) {
        const closed = result.closed ?? [];
        process.stdout.write(`Muted ${kind} ${value}. New loops won't open for it; closed ${closed.length} open loop(s)${idList(closed)}.\n`
          + `Undo: ${result.undo_command} (re-checks the closed loops on the next sync)\n`);
      } else {
        process.stdout.write(`Not muted: ${result.reason}\n`);
      }
      if (!result.muted) setCliExitVerdict(1);
      return;
    }
    const result = (await handleToolCall(engine, 'loops_unmute', {
      kind,
      value,
      source_id: sourceId,
      ...(dryRun ? { dry_run: true } : {}),
    })) as { removed?: boolean; reason?: string; requeued?: number[]; would_requeue?: number[]; unverifiable: number[];
      stale_source?: boolean; recheck_command?: string; undo_command: string };
    if (dryRun) {
      const ids = result.would_requeue ?? [];
      if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'dry_run', ...result }, null, 2) + '\n');
      else process.stdout.write(`Dry run: unmuting ${kind} ${value} would queue ${ids.length} closed loop(s) for re-check${idList(ids)}. Nothing changed.\n`);
      return;
    }
    // A repeated unmute is a no-op, NOT a failure: removed:false exits 0 so
    // scripts can call it unconditionally without special-casing.
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: result.removed ? 'unmuted' : 'not_muted', ...result }, null, 2) + '\n');
    } else {
      const requeued = result.requeued ?? [];
      process.stdout.write(
        (result.removed
          ? `Unmuted ${kind} ${value}. New loops can open for it again.\n`
          : `Not muted: ${kind} ${value} had no suppression in ${sourceId}.\n`)
        + (requeued.length > 0 ? `Queued ${requeued.length} loop(s) the mute closed for re-check on the next sync${idList(requeued)}; each reopens only if nothing answered its thread since.\n` : '')
        + (result.unverifiable.length > 0 ? `${result.unverifiable.length} closed loop(s) have no thread to re-check and stay closed${idList(result.unverifiable)}.\n` : '')
        + (result.stale_source ? `This source has not synced in 24h; the re-check runs on its next sync: ${result.recheck_command}\n` : '')
        + (result.removed ? `Undo: ${result.undo_command}\n` : ''),
      );
    }
    return;
  }

  console.error(`Unknown subcommand: ${sub} (try: gbrain loops --help)`);
  process.exit(2);
}
