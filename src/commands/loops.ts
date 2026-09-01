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
  text?: string;
}

export async function runWaiting(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'gbrain waiting — who is waiting on you, what you promised, the context to respond',
        '  --top N        max counterparties (default 3)',
        '  --source <id>  scope to one source (default: every source in the brain)',
        '  --json         agent envelope (groups, staleness, sources)',
        '  --stale-ok     show possibly-outdated loops even when google sources have not synced in 24h',
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

  const result = (await handleToolCall(
    engine,
    'open_loops',
    { group_by: 'counterparty', limit: top, include_context: true },
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

export async function runLoops(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes('--json') || args.includes('--json');

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(
      [
        'gbrain loops — inspect and manage open loops',
        '  list  [--status open|done|dropped|stale] [--type <loop_type>] [--source <id>] [--json]',
        '  show  <id> [--json]',
        '  done  <id>        mark handled',
        '  drop  <id>        not going to do it',
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
    const result = (await handleToolCall(
      engine,
      'open_loops',
      {
        group_by: 'none',
        limit: 200,
        ...(statusIdx !== -1 ? { status: rest[statusIdx + 1] } : {}),
        ...(typeIdx !== -1 ? { loop_type: rest[typeIdx + 1] } : {}),
      },
      { sourceId: sourceFlag(rest) ?? ALL_SOURCES },
    )) as { loops: Array<Record<string, unknown>>; count: number };
    if (sub === 'show') {
      const id = Number(rest.find((a) => /^\d+$/.test(a)));
      const loop = result.loops.find((l) => l.id === id);
      if (!loop) {
        console.error(`No loop ${id}. (gbrain loops list shows ids; closed loops need --status done/dropped/stale)`);
        setCliExitVerdict(1);
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
      return;
    }
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
    const result = (await handleToolCall(
      engine,
      'loops_close',
      { id, status: sub === 'done' ? 'done' : 'dropped' },
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
