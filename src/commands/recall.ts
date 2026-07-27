/**
 * v0.31 — `gbrain recall` + `gbrain forget` CLI.
 *
 * Recall is the user-facing query surface over the hot memory `facts` table.
 * Same underlying engine queries as the MCP `recall` op, two output shapes:
 *
 *   gbrain recall <entity>                  # listFactsByEntity
 *   gbrain recall --since "8 hours ago"     # listFactsSince
 *   gbrain recall --session <id>            # listFactsBySession
 *   gbrain recall --today                   # markdown render with kind icons
 *   gbrain recall --grep <text>             # text filter (case-insensitive)
 *   gbrain recall --supersessions [--since DUR]   # audit log
 *   gbrain recall --include-expired
 *   gbrain recall --as-context              # prompt-injection-ready markdown
 *   gbrain recall --json                    # structured output
 *
 *   gbrain forget <fact-id>                  # shorthand for expireFact
 *
 * v0.32 additions (this file):
 *   --since-last-run            # read+advance ~/.gbrain/recall-cursors/<src>.json
 *   --pending                   # append "Pending consolidation: N" footer
 *   --rollup                    # prepend "Top mentions" header (top 5 entities)
 *   --watch [SECONDS]           # re-render on interval; clear-and-redraw TTY,
 *                                 plain delimited blocks non-TTY; backoff +
 *                                 exit-after-5-consecutive-failures
 *
 * v0.32 also adds thin-client routing: on `gbrain init --mcp-only` installs
 * the runRecall / runForget entry points route through callRemoteTool against
 * the remote brain instead of opening the empty local PGLite. The cursor +
 * watch loop + rollup are CLI-only concerns and stay client-side regardless.
 */

import type { BrainEngine, FactRow, FactKind } from '../core/engine.ts';
import { effectiveConfidence } from '../core/facts/decay.ts';
import { resolveEntitySlug } from '../core/entities/resolve.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { readCursor, writeCursor } from '../core/recall-cursor-state.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

// Same kebab-case shape gate the source-resolver applies. v0.32: applied
// locally on thin-client where the canonical resolver's assertSourceExists
// check can't run (local sources table is empty by definition).
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// v0.31 grandfathered emoji icons (pinned by test/facts-recall-render.test.ts).
// CLAUDE.md "no emojis" voice rule applies to new prose; this existing
// test-contract surface stays as-is.
const KIND_ICON: Record<FactKind, string> = {
  event: '📅',
  preference: '🎯',
  commitment: '🤝',
  belief: '💭',
  fact: '📌',
};

interface ParsedFlags {
  entity: string | null;
  since: Date | null;
  sessionId: string | null;
  grep: string | null;
  today: boolean;
  supersessions: boolean;
  includeExpired: boolean;
  asContext: boolean;
  json: boolean;
  source: string;
  limit: number;
  // v0.32
  sinceLastRun: boolean;
  pending: boolean;
  rollup: boolean;
  watchSeconds: number | null;
}

const ROLLUP_LIMIT = 5;
const WATCH_MIN = 1;
const WATCH_MAX = 3600;
const WATCH_DEFAULT = 60;
const WATCH_THIN_CLIENT_WARN_THRESHOLD = 30;
const WATCH_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_FALLBACK_HOURS = 24;

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    entity: null,
    since: null,
    sessionId: null,
    grep: null,
    today: false,
    supersessions: false,
    includeExpired: false,
    asContext: false,
    json: false,
    source: 'default',
    limit: 50,
    sinceLastRun: false,
    pending: false,
    rollup: false,
    watchSeconds: null,
  };
  let positional = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since') { out.since = parseSinceParam(args[++i] ?? ''); continue; }
    if (a === '--session' || a === '--session-id') { out.sessionId = args[++i] ?? null; continue; }
    if (a === '--grep') { out.grep = (args[++i] ?? '').toLowerCase(); continue; }
    if (a === '--today') { out.today = true; continue; }
    if (a === '--supersessions') { out.supersessions = true; continue; }
    if (a === '--include-expired') { out.includeExpired = true; continue; }
    if (a === '--as-context') { out.asContext = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--source') { out.source = args[++i] ?? 'default'; continue; }
    if (a === '--limit') { out.limit = parseInt(args[++i] ?? '50', 10) || 50; continue; }
    if (a === '--since-last-run') { out.sinceLastRun = true; continue; }
    if (a === '--pending') { out.pending = true; continue; }
    if (a === '--rollup') { out.rollup = true; continue; }
    if (a === '--watch') {
      const next = args[i + 1];
      if (next !== undefined && /^-?\d+$/.test(next)) {
        out.watchSeconds = parseInt(next, 10);
        i++;
      } else {
        out.watchSeconds = WATCH_DEFAULT;
      }
      continue;
    }
    if (a.startsWith('--')) continue; // skip unknown flags silently
    if (!positional) positional = a;
  }
  if (positional) out.entity = positional;
  if (out.today && !out.since) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    out.since = start;
  }
  return out;
}

function parseSinceParam(raw: string): Date | null {
  if (!raw) return null;
  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return new Date(iso);
  const ago = raw.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }
  return null;
}

function validateAndNormalizeFlags(flags: ParsedFlags): void {
  if (flags.sinceLastRun && flags.since) {
    process.stderr.write('Error: --since-last-run and --since are mutually exclusive.\n');
    process.exit(2);
  }
  if (flags.watchSeconds !== null) {
    if (flags.watchSeconds <= 0) {
      process.stderr.write(`Error: --watch SECONDS must be >= ${WATCH_MIN} (got ${flags.watchSeconds}).\n`);
      process.exit(2);
    }
    if (flags.watchSeconds > WATCH_MAX) {
      process.stderr.write(`[recall] --watch ${flags.watchSeconds} clamped to ${WATCH_MAX}s.\n`);
      flags.watchSeconds = WATCH_MAX;
    }
    if (flags.watchSeconds < WATCH_MIN) {
      flags.watchSeconds = WATCH_MIN;
    }
  }
  if (flags.source !== 'default' && !SOURCE_ID_RE.test(flags.source)) {
    process.stderr.write(`Error: --source value "${flags.source}" must match [a-z0-9-]{1,32} (kebab-case).\n`);
    process.exit(2);
  }
}

async function resolveSourceForRecall(
  engine: BrainEngine,
  flagValue: string,
  thinClient: boolean,
): Promise<string> {
  if (thinClient) {
    if (flagValue !== 'default') return flagValue;
    const env = process.env.GBRAIN_SOURCE;
    if (env && env.length > 0 && SOURCE_ID_RE.test(env)) return env;
    return 'default';
  }
  // Local engine path: prefer the canonical 6-tier resolver so we get
  // env var + dotfile + cwd-prefix + config-default fallbacks. If the
  // resolved id isn't registered in the local `sources` table, fall back
  // to the literal value with a stderr notice — this preserves the
  // pre-v0.32 "query whatever source the user typed and let it return
  // empty" behavior so existing tests + scripts keep working while
  // recall still benefits from the env/dotfile resolution chain.
  try {
    return await resolveSourceId(engine, flagValue !== 'default' ? flagValue : null);
  } catch (e) {
    process.stderr.write(
      `[recall] source not registered: ${flagValue}. Falling back to literal value.\n`,
    );
    return flagValue;
  }
}

export async function runRecall(engine: BrainEngine, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  validateAndNormalizeFlags(flags);

  const cfg = loadConfig();
  const thinClient = isThinClient(cfg);

  if (flags.watchSeconds !== null && thinClient && flags.watchSeconds < WATCH_THIN_CLIENT_WARN_THRESHOLD) {
    process.stderr.write(
      `[recall] --watch ${flags.watchSeconds}s on a thin-client install: each tick is a remote MCP call. ` +
      `Consider 60s+ for cron / long sessions.\n`,
    );
  }

  const sourceId = await resolveSourceForRecall(engine, flags.source, thinClient);

  if (flags.watchSeconds !== null) {
    await runWatchLoop(engine, flags, sourceId, thinClient, flags.watchSeconds);
    return;
  }
  await runRecallOnce(engine, flags, sourceId, thinClient, 'briefing');
}

async function runRecallOnce(
  engine: BrainEngine,
  flags: ParsedFlags,
  sourceId: string,
  thinClient: boolean,
  cursorVariant: 'briefing' | 'watch',
  cursorOverride?: Date | null,
): Promise<Date> {
  // Codex round 1 #2: T_start is captured BEFORE the first read SQL fires.
  // Facts inserted during render/write get included by the next run.
  const tStart = new Date();

  let resolvedSince: Date | null = flags.since;
  if (flags.sinceLastRun) {
    if (cursorOverride !== undefined) {
      resolvedSince = cursorOverride;
    } else {
      resolvedSince = readCursor(sourceId, cursorVariant);
    }
    if (!resolvedSince) {
      resolvedSince = new Date(Date.now() - DEFAULT_FALLBACK_HOURS * 60 * 60 * 1000);
    }
  }

  let rows: FactRow[];
  let pendingCount: number | undefined;

  if (thinClient) {
    const cfg = loadConfig();
    const params: Record<string, unknown> = {
      limit: flags.limit,
      include_expired: flags.includeExpired,
    };
    if (flags.supersessions) params.supersessions = true;
    if (flags.entity) params.entity = flags.entity;
    if (flags.sessionId) params.session_id = flags.sessionId;
    if (resolvedSince) params.since = resolvedSince.toISOString();
    if (flags.grep) params.grep = flags.grep;
    if (flags.pending) params.include_pending = true;
    if (sourceId !== 'default') params.source_id = sourceId;

    const raw = await callRemoteTool(cfg!, 'recall', params, { timeoutMs: 30_000 });
    const unpacked = unpackToolResult<{
      facts: Array<Record<string, unknown>>;
      total: number;
      pending_consolidation_count?: number;
    }>(raw);
    rows = unpacked.facts.map(remoteFactToRow);
    pendingCount = unpacked.pending_consolidation_count;
  } else {
    rows = await fetchRowsLocal(engine, flags, sourceId, resolvedSince);
    if (flags.pending) {
      pendingCount = await engine.countUnconsolidatedFacts(sourceId);
    }
  }

  if (flags.grep) {
    const g = flags.grep;
    rows = rows.filter(r => r.fact.toLowerCase().includes(g));
  }

  const rollup = flags.rollup ? computeRollup(rows) : null;

  if (flags.json) {
    const payload: Record<string, unknown> = {
      facts: rows.map(factRowToJson),
      total: rows.length,
    };
    if (rollup) payload.top_entities = rollup;
    if (pendingCount !== undefined) payload.pending_consolidation_count = pendingCount;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else if (flags.asContext) {
    process.stdout.write(renderAsContext(rows) + '\n');
  } else if (flags.supersessions) {
    process.stdout.write(renderSupersessions(rows));
  } else if (flags.today) {
    process.stdout.write(renderToday(rows));
  } else {
    if (rollup) process.stdout.write(renderRollup(rollup));
    process.stdout.write(renderHumanList(rows));
    if (pendingCount !== undefined && pendingCount > 0) {
      process.stdout.write(`\nPending consolidation: ${pendingCount} unconsolidated fact${pendingCount === 1 ? '' : 's'}\n`);
    }
  }

  if (flags.sinceLastRun) {
    writeCursor(sourceId, tStart, cursorVariant);
  }

  return tStart;
}

async function fetchRowsLocal(
  engine: BrainEngine,
  flags: ParsedFlags,
  sourceId: string,
  resolvedSince: Date | null,
): Promise<FactRow[]> {
  if (flags.supersessions) {
    return engine.listSupersessions(sourceId, {
      since: resolvedSince ?? undefined,
      limit: flags.limit,
    });
  }
  if (flags.entity) {
    const slug = (await resolveEntitySlug(engine, sourceId, flags.entity)) ?? flags.entity;
    return engine.listFactsByEntity(sourceId, slug, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  }
  if (flags.sessionId) {
    return engine.listFactsBySession(sourceId, flags.sessionId, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  }
  if (resolvedSince) {
    return engine.listFactsSince(sourceId, resolvedSince, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  }
  return engine.listFactsSince(sourceId, new Date(0), {
    activeOnly: !flags.includeExpired,
    limit: flags.limit,
  });
}

/**
 * Codex round 1 #8: compute top-K mentions from the FULL result set, not a
 * LIMIT-100 slice. JSON shape uses `entity_slug` to match engine.getStats()
 * and test/facts-doctor-shape.test.ts:49 (the existing pinned key).
 *
 * Exported for test/recall-rollup.test.ts — the rollup is a pure function of
 * the FactRow[] and its correctness is independent of transport. Pinning it
 * directly catches regressions of either Codex #8 finding (full-window or
 * shape drift).
 */
export function computeRollup(rows: FactRow[]): Array<{ entity_slug: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.entity_slug) continue;
    counts.set(r.entity_slug, (counts.get(r.entity_slug) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([entity_slug, count]) => ({ entity_slug, count }))
    .sort((a, b) => (b.count - a.count) || a.entity_slug.localeCompare(b.entity_slug))
    .slice(0, ROLLUP_LIMIT);
}

function renderRollup(rollup: Array<{ entity_slug: string; count: number }>): string {
  if (rollup.length === 0) return '';
  const parts = ['Top mentions:', ''];
  for (const r of rollup) {
    parts.push(`  ${r.entity_slug.padEnd(40)} ${String(r.count).padStart(3)}`);
  }
  parts.push('');
  return parts.join('\n');
}

async function runWatchLoop(
  engine: BrainEngine,
  flags: ParsedFlags,
  sourceId: string,
  thinClient: boolean,
  intervalSec: number,
): Promise<void> {
  const isTty = process.stdout.isTTY === true;
  let sigintReceived = false;
  let consecutiveFailures = 0;

  const onSigint = () => {
    sigintReceived = true;
    if (isTty) {
      process.stdout.write('\x1b[?25h'); // show cursor
    }
  };
  process.on('SIGINT', onSigint);
  if (isTty) {
    process.stdout.write('\x1b[?25l'); // hide cursor for the duration of the loop
  }

  try {
    let priorTickStart: Date | null = readCursor(sourceId, 'watch');
    if (!priorTickStart) {
      priorTickStart = new Date(Date.now() - DEFAULT_FALLBACK_HOURS * 60 * 60 * 1000);
    }

    const effectiveFlags: ParsedFlags = { ...flags, sinceLastRun: true };

    while (!sigintReceived) {
      if (isTty) {
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(
          `gbrain recall --watch ${intervalSec}s  ` +
          `(${new Date().toISOString()})  ` +
          `Ctrl-C to exit\n\n`,
        );
      } else {
        process.stdout.write(`--- ${new Date().toISOString()} ---\n`);
      }

      try {
        const tStart = await runRecallOnce(
          engine,
          effectiveFlags,
          sourceId,
          thinClient,
          'watch',
          priorTickStart,
        );
        priorTickStart = tStart;
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        process.stderr.write(
          `[recall watch] tick failed (${consecutiveFailures}/${WATCH_MAX_CONSECUTIVE_FAILURES}): ${(e as Error).message}\n`,
        );
        if (consecutiveFailures >= WATCH_MAX_CONSECUTIVE_FAILURES) {
          process.stderr.write(
            `[recall watch] ${WATCH_MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
            `Briefing cursor NOT advanced. Exiting.\n`,
          );
          break;
        }
      }

      if (sigintReceived) break;

      let waitMs = intervalSec * 1000;
      if (consecutiveFailures > 0) {
        const mult = Math.min(2 ** (consecutiveFailures - 1), 5);
        waitMs = intervalSec * 1000 * mult;
      }
      await sleepInterruptible(waitMs, () => sigintReceived);
    }
  } finally {
    process.off('SIGINT', onSigint);
    if (isTty) {
      process.stdout.write('\x1b[?25h\n'); // restore cursor + newline
    }
  }
}

function sleepInterruptible(ms: number, isInterrupted: () => boolean): Promise<void> {
  return new Promise<void>(resolve => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (isInterrupted() || Date.now() >= deadline) return resolve();
      setTimeout(tick, Math.min(100, deadline - Date.now()));
    };
    tick();
  });
}

function remoteFactToRow(o: Record<string, unknown>): FactRow {
  const parseMaybeDate = (v: unknown): Date | null => {
    if (typeof v !== 'string' || v.length === 0) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms) : null;
  };
  return {
    id: Number(o.id),
    source_id: typeof o.source === 'string' ? o.source : 'default',
    fact: String(o.fact ?? ''),
    kind: (o.kind as FactKind) ?? 'fact',
    entity_slug: typeof o.entity_slug === 'string' ? o.entity_slug : null,
    visibility: (o.visibility === 'private' || o.visibility === 'world') ? o.visibility : 'private',
    notability: (o.notability === 'high' || o.notability === 'medium' || o.notability === 'low') ? o.notability : 'medium',
    context: null,
    valid_from: parseMaybeDate(o.valid_from) ?? new Date(0),
    valid_until: parseMaybeDate(o.valid_until),
    expired_at: parseMaybeDate(o.expired_at),
    superseded_by: typeof o.superseded_by === 'number' ? o.superseded_by : null,
    consolidated_at: parseMaybeDate(o.consolidated_at),
    consolidated_into: typeof o.consolidated_into === 'number' ? o.consolidated_into : null,
    source: typeof o.source === 'string' ? o.source : '',
    source_session: typeof o.source_session === 'string' ? o.source_session : null,
    confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    embedding: null,
    embedded_at: null,
    created_at: parseMaybeDate(o.created_at) ?? new Date(0),
  };
}

function factRowToJson(r: FactRow): Record<string, unknown> {
  return {
    id: r.id,
    fact: r.fact,
    kind: r.kind,
    entity_slug: r.entity_slug,
    visibility: r.visibility,
    notability: r.notability,
    valid_from: r.valid_from.toISOString(),
    valid_until: r.valid_until?.toISOString() ?? null,
    expired_at: r.expired_at?.toISOString() ?? null,
    superseded_by: r.superseded_by,
    consolidated_at: r.consolidated_at?.toISOString() ?? null,
    consolidated_into: r.consolidated_into,
    source: r.source,
    source_session: r.source_session,
    confidence: r.confidence,
    effective_confidence: Number(effectiveConfidence(r).toFixed(3)),
    created_at: r.created_at.toISOString(),
  };
}

export async function runForget(engine: BrainEngine, args: string[]): Promise<void> {
  const idArg = args.find(a => /^\d+$/.test(a));
  if (!idArg) {
    process.stderr.write('Usage: gbrain forget <fact-id> [--reason <text>]\n');
    process.exit(1);
  }
  const id = parseInt(idArg, 10);

  // Optional --reason <text> passes through to the fence's "forgotten:
  // <reason>" context cell so the markdown carries the rationale.
  let reason: string | undefined = undefined;
  const idx = args.indexOf('--reason');
  if (idx >= 0 && idx + 1 < args.length) reason = args[idx + 1];

  // v0.33: thin-client routing. Without this, `gbrain forget <id>` on a
  // thin-client install would call the local fence helper against the empty
  // local PGLite and report "No fact" while the real fact lives on the
  // remote brain.
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const params: Record<string, unknown> = { id };
    if (reason !== undefined) params.reason = reason;
    const raw = await callRemoteTool(cfg!, 'forget_fact', params, { timeoutMs: 30_000 });
    const result = unpackToolResult<{ id: number; expired: boolean }>(raw);
    if (!result.expired) {
      process.stderr.write(`No active fact with id=${id}\n`);
      process.exit(1);
    }
    process.stdout.write(`Forgot fact id=${id}\n`);
    return;
  }

  // v0.32.2: route through forgetFactInFence so the forget rewrites the
  // page's `## Facts` fence and survives `gbrain rebuild`. Legacy rows
  // fall back to the legacy DB-only expire path; the helper handles
  // the fallback internally.
  const { forgetFactInFence } = await import('../core/facts/forget.ts');
  const result = await forgetFactInFence(engine, id, { reason });

  if (!result.ok && result.path === 'not_found') {
    process.stderr.write(`No fact with id=${id}\n`);
    process.exit(1);
  }
  if (!result.ok && result.path === 'already_expired') {
    process.stderr.write(`Fact id=${id} is already expired\n`);
    process.exit(1);
  }
  const suffix = result.path === 'fence' ? '' : ' (legacy DB-only — will not survive gbrain rebuild)';
  process.stdout.write(`Forgot fact id=${id}${suffix}\n`);
}

function renderToday(rows: FactRow[]): string {
  if (rows.length === 0) {
    return '# Hot memory — today\n\nNo facts captured today yet.\n';
  }
  const date = new Date().toISOString().slice(0, 10);
  const byEntity = new Map<string, FactRow[]>();
  for (const r of rows) {
    const k = r.entity_slug ?? '(no entity)';
    const arr = byEntity.get(k) ?? [];
    arr.push(r);
    byEntity.set(k, arr);
  }
  const parts: string[] = [`# Hot memory — ${date}`, ''];
  for (const [entity, group] of byEntity) {
    parts.push(`## ${entity}`);
    for (const r of group) {
      const icon = KIND_ICON[r.kind];
      const ageStr = humanAge(r.valid_from);
      const conf = effectiveConfidence(r).toFixed(2);
      parts.push(`- ${icon} ${r.fact} (${r.kind}, ${ageStr}, conf ${conf})`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function renderSupersessions(rows: FactRow[]): string {
  if (rows.length === 0) {
    return '# Supersessions — none\n\nNo facts have been auto-superseded.\n';
  }
  const parts = ['# Supersession audit log', ''];
  for (const r of rows) {
    const expired = r.expired_at?.toISOString() ?? '?';
    parts.push(`- id=${r.id} expired=${expired} superseded_by=${r.superseded_by ?? '?'}`);
    parts.push(`  was: ${r.fact}`);
  }
  return parts.join('\n') + '\n';
}

function renderHumanList(rows: FactRow[]): string {
  if (rows.length === 0) return 'No matching facts.\n';
  const parts: string[] = [];
  for (const r of rows) {
    const icon = KIND_ICON[r.kind];
    const tag = r.entity_slug ? `[${r.entity_slug}] ` : '';
    const conf = effectiveConfidence(r).toFixed(2);
    const expired = r.expired_at ? ' (expired)' : '';
    parts.push(`${icon} id=${r.id} ${tag}${r.fact} (${r.kind}, conf ${conf})${expired}`);
  }
  return parts.join('\n') + '\n';
}

function renderAsContext(rows: FactRow[]): string {
  if (rows.length === 0) return '<!-- gbrain hot memory: empty -->\n';
  const parts = ['<!-- gbrain hot memory (auto-injected) -->', ''];
  for (const r of rows) {
    const icon = KIND_ICON[r.kind];
    const tag = r.entity_slug ? ` [${r.entity_slug}]` : '';
    const ageStr = humanAge(r.valid_from);
    parts.push(`- ${icon}${tag} ${r.fact} (${r.kind}, ${ageStr})`);
  }
  return parts.join('\n');
}

function humanAge(when: Date, now: Date = new Date()): string {
  const ms = now.getTime() - when.getTime();
  if (ms < 0) return 'in future';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
