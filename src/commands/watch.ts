/**
 * v0.43 (#2095) — `gbrain watch`: the push transport for push-based context.
 *
 * Reads conversation turns from stdin AS THEY ARRIVE (plain text = a user
 * turn; `user:` / `assistant:` prefixed lines set the role), maintains a
 * rolling window in-process, and volunteers confidence-gated brain pages to
 * stdout after every turn. The consumer pipes its transcript in and reads
 * volunteered pointers out — no per-entity CLI round-trips.
 *
 * Lifecycle: BLOCKS in the stdin iteration (like `gbrain jobs work`), so an
 * interactive TTY session stays alive until Ctrl-C / Ctrl-D and piped input
 * exits at EOF. Either way the handler RETURNS, the CLI_ONLY finally runs
 * finishCliTeardown (volunteer events bank before teardown), and the
 * entrypoint flush-exit ends the process deliberately — which is exactly why
 * `watch` is NOT in DAEMON_COMMANDS: it never returns from main() while work
 * is still running. SIGINT closes the stream and flows through the same
 * drain path instead of killing mid-write.
 *
 * Session dedupe: a slug is volunteered at most once per watch session —
 * already-pushed slugs ride VolunteerOpts.excludeSlugs, skipped inside the
 * core's pointer loop BEFORE the confidence gate and maxPages cap (O(1)
 * membership; a post-call filter would let a recurring entity starve new
 * pages out of the cap — red-team finding).
 *
 * PGLite note: watch holds the single-writer engine for the whole session,
 * so on the default engine it cannot run concurrently with `gbrain serve`
 * (or any other gbrain process) against the same brain — run it against
 * Postgres, or stop serve first. Routing watch through the serve resolve-IPC
 * socket (like the ambient reflex) is a filed follow-up.
 */

import { createInterface } from 'node:readline';
import type { BrainEngine } from '../core/engine.ts';
import {
  volunteerContext,
  formatVolunteeredPage,
  TURN_PREFIX_RE,
  VOLUNTEER_DEFAULT_MAX_PAGES,
  VOLUNTEER_DEFAULT_MIN_CONFIDENCE,
} from '../core/context/volunteer.ts';
import type { WindowTurn } from '../core/context/entity-salience.ts';
import { DEFAULT_WINDOW_TURNS, windowTurnCount } from '../core/context/reflex.ts';
import { loadConfig } from '../core/config.ts';
import { logVolunteerEventsFireAndForget, volunteerEventRowsFrom } from '../core/context/volunteer-events.ts';

export const WATCH_HELP = `gbrain watch — push-based context: volunteer brain pages per conversation turn (#2095)

Reads turns from stdin (one per line; 'user:' / 'assistant:' prefixes set the
role, unprefixed lines are user turns) and prints confidence-gated page
pointers with rationales after each turn. A slug is volunteered at most once
per session. Piped input exits at EOF; interactive sessions exit on Ctrl-C.

Usage:
  some-transcript-feed | gbrain watch [--json]
  gbrain watch                          # interactive: type turns, Ctrl-C to end

PGLite brains: watch holds the single-writer engine for the whole session —
it cannot run alongside \`gbrain serve\` (or other gbrain processes) against
the same brain. Use a Postgres brain for concurrent access.

Flags:
  --json                 JSONL output (one volunteered page per line)
  --window-turns N       rolling extraction window (default ${DEFAULT_WINDOW_TURNS})
  --max-pages N          max pages volunteered per turn (default ${VOLUNTEER_DEFAULT_MAX_PAGES}, cap 5)
  --min-confidence X     confidence gate 0..1 (default ${VOLUNTEER_DEFAULT_MIN_CONFIDENCE})
  --source <id>          source scope (defaults to the canonical 6-tier resolution)
  --help                 this text
`;

function numFlag(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function strFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export interface WatchIoDeps {
  /** Injected line source for tests (defaults to readline over stdin). */
  lines?: AsyncIterable<string>;
  write?: (s: string) => void;
  isTTY?: boolean;
}

export async function runWatch(engine: BrainEngine, args: string[], deps: WatchIoDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    (deps.write ?? ((s: string) => process.stdout.write(s)))(WATCH_HELP);
    return;
  }

  const json = args.includes('--json');
  // --window-turns wins; otherwise the same config knob the ambient reflex
  // honors (retrieval_reflex_window_turns, default 4) applies here too.
  // Hard cap 64: an unbounded window re-scans every retained turn on every
  // turn over an hours-long session — the cost class the priorContext fix
  // removed, reintroduced via a config typo (red-team finding).
  const windowTurns = Math.min(
    64,
    Math.max(1, Math.floor(numFlag(args, '--window-turns') ?? windowTurnCount(loadConfig()))),
  );
  const maxPages = numFlag(args, '--max-pages');
  const minConfidence = numFlag(args, '--min-confidence');
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);

  const { resolveSourceId } = await import('../core/source-resolver.ts');
  const sourceId = await resolveSourceId(engine, strFlag(args, '--source') ?? null, process.cwd());
  const sourceIds = [sourceId];
  const sessionId = `watch-${process.pid}-${Date.now().toString(36)}`;

  if (!deps.lines) {
    // The ready line doubles as a machine-readable readiness signal for
    // scripted consumers (and the SIGINT lifecycle test): engine + source
    // resolution are done, the stdin loop starts next.
    process.stderr.write(
      isTTY
        ? `[watch] interactive session ${sessionId} ready — type turns ('assistant: ...' to set role), Ctrl-C to end\n`
        : `[watch] session ${sessionId} ready\n`,
    );
  }

  const rl = deps.lines
    ? null
    : createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines: AsyncIterable<string> = deps.lines ?? (rl as AsyncIterable<string>);

  // SIGINT closes the stream so the for-await ends and the normal
  // drain-then-exit path runs (never a mid-write kill).
  const onSigint = () => {
    rl?.close();
  };
  process.on('SIGINT', onSigint);

  const window: WindowTurn[] = [];
  const pushedSlugs = new Set<string>(); // session dedupe (slug-only suppression input)
  let turnNo = 0;

  try {
    for await (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim()) continue;
      const m = TURN_PREFIX_RE.exec(line);
      const turn: WindowTurn = m
        ? { role: m[1].toLowerCase() as WindowTurn['role'], text: (m[2] ?? '').trim() }
        : { role: 'user', text: line.trim() };
      if (!turn.text) continue;
      turnNo++;
      window.push(turn);
      if (window.length > windowTurns) window.splice(0, window.length - windowTurns);

      let pages;
      try {
        pages = await volunteerContext(engine, [...window], {
          sourceIds,
          maxPages,
          minConfidence,
          // Session dedupe: skipped inside the core BEFORE the gate + cap
          // (O(1) per pointer) so a recurring slug can't starve new pages.
          excludeSlugs: pushedSlugs,
        });
      } catch {
        continue; // fail-open per turn: a transient DB error never kills the stream
      }
      if (!pages.length) continue;

      for (const p of pages) pushedSlugs.add(p.slug);
      logVolunteerEventsFireAndForget(
        engine,
        volunteerEventRowsFrom(pages, { channel: 'watch', session_id: sessionId, turn: turnNo }),
      );

      if (json) {
        for (const p of pages) {
          write(JSON.stringify({ turn: turnNo, ...p }) + '\n');
        }
      } else {
        for (const p of pages) {
          write(formatVolunteeredPage(p) + '\n');
        }
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    rl?.close();
  }
}
