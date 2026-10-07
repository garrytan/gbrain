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
 *   gbrain loops list [--status s] [--type t] [--json]
 *   gbrain loops show <id> [--json]
 *   gbrain loops done <id> / drop <id>
 *   gbrain loops mute <sender|thread> <value> [--source <id>]
 *   gbrain loops unmute <sender|thread> <value> [--source <id>]
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
  count: number;
  stale: boolean;
  sources: Array<{ id: string; last_sync_at: string | null; stale: boolean }>;
  /** Fix wave 4: `partial` when a held Gmail thread falls inside the window (listed in `held`). */
  completeness?: 'complete' | 'partial';
  held?: Array<{ source_id: string; key: string; sender: string | null; subject?: string | null; retry_command: string }>;
  text?: string;
}

export async function runWaiting(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'gbrain waiting — who is waiting on you, what you promised, the context to respond',
        '  --top N        max counterparties (default 3)',
        '  --source <id>  scope to one source (default: every source in the brain)',
        '  --json         agent envelope (groups, staleness, completeness, held items, sources)',
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
  if (result.groups.length > 0) {
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

export async function runLoops(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes('--json') || args.includes('--json');

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(
      [
        'gbrain loops — inspect and manage open loops',
        '  list  [--status open|done|dropped|stale] [--type <loop_type>] [--source <id>] [--json]',
        '  show  <id> [--json]',
        '  done  <id> [--note <text>]   mark handled',
        '  drop  <id> [--note <text>]   not going to do it',
        '  mute  sender <email> | thread <thread-id>   [--source <id>]',
        '  unmute sender <email> | thread <thread-id>  [--source <id>]   undo a mute',
        '',
        'The ranked digest lives at: gbrain waiting',
      ].join('\n') + '\n',
    );
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
    const result = (await handleToolCall(
      engine,
      'open_loops',
      { group_by: 'none', limit: 200, ...narrowing },
      readScope,
    )) as { loops: Array<Record<string, unknown>>; count: number };
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: 'ok', ...result }, null, 2) + '\n');
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
    if (sub === 'mute') {
      const result = (await handleToolCall(engine, 'loops_mute', {
        kind,
        value,
        source_id: sourceId,
      })) as { muted: boolean; reason?: string };
      if (json) {
        process.stdout.write(JSON.stringify({ ok: result.muted, status: result.muted ? 'muted' : 'not_muted', ...result }, null, 2) + '\n');
      } else {
        process.stdout.write(result.muted ? `Muted ${kind} ${value}. New loops won't open for it (existing loops keep their state).\n` : `Not muted: ${result.reason}\n`);
      }
      if (!result.muted) setCliExitVerdict(1);
      return;
    }
    const result = (await handleToolCall(engine, 'loops_unmute', {
      kind,
      value,
      source_id: sourceId,
    })) as { removed: boolean; reason?: string };
    // A repeated unmute is a no-op, NOT a failure: removed:false exits 0 so
    // scripts can call it unconditionally without special-casing.
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, status: result.removed ? 'unmuted' : 'not_muted', ...result }, null, 2) + '\n');
    } else {
      process.stdout.write(
        result.removed
          ? `Unmuted ${kind} ${value}. New loops can open for it again (loops closed meanwhile stay closed).\n`
          : `Not muted: ${kind} ${value} had no suppression in ${sourceId}.\n`,
      );
    }
    return;
  }

  console.error(`Unknown subcommand: ${sub} (try: gbrain loops --help)`);
  process.exit(2);
}
