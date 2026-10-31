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
 *   gbrain recall --question "<q>"          # facts ranked by relevance to the question
 *
 *   gbrain forget <fact-id>                  # durable withdrawal (forget_fact / forget verb)
 *   gbrain forget <fact-id> --purge          # owner-only purge (src/commands/forget-purge.ts)
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
import { clampSearchLimit } from '../core/engine.ts';
import { effectiveConfidence } from '../core/facts/decay.ts';
import { resolveEntitySlug } from '../core/entities/resolve.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { RemoteMcpError } from '../core/remote-mcp-error.ts';
import { readRecallCursor, writeCursor, writePagedCursor, type RecallCursor } from '../core/recall-cursor-state.ts';
import { resolveSourceId, resolveSourceIdEngineFree, SourceTargetError } from '../core/source-resolver.ts';
import { usageError } from '../cli/cli-error.ts';
import { parseSinceParam, SINCE_GRAMMAR } from '../core/facts/since-parse.ts';

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
  idea: '💡',
};

export interface ParsedFlags {
  entity: string | null;
  /** #4828/#7166: the entity came from --entity (never split or widened), not the bare positional. */
  entityExplicit: boolean;
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
  all: boolean;
  // MEMORY_VERBS v1 [c4]: recall's verb params, routed through the recall OP
  // (this hand-rolled CLI otherwise ignores unknown flags silently).
  query: string | null;
  question: string | null;
  budgetTokens: number | null;
  budgetPolicy: string | null;
  sourceExplicit: boolean;
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

export function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    entity: null,
    entityExplicit: false,
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
    all: false,
    query: null,
    question: null,
    budgetTokens: null,
    budgetPolicy: null,
    sourceExplicit: false,
    sinceLastRun: false,
    pending: false,
    rollup: false,
    watchSeconds: null,
  };
  let positional = '';
  let entityFlag: string | null = null;
  let rawBudget: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since') {
      const raw = args[i + 1];
      const valueGiven = raw !== undefined && !raw.startsWith('--');
      const since = valueGiven ? parseSinceParam(raw) : null;
      if (!since || !Number.isFinite(since.getTime())) {
        throw usageError(valueGiven ? `--since is not a date or duration (got "${raw.slice(0, 60)}").` : '--since requires a date or duration.',
          `Pass ${SINCE_GRAMMAR}.`, {
            why: `An unreadable time bound must not silently widen recall to every fact. --since takes ${SINCE_GRAMMAR}.`,
            fix: { argv: ['gbrain', 'recall', '--help'], consent: [], actor: 'agent', why: 'Shows the accepted --since forms.', requires_exclusive: false },
          });
      }
      out.since = since;
      i++;
      continue;
    }
    if (a === '--session' || a === '--session-id') {
      const raw = args[i + 1];
      if (raw === undefined || raw.trim().length === 0 || raw.startsWith('--')) {
        throw usageError(`${a} requires a session ID.`, `Pass the session ID after the flag, e.g. ${a} <id>.`, {
          why: 'A missing session bound must not silently widen recall to every session.',
          fix: { argv: ['gbrain', 'recall', '--help'], consent: [], actor: 'agent', why: 'Shows the recall selectors.', requires_exclusive: false },
        });
      }
      out.sessionId = raw;
      i++;
      continue;
    }
    // #7166: --entity matches the recall op's `entity` parameter (same as the bare positional).
    if (a === '--entity' || a.startsWith('--entity=')) {
      const raw = a === '--entity' ? args[i + 1] : a.slice('--entity='.length);
      if (raw === undefined || raw.trim() === '' || (a === '--entity' && raw.startsWith('--'))) {
        throw usageError('--entity requires an entity name or slug.', 'Pass it after the flag, e.g. --entity people/alice-example.', {
          why: 'An empty entity must not silently widen recall to every fact.',
          fix: { argv: ['gbrain', 'recall', '--help'], consent: [], actor: 'agent', why: 'Shows the recall selectors.', requires_exclusive: false },
        });
      }
      entityFlag = raw;
      if (a === '--entity') i++;
      continue;
    }
    if (a === '--grep') { out.grep = (args[++i] ?? '').toLowerCase(); continue; }
    if (a === '--today') { out.today = true; continue; }
    if (a === '--supersessions') { out.supersessions = true; continue; }
    if (a === '--include-expired') { out.includeExpired = true; continue; }
    if (a === '--as-context') { out.asContext = true; continue; }
    if (a === '--all') { out.all = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--source') { out.source = args[++i] ?? 'default'; out.sourceExplicit = true; continue; }
    if (a === '--source-id') { out.source = args[++i] ?? ''; out.sourceExplicit = true; continue; }
    if (a.startsWith('--source-id=')) { out.source = a.slice('--source-id='.length); out.sourceExplicit = true; continue; }
    if (a === '--limit') {
      const raw = args[++i] ?? '';
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
        const message = `--limit must be a positive safe integer (got "${raw}").`;
        // Agent contract v1: invalid_params (exit 2 through renderCliError, the envelope under --json).
        const valueGiven = i < args.length && !raw.startsWith('--');
        const argv = ['gbrain', 'recall', ...args.slice(0, i), '50', ...args.slice(valueGiven ? i + 1 : i)];
        throw usageError(message, 'Pass a positive integer, e.g. --limit 50.', {
          why: '--limit caps how many facts recall returns, so it must be a whole number of at least 1.',
          fix: { argv, consent: [], actor: 'agent', why: 'The same recall with a valid --limit.', requires_exclusive: false },
        });
      }
      out.limit = Number(raw); continue;
    }
    if (a === '--query') { out.query = args[++i] ?? null; continue; }
    if (a === '--question') { out.question = args[++i] ?? null; continue; }
    if (a.startsWith('--question=')) { out.question = a.slice('--question='.length); continue; }
    if (a === '--budget-tokens') { rawBudget = args[++i]; continue; }
    if (a === '--budget-policy') {
      const next = args[i + 1];
      out.budgetPolicy = next === undefined || next.startsWith('--') ? '' : next;
      if (next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    if (a.startsWith('--budget-policy=')) { out.budgetPolicy = a.slice('--budget-policy='.length); continue; }
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
  if (entityFlag !== null && positional && positional !== entityFlag) {
    throw usageError(`--entity "${entityFlag.slice(0, 60)}" and the positional "${positional.slice(0, 60)}" name different entities.`,
      'Pass the entity once: either --entity <name> or the bare positional.', {
        why: 'recall reads one entity per call; two different names would silently drop one.',
        fix: { argv: ['gbrain', 'recall', '--entity', entityFlag], consent: [], actor: 'agent', why: 'Recall the --entity value only.', requires_exclusive: false },
      });
  }
  if (entityFlag !== null) { out.entity = entityFlag; out.entityExplicit = true; }
  else if (positional) out.entity = positional;
  out.budgetTokens = (out.budgetPolicy === 'query_first' && out.query?.trim()
    ? Number(rawBudget)
    : parseInt(rawBudget ?? '', 10)) || null;
  if (out.today && !out.since) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    out.since = start;
  }
  return out;
}

/** Only `--query`/`--budget-tokens` without --budget-policy or --question runs the recall op in-process; every other form has a thin-client path. */
export function recallNeedsLocalEngine(args: string[]): boolean {
  const flags = parseFlags(args);
  return flags.all || (flags.budgetPolicy === null && flags.question === null && (flags.query !== null || flags.budgetTokens !== null));
}

export function validateAndNormalizeFlags(flags: ParsedFlags): void {
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
  // #5535: whether --source/--source-id was actually PASSED. parseFlags
  // defaults flags.source to the literal 'default', so the value alone
  // cannot distinguish "user asked for the default source" from "user
  // passed no source flag".
  sourceExplicit: boolean,
  routing: RecallRouting = callerRouting(),
): Promise<string> {
  if (thinClient) {
    // #5535: an explicit `--source default` is a real selector, not an
    // omitted flag — return the literal id instead of falling through to
    // GBRAIN_SOURCE / the server's own default.
    if (sourceExplicit || flagValue !== 'default') return flagValue;
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
    // #5535: pass the flag's literal value (including 'default') when it
    // was explicit so tier 1 of the resolver wins; null only when the flag
    // was omitted, which keeps the env/dotfile/config-default chain.
    return await resolveSourceId(engine, sourceExplicit || flagValue !== 'default' ? flagValue : null, routing.cwd, { env: routing.env });
  } catch (e) {
    process.stderr.write(
      `[recall] source not registered: ${flagValue}. Falling back to literal value.\n`,
    );
    return flagValue;
  }
}

const RECALL_HELP = `Usage: gbrain recall [<entity>] [options]

Find saved facts (MEMORY_VERBS v1). A question goes in --question; the bare
positional is an entity name, then a literal piece of fact text.

  gbrain recall <entity>                 facts about one entity (person, company, "user"); same as --entity <entity>
  gbrain recall --question "<q>"         facts ranked by relevance to a natural-language question
  gbrain recall --query "<q>"            facts plus matching pages
  gbrain recall --grep <text>            facts whose text contains <text>
  gbrain recall --since "8 hours ago"    facts from a time window (--today: today, rendered by kind)
  gbrain recall --session <id>           facts from one session

--since-last-run shows facts created since the previous run. When more than
--limit facts arrived, it shows the oldest --limit of them and the next run
continues after the last one shown (local brains; a thin client warns instead).

--since takes an ISO 8601 date or datetime, a duration ("8 hours ago", "30m",
"2d") or a relative phrase ("6 weeks ago", "last month"). An unreadable
--since or a --session with no ID is refused (invalid_params, exit 2).

Options: --all (local, world facts, exact entity + explicit source + JSON; complete stable read), --limit N, --include-expired, --json, --as-context, --source <id>,
--budget-tokens N, --budget-policy facts_first|query_first, --supersessions,
--since-last-run, --pending, --rollup, --watch [SECONDS].
Withdraw a fact with gbrain forget <fact-id>.
`;

/** Complete exact-entity local read. Never substitute a capped remote response. */
async function runRecallAll(engine: BrainEngine, flags: ParsedFlags): Promise<void> {
  if (!flags.entity || !flags.sourceExplicit || !SOURCE_ID_RE.test(flags.source) || !flags.json
      || flags.query !== null || flags.question !== null || flags.budgetTokens !== null
      || flags.budgetPolicy !== null || flags.since || flags.sessionId || flags.grep
      || flags.supersessions || flags.sinceLastRun || flags.pending || flags.rollup
      || flags.watchSeconds !== null || flags.asContext || flags.today) {
    throw usageError('--all requires an exact entity, explicit --source and --json, with no ranking or window options.',
      'Use gbrain recall <entity-slug> --source <id> --all --json.');
  }
  if (isThinClient(loadConfig())) {
    throw usageError('--all requires a local engine; remote recall cannot certify complete enumeration.',
      'Run this read on the brain host.');
  }
  const sourceId = await resolveSourceId(engine, flags.source);
  const { resolveReadEligibility } = await import('../core/eligibility/policy.ts');
  const { stampRowTrust } = await import('../core/eligibility/stamp.ts');
  const { redactRetrievalOutput } = await import('../core/search/output-redaction.ts');
  const eligibility = await resolveReadEligibility({ engine });
  const scan = async () => {
    const rows: FactRow[] = [];
    const seen = new Set<number>();
    for (let offset = 0; ; offset += 100) {
      const page = await engine.listFactsByEntity(sourceId, flags.entity!, {
        activeOnly: !flags.includeExpired, limit: 100, offset, excludeAuditRows: true, eligibility, visibility: ['world'], excludePrivate: true,
      });
      for (const row of page) {
        if (row.source_id !== sourceId || row.entity_slug !== flags.entity || seen.has(row.id)) {
          throw usageError('Complete recall changed or returned an out-of-scope row.', 'Retry the complete read.');
        }
        seen.add(row.id);
        rows.push(row);
      }
      if (page.length < 100) break;
    }
    const stamped = await stampRowTrust(engine, 'facts', rows.map(row => ({ ...factRowToJson(row), source_id: row.source_id,
      fact_id: String(row.id), provenance: row.source, context: row.context,
      ...(row.attributed_to ? { attributed_to: row.attributed_to } : {}) })), row => row.fact_id);
    return redactRetrievalOutput([{ facts: stamped }], {}, { uncapped: true }).results[0].facts;
  };
  const first = await scan();
  const second = await scan();
  const stable = (rows: typeof first) => JSON.stringify(rows, (key, value) => key === 'effective_confidence' ? undefined : value);
  if (stable(first) !== stable(second)) {
    throw usageError('Facts changed during complete recall; no complete snapshot certified.', 'Retry the complete read.');
  }
  process.stdout.write(JSON.stringify({ facts: second, total: second.length, complete: true,
    source_id: sourceId, entity_slug: flags.entity, enumeration: 'local-exact-entity/v1' }) + '\n');
}

export async function runRecall(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(RECALL_HELP); return; }
  const flags = parseFlags(args);
  if (flags.all) {
    await runRecallAll(engine, flags);
    return;
  }
  if (isOneShotRecall(flags)) {
    try {
      await renderRecallVerbResult(flags, await oneShotRecallResult(engine, flags));
    } catch (error) {
      await reportOneShotRecallError(error, flags);
    }
    return;
  }

  validateAndNormalizeFlags(flags);
  const cfg = loadConfig();
  const thinClient = isThinClient(cfg);

  if (flags.watchSeconds !== null && thinClient && flags.watchSeconds < WATCH_THIN_CLIENT_WARN_THRESHOLD) {
    process.stderr.write(
      `[recall] --watch ${flags.watchSeconds}s on a thin-client install: each tick is a remote MCP call. ` +
      `Consider 60s+ for cron / long sessions.\n`,
    );
  }

  const sourceId = await resolveSourceForRecall(engine, flags.source, thinClient, flags.sourceExplicit);

  // MEMORY_VERBS v1 [c4]: the verb params route through the recall OP so the
  // CLI and MCP exercise the same arm (query/budget packing/superset envelope).
  if (flags.query !== null || flags.budgetTokens !== null || flags.question !== null) {
    await renderRecallVerbResult(flags, await recallVerbResult(engine, flags, sourceId));
    return;
  }

  if (flags.watchSeconds !== null) {
    await runWatchLoop(engine, flags, sourceId, thinClient, flags.watchSeconds);
    return;
  }
  await runRecallOnce(engine, flags, sourceId, thinClient, 'briefing');
}

/** The caller's GBRAIN_SOURCE and cwd for source resolution; the warm CLI socket passes the CLI's, never the serve's. */
export interface RecallRouting { cwd: string; env: string | undefined }

function callerRouting(): RecallRouting {
  return { cwd: process.cwd(), env: process.env.GBRAIN_SOURCE };
}

/** MEMORY_VERBS v1 one-shot recall (`--budget-policy` or `--question`). */
export function isOneShotRecall(flags: ParsedFlags): boolean {
  return flags.budgetPolicy !== null || flags.question !== null;
}

/** The recall forms that run the recall op (and only it) before rendering: one-shot, `--query`, `--budget-tokens`. */
export function isRecallVerbForm(flags: ParsedFlags): boolean {
  return isOneShotRecall(flags) || flags.query !== null || flags.budgetTokens !== null;
}

/** One-shot recall: validates the combination, resolves the source and runs the recall op. */
export async function oneShotRecallResult(engine: BrainEngine, flags: ParsedFlags, routing: RecallRouting = callerRouting()): Promise<RecallVerbResult> {
  const { operationsByName, verbError } = await import('../core/operations.ts');
  const { validateParams } = await import('../mcp/validate-params.ts');
  const option = flags.budgetPolicy !== null ? '--budget-policy' : '--question';
  const error = (flags.budgetPolicy !== null ? validateParams(operationsByName.recall, { budget_policy: flags.budgetPolicy }) : null)
    ?? (flags.watchSeconds !== null || flags.sinceLastRun || flags.rollup || flags.asContext
      ? `${option} cannot be combined with --watch, --since-last-run, --rollup, or --as-context.` : null);
  if (error) throw verbError('invalid_params', error, flags.budgetPolicy !== null
    ? 'Use --budget-policy facts_first or query_first on a one-shot recall, or omit the policy for CLI-only behavior.'
    : 'Use --question on a one-shot recall, or drop it for the watch, cursor, rollup and context renders.');
  const selector = flags.sourceExplicit ? flags.source : routing.env || undefined;
  if (selector !== undefined && !SOURCE_ID_RE.test(selector)) {
    throw verbError('invalid_params', 'recall requires a concrete source id matching [a-z0-9-]{1,32}.',
      'Choose a registered source id, or omit the source selector to use your existing scope.', 'source_id');
  }
  const thinClient = isThinClient(loadConfig());
  const sourceId = resolveSourceIdEngineFree(flags.sourceExplicit ? flags.source : null, routing.cwd, { env: routing.env })
    ?? (thinClient ? undefined : await resolveSourceId(engine, null, routing.cwd, { env: routing.env }));
  return recallVerbResult(engine, flags, sourceId);
}

/** How a one-shot recall failure is reported (exit code and envelope); rethrows what it does not own. */
export async function reportOneShotRecallError(error: unknown, flags: ParsedFlags): Promise<void> {
  const { MEMORY_VERBS_VERSION, verbError } = await import('../core/operations.ts');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  if (error instanceof RemoteMcpError) {
    const { setCliExitVerdict, writeStdoutFinal } = await import('../core/cli-force-exit.ts');
    const detail = { protocol_version: MEMORY_VERBS_VERSION, ...error.toJSON() };
    if (flags.json) await writeStdoutFinal(JSON.stringify(detail, null, 2) + '\n');
    console.error(`Error [${detail.error}]: ${detail.message}`);
    if (detail.suggestion) console.error(`Fix: ${detail.suggestion}`);
    setCliExitVerdict(1);
    return;
  }
  if (error instanceof SourceTargetError) {
    error = verbError('not_found', error.message,
      'Choose an active source with the source selector, or repair your local source configuration.', 'unknown_source');
  }
  if (!await reportPersistenceCliError(error, flags.json)) throw error;
}

/**
 * The recall op result for a verb form, without printing: the source a
 * non-one-shot form resolves (with its stderr fallback notice) and the op.
 * The warm CLI socket's serve-side half; the CLI renders what it returns.
 */
export async function recallVerbForCaller(engine: BrainEngine, args: string[], routing: RecallRouting): Promise<RecallVerbResult | null> {
  const flags = parseFlags(args);
  if (!isRecallVerbForm(flags)) return null;
  if (isOneShotRecall(flags)) return oneShotRecallResult(engine, flags, routing);
  return recallVerbResult(engine, flags, await resolveSourceForRecall(engine, flags.source, false, flags.sourceExplicit, routing));
}

export type RecallVerbResult = {
  facts: Array<{ fact_id: string; fact: string; kind: string; entity_slug: string | null; provenance: string; relevance?: number }>;
  facts_order?: 'relevance' | 'newest';
  facts_degraded?: { reason?: string; unembedded?: number };
  results?: Array<{ slug: string; title: string | null; evidence: string; chunk: string | null }>;
  search_degraded?: string;
  budget_tokens?: number;
  budget_used?: number;
  dropped_count?: number;
};

/**
 * MEMORY_VERBS v1 — `gbrain recall --query ... [--budget-tokens N]` routes
 * through the recall OP (same code path MCP exercises); renderRecallVerbResult
 * prints facts + search results with the budget footer. `--json` prints the
 * raw envelope.
 */
async function recallVerbResult(engine: BrainEngine, flags: ParsedFlags, sourceId?: string): Promise<RecallVerbResult> {
  const { operationsByName } = await import('../core/operations.ts');
  const op = operationsByName['recall'];
  const ctx = {
    engine,
    config: loadConfig() || { engine: 'pglite' as const },
    logger: {
      info: (m: string) => process.stderr.write(`[info] ${m}\n`),
      warn: (m: string) => process.stderr.write(`[warn] ${m}\n`),
      error: (m: string) => process.stderr.write(`[error] ${m}\n`),
    },
    dryRun: false,
    remote: false as const,
    sourceId: sourceId ?? 'default',
  };
  const oneShot = flags.budgetPolicy !== null || flags.question !== null;
  const params = {
    ...(flags.entity ? { entity: flags.entity } : {}),
    ...(flags.question !== null ? { question: flags.question } : {}),
    ...(flags.query ? { query: flags.query } : {}),
    ...(flags.budgetTokens ? { budget_tokens: flags.budgetTokens } : {}),
    ...(flags.since ? { since: flags.since.toISOString() } : {}),
    ...(flags.grep ? { grep: flags.grep } : {}),
    include_expired: flags.includeExpired,
    limit: flags.limit,
    ...(oneShot ? {
      ...(flags.budgetPolicy !== null ? { budget_policy: flags.budgetPolicy } : {}),
      ...(sourceId !== undefined ? { source_id: sourceId } : {}),
      ...(flags.sessionId ? { session_id: flags.sessionId } : {}),
      ...(flags.supersessions ? { supersessions: true } : {}),
      ...(flags.pending ? { include_pending: true } : {}),
    } : {}),
  };
  if (!oneShot || !isThinClient(ctx.config)) return await op.handler(ctx, params) as RecallVerbResult;
  const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
  return unpackToolResult(await callRemoteTool(ctx.config, 'recall', params, { timeoutMs: 30_000 })) as RecallVerbResult;
}

export async function renderRecallVerbResult(flags: ParsedFlags, result: RecallVerbResult): Promise<void> {
  // An older server ignores `question` (warn-mode params) and answers without facts_order.
  const unranked = flags.question !== null && result.facts_order !== 'relevance'
    ? 'note: this brain did not rank facts by the question (its server predates question ranking); facts are newest first.' : null;
  const matched = result.facts.length + (result.results?.length ?? 0);
  await markRecallMiss(flags, matched);
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (unranked) process.stderr.write(unranked + '\n');
    return;
  }
  const lines: string[] = [];
  if (result.facts.length) {
    lines.push(result.facts_order === 'relevance' ? 'Facts (ranked by relevance to the question):' : 'Facts:');
    for (const f of result.facts) {
      lines.push(`  #${f.fact_id} [${f.kind}]${f.entity_slug ? ` (${f.entity_slug})` : ''} ${f.fact} — ${f.provenance}${typeof f.relevance === 'number' ? ` (relevance ${f.relevance.toFixed(2)})` : ''}`);
    }
  }
  if (result.results?.length) {
    lines.push('Pages:');
    for (const r of result.results) {
      lines.push(`  ${r.slug} [${r.evidence}] ${r.title ?? ''}`);
      if (r.chunk) lines.push(`    ${r.chunk.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  if (!lines.length) lines.push(result.facts_order === 'relevance' ? 'No saved fact matched the question.' : 'Nothing recalled.');
  if (unranked) lines.push(unranked);
  if (result.facts_degraded) {
    const d = result.facts_degraded;
    lines.push(`note: fact ranking degraded (${[d.reason, d.unembedded ? `${d.unembedded} fact(s) without a comparable embedding` : null].filter(Boolean).join('; ')})`);
  }
  if (result.search_degraded) lines.push(`note: search degraded (${result.search_degraded})`);
  if (result.budget_tokens !== undefined) {
    lines.push(`budget: ${result.budget_used}/${result.budget_tokens} tokens used, ${result.dropped_count} dropped`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * #4720 — shared by the local (fetchRowsLocal) and thin-client entity→text
 * fallbacks: a bare positional that matched no facts by entity is retried as
 * a fact-text grep. One gating predicate + one stderr note so the two paths
 * can't drift. Explicit --grep callers keep exact semantics (their filter
 * already ran); --supersessions/--session-id keep their own arms.
 */
function entityTextFallbackApplies(flags: ParsedFlags, matched: number): boolean {
  return matched === 0 && !!flags.entity && !flags.entityExplicit && !flags.grep && !flags.supersessions && !flags.sessionId;
}

function noteEntityTextFallback(entity: string, matched: number): void {
  process.stderr.write(
    `[recall] no facts for entity '${entity}'; matched ${matched} fact(s) by text — use --grep to force text matching.\n`,
  );
}

/**
 * Cat 41 run 4: agents ask `gbrain recall "how do I take my coffee?"`. The
 * positional is an entity, then a literal fact-text substring (#4720), so a
 * question matches neither and recall answered "No matching facts." while
 * `--question` ranked the fact first. On a brain without embeddings (opted
 * out or no provider), where question ranking is keyword-only anyway, a
 * multi-word positional that matched nothing is ranked as a question, with a
 * note. Brains with embeddings keep their output and get a hint instead.
 */
async function keylessQuestionFallback(engine: BrainEngine, flags: ParsedFlags, sourceId: string): Promise<boolean> {
  const question = flags.entity?.trim() ?? '';
  if (!/\s/.test(question) || !entityTextFallbackApplies(flags, 0) || flags.since || flags.sinceLastRun || flags.today || flags.asContext || flags.rollup) return false;
  const { factRecallIsKeywordOnly } = await import('../core/facts/keyword-only.ts');
  if (!await factRecallIsKeywordOnly(engine, loadConfig())) {
    process.stderr.write(`[recall] no entity or fact text matched '${question}'. To rank facts against it as a question: gbrain recall --question ${JSON.stringify(question)}\n`);
    return false;
  }
  process.stderr.write(`[recall] no entity or fact text matched '${question}'; ranked facts by relevance to it as a question (keyword-only: this brain has no embeddings).\n`);
  const questionFlags = { ...flags, entity: null, question };
  await renderRecallVerbResult(questionFlags, await recallVerbResult(engine, questionFlags, sourceId));
  return true;
}

/**
 * #4828: agents ask `gbrain recall "<name> <topic>"`. The bare positional is
 * resolved as one entity (the whole phrase names none), then grepped as one
 * literal string (the topic words are a paraphrase), so recall answered "No
 * matching facts." while the person's facts were there. When a multi-word
 * positional matched nothing, try the leading (then trailing) one to three
 * words as the entity, with recall's own resolver (an exact page, alias,
 * basename, or a bare name only one page expands to), and show that entity's facts with those mentioning the other words
 * first. No model or embedding call; an explicit --entity is never split.
 */
const SPLIT_MAX_NAME_WORDS = 3;

function entitySplitApplies(flags: ParsedFlags): boolean {
  return !!flags.entity && !flags.entityExplicit && /\s/.test(flags.entity.trim()) && !flags.grep && !flags.supersessions && !flags.sessionId;
}

/** Name spans to try, longest first: leading words, then trailing words. */
export function entitySplitSpans(positional: string): Array<{ name: string; topic: string }> {
  const words = positional.trim().split(/\s+/);
  const out: Array<{ name: string; topic: string }> = [];
  for (let k = Math.min(SPLIT_MAX_NAME_WORDS, words.length - 1); k >= 1; k--) {
    out.push({ name: words.slice(0, k).join(' '), topic: words.slice(k).join(' ') });
    out.push({ name: words.slice(words.length - k).join(' '), topic: words.slice(0, words.length - k).join(' ') });
  }
  return out;
}

const topicStems = (topic: string) => [...new Set(topic.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3).map(w => w.slice(0, 4)))];

/** Facts that share more topic word stems first; otherwise the input (recency) order. */
export function rankByTopic(rows: FactRow[], topic: string): FactRow[] {
  const stems = topicStems(topic);
  if (!stems.length) return rows;
  const score = (f: FactRow) => {
    const words = f.fact.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return stems.filter(s => words.some(w => w.startsWith(s))).length;
  };
  return rows.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
}

function noteEntitySplit(positional: string, name: string, slug: string, topic: string, n: number): void {
  process.stderr.write(
    `[recall] no facts matched '${positional}' as one entity or text; '${name}' is ${slug}: showing its ${n} fact(s), those mentioning '${topic}' first. ` +
    `Same as: gbrain recall --entity ${slug} (add --question ${JSON.stringify(topic)} to rank them by meaning).\n`,
  );
}

async function entitySplitLocal(engine: BrainEngine, flags: ParsedFlags, sourceId: string, resolvedSince: Date | null): Promise<FactRow[]> {
  if (!entitySplitApplies(flags)) return [];
  const spans = entitySplitSpans(flags.entity!);
  if (!await splitMayMatch(engine, sourceId, spans.map(s => s.name))) return [];
  const { resolveEntitySlugWithSource } = await import('../core/entities/resolve.ts');
  for (const span of spans) {
    const resolved = await resolveEntitySlugWithSource(engine, sourceId, span.name);
    if (!resolved || resolved.source === 'fallback_slugify') continue;
    const rows = await fetchRowsLocal(engine, { ...flags, entity: resolved.slug, entityExplicit: true }, sourceId, resolvedSince);
    if (!rows.length) continue;
    noteEntitySplit(flags.entity!, span.name, resolved.slug, span.topic, rows.length);
    return rankByTopic(rows, span.topic);
  }
  return [];
}

/**
 * One statement before the per-span resolution (four statements a span): a
 * span can only show facts when some fact is keyed under a slug whose last
 * segment starts with its name, or the name is a page alias. A miss, the
 * common case for a topic phrase, then costs one round trip instead of up to
 * twenty-four (test/e2e/retrieval-round-trip-budget.test.ts).
 */
async function splitMayMatch(engine: BrainEngine, sourceId: string, names: string[]): Promise<boolean> {
  const { slugify } = await import('../core/entities/resolve.ts');
  const { normalizeAlias } = await import('../core/search/alias-normalize.ts');
  const tokens = [...new Set(names.map(n => slugify(n)).filter(Boolean))];
  if (!tokens.length) return false;
  try {
    const rows = await engine.executeRaw(
      `SELECT 1 FROM facts WHERE source_id = $1 AND entity_slug ~ ANY($2::text[])
       UNION ALL SELECT 1 FROM page_aliases WHERE source_id = $1 AND alias_norm = ANY($3::text[])
       LIMIT 1`,
      [sourceId, tokens.map(t => `(^|/)${t}(-|$)`), [...new Set(names.map(n => normalizeAlias(n)).filter(Boolean))]]);
    return rows.length > 0;
  } catch {
    return true;
  }
}

async function runRecallOnce(
  engine: BrainEngine,
  flags: ParsedFlags,
  sourceId: string,
  thinClient: boolean,
  cursorVariant: 'briefing' | 'watch',
  cursorOverride?: RecallCursor | null,
): Promise<RecallCursor> {
  // Codex round 1 #2: T_start is captured BEFORE the first read SQL fires.
  // Facts inserted during render/write get included by the next run.
  const tStart = new Date();

  const cursor: RecallCursor | null = flags.sinceLastRun
    ? (cursorOverride !== undefined ? cursorOverride : readRecallCursor(sourceId, cursorVariant)) ?? wallClockCursor(defaultCursorStart())
    : null;
  const resolvedSince: Date | null = cursor ? cursor.since : flags.since;
  // #6945: only the local cursor read can page (oldest first, by keyset);
  // thin-client and --supersessions keep the newest-N window.
  const pageable = cursor !== null && !thinClient && !flags.supersessions;

  let rows: FactRow[];
  let pendingCount: number | undefined;

  if (thinClient) {
    const cfg = loadConfig();
    const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
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
    // #5535: send source_id whenever the selector was explicit — including
    // an explicit 'default'. Omitting it let the remote server apply ITS
    // own default (sources.default / GBRAIN_SOURCE server-side), so an
    // explicit `--source default` silently queried a different source.
    if (sourceId !== 'default' || flags.sourceExplicit) params.source_id = sourceId;

    const raw = await callRemoteTool(cfg!, 'recall', params, { timeoutMs: 30_000 });
    const unpacked = unpackToolResult<{
      facts: Array<Record<string, unknown>>;
      total: number;
      pending_consolidation_count?: number;
    }>(raw);
    rows = unpacked.facts.map(remoteFactToRow);
    pendingCount = unpacked.pending_consolidation_count;

    // #4720: thin-client mirror of the local entity→text fallback (see
    // fetchRowsLocal). A bare positional that matched no facts by entity is
    // retried as a fact-text grep so a literal word from fact text still
    // recalls over the wire.
    if (entityTextFallbackApplies(flags, rows.length)) {
      const fbParams: Record<string, unknown> = { ...params, grep: flags.entity!.toLowerCase() };
      delete fbParams.entity;
      const fbRaw = await callRemoteTool(cfg!, 'recall', fbParams, { timeoutMs: 30_000 });
      const fb = unpackToolResult<{
        facts: Array<Record<string, unknown>>;
        total: number;
        pending_consolidation_count?: number;
      }>(fbRaw);
      if (fb.facts.length > 0) {
        noteEntityTextFallback(flags.entity!, fb.facts.length);
        rows = fb.facts.map(remoteFactToRow);
        pendingCount = fb.pending_consolidation_count ?? pendingCount;
      }
    }
  } else {
    rows = pageable
      ? await fetchCursorPage(engine, flags, sourceId, cursor!)
      : await fetchRowsLocal(engine, flags, sourceId, resolvedSince);
    if (rows.length === 0 && !pageable) rows = await entitySplitLocal(engine, flags, sourceId, resolvedSince);
    if (rows.length === 0 && cursorVariant === 'briefing' && await keylessQuestionFallback(engine, flags, sourceId)) return wallClockCursor(tStart);
    if (flags.pending) {
      pendingCount = await engine.countUnconsolidatedFacts(sourceId);
    }
  }

  // `--grep` narrows in SQL before LIMIT on every engine path (op params,
  // thin-client params, and fetchRowsLocal's list calls). listSupersessions
  // takes no grep option, so the client-side filter remains only there.
  if (flags.grep && flags.supersessions) {
    const g = flags.grep;
    rows = rows.filter(r => r.fact.toLowerCase().includes(g));
  }

  const rollup = flags.rollup ? computeRollup(rows) : null;

  if (flags.json) {
    const payload: Record<string, unknown> = {
      facts: rows.map(factRowToJson),
      total: rows.length,
      ...(recallMissed(flags, rows.length) ? { status: 'no_results' } : {}),
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

  await markRecallMiss(flags, rows.length);
  return cursor ? advanceCursor(sourceId, cursorVariant, rows, flags.limit, pageable, thinClient, tStart) : wallClockCursor(tStart);
}

/**
 * #7177: a recall that looked something up (an entity or text, --grep,
 * --question, --query) and matched nothing is a miss: the list render's
 * --json adds `status: "no_results"` (the verb path prints the operation's
 * envelope verbatim, where `total: 0` says it), and GBRAIN_FAIL_ON_EMPTY=1
 * exits NO_RESULTS_EXIT_CODE.
 * A feed read (--watch, --since-last-run, no filter) with nothing new is not.
 */
function recallMissed(flags: ParsedFlags, matched: number): boolean {
  const lookup = !!flags.entity || !!flags.grep || flags.question !== null || !!flags.query;
  return matched === 0 && lookup && flags.watchSeconds === null && !flags.sinceLastRun;
}

async function markRecallMiss(flags: ParsedFlags, matched: number): Promise<void> {
  if (recallMissed(flags, matched)) (await import('../cli/no-results.ts')).markNoResults('recall');
}

function wallClockCursor(since: Date): RecallCursor {
  return { since, resumeAfter: null };
}

function defaultCursorStart(): Date {
  return new Date(Date.now() - DEFAULT_FALLBACK_HOURS * 60 * 60 * 1000);
}

/**
 * Move the --since-last-run cursor past what this run showed. A run that
 * filled its --limit window may have older unseen facts behind it: a pageable
 * run resumes strictly after the newest fact it delivered (moving to tStart
 * would skip the rest for good); any other full run warns. A run with room to
 * spare is caught up and records tStart.
 */
function advanceCursor(
  sourceId: string,
  variant: 'briefing' | 'watch',
  rows: FactRow[],
  limit: number,
  pageable: boolean,
  thinClient: boolean,
  tStart: Date,
): RecallCursor {
  const windowFull = rows.length >= clampSearchLimit(limit, 50);
  if (windowFull && pageable) {
    const newest = rows[0];
    const resumeAfter = { createdAt: newest.created_at_iso ?? newest.created_at.toISOString(), id: newest.id };
    writePagedCursor(sourceId, variant, resumeAfter);
    return { since: new Date(Date.parse(resumeAfter.createdAt)), resumeAfter };
  }
  if (windowFull) {
    process.stderr.write(
      `[recall] ${rows.length} facts filled the --limit window; older facts since the last run may not be shown` +
      `${thinClient ? ' (thin-client recall cannot page the cursor)' : ''}. Re-run with a larger --limit.\n`,
    );
  }
  writeCursor(sourceId, tStart, variant);
  return wallClockCursor(tStart);
}

/**
 * One --since-last-run page from the local engine: the oldest `limit` facts
 * after the cursor (inclusive of `since` when there is no keyset; id 0 sorts
 * before every fact), rendered newest-first. Entity with its text fallback,
 * session, --grep and audit rows narrow in SQL before LIMIT, as in
 * fetchRowsLocal's cursor arms.
 */
async function fetchCursorPage(engine: BrainEngine, flags: ParsedFlags, sourceId: string, cursor: RecallCursor): Promise<FactRow[]> {
  const after = cursor.resumeAfter ?? { createdAt: cursor.since.toISOString(), id: 0 };
  const page = (narrow: { entitySlug?: string; grep?: string }) => engine.listFactsKeyset(sourceId, after, {
    activeOnly: !flags.includeExpired,
    limit: flags.limit,
    excludeAuditRows: true,
    grep: flags.grep ?? undefined,
    sessionId: flags.sessionId || undefined,
    ...narrow,
  });
  if (!flags.entity) return (await page({})).reverse();
  const slugs = await entityFactSlugs(engine, sourceId, (await resolveEntitySlug(engine, sourceId, flags.entity)) ?? flags.entity);
  const keyOf = (r: FactRow) => [r.created_at_iso ?? new Date(r.created_at).toISOString(), r.id] as const;
  const entityRows = (await Promise.all(slugs.map(entitySlug => page({ entitySlug })))).flat()
    .sort((a, b) => { const [ka, ia] = keyOf(a), [kb, ib] = keyOf(b); return ka < kb ? -1 : ka > kb ? 1 : ia - ib; })
    .slice(0, flags.limit);
  if (!entityTextFallbackApplies(flags, entityRows.length)) return entityRows.reverse();
  const textRows = await page({ grep: flags.entity.toLowerCase() });
  if (textRows.length === 0) return entityRows.reverse();
  noteEntityTextFallback(flags.entity, textRows.length);
  return textRows.reverse();
}

/** #4828: every entity_slug this entity's facts may be saved under (siblings, title subject, bare basename). */
async function entityFactSlugs(engine: BrainEngine, sourceId: string, slug: string): Promise<string[]> {
  const { factEntitySlugs } = await import('../core/mentions/siblings.ts');
  return factEntitySlugs(engine, sourceId, slug, { excludePrivate: false }).catch(() => [slug]);
}

function mergeNewestFirst(lists: FactRow[][], limit: number, keyOf: (r: FactRow) => Date | string | null | undefined): FactRow[] {
  if (lists.length === 1) return lists[0]!;
  const time = (r: FactRow) => { const v = keyOf(r); return (v instanceof Date ? v.getTime() : v ? Date.parse(String(v)) : 0) || 0; };
  return lists.flat().sort((a, b) => time(b) - time(a)).slice(0, limit);
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
  // An explicit `--since DURATION` / `--today` cutoff is a "what happened in
  // this window" question and keeps event-time ordering; `--since-last-run`
  // resolves from a creation-time cursor (see the since-only arm below).
  const windowEventTime = !flags.sinceLastRun;
  if (flags.entity) {
    const slug = (await resolveEntitySlug(engine, sourceId, flags.entity)) ?? flags.entity;
    // With a window, entity ANDs onto since in one query (before LIMIT);
    // without one, the entity arm keeps its valid_from ordering. #4828: read
    // every slug the entity's facts may be saved under, as the recall op does.
    const slugs = await entityFactSlugs(engine, sourceId, slug);
    const lists = await Promise.all(slugs.map(entitySlug => resolvedSince
      ? engine.listFactsSince(sourceId, resolvedSince, {
          eventTime: windowEventTime,
          entitySlug,
          sessionId: flags.sessionId || undefined,
          activeOnly: !flags.includeExpired,
          limit: flags.limit,
          grep: flags.grep ?? undefined,
          excludeAuditRows: true,
        })
      : engine.listFactsByEntity(sourceId, entitySlug, {
          sessionId: flags.sessionId || undefined,
          activeOnly: !flags.includeExpired,
          limit: flags.limit,
          grep: flags.grep ?? undefined,
          excludeAuditRows: true,
        })));
    const rows = mergeNewestFirst(lists, flags.limit, resolvedSince && !windowEventTime ? r => r.created_at : r => r.valid_from ?? r.created_at);
    // #4720: the bare positional is entity-first, but keyless/casual usage
    // treats it as a literal word from fact text (`gbrain recall commas`).
    // resolveEntitySlug never returns null for non-empty input (slugify is
    // the floor), so an unknown term becomes a phantom slug that matches
    // nothing and recall reports zero results while `recall --all` and
    // `--grep` both find the fact. When the entity arm comes up empty, fall
    // back to the SQL-level fact-text grep (the same pre-limit arm --grep
    // uses) with a stderr note. Explicit --grep callers keep exact
    // semantics (their filter already ran; no fallback surprise). Gating +
    // note are shared with the thin-client mirror in runRecallOnce.
    if (entityTextFallbackApplies(flags, rows.length)) {
      const textRows = await engine.listFactsSince(sourceId, resolvedSince ?? new Date(0), {
        eventTime: resolvedSince ? windowEventTime : true,
        activeOnly: !flags.includeExpired,
        limit: flags.limit,
        grep: flags.entity.toLowerCase(),
        excludeAuditRows: true,
      });
      if (textRows.length > 0) {
        noteEntityTextFallback(flags.entity, textRows.length);
        return textRows;
      }
    }
    return rows;
  }
  if (flags.sessionId) {
    if (resolvedSince) {
      return engine.listFactsSince(sourceId, resolvedSince, {
        eventTime: windowEventTime,
        sessionId: flags.sessionId,
        activeOnly: !flags.includeExpired,
        limit: flags.limit,
        grep: flags.grep ?? undefined,
        excludeAuditRows: true,
      });
    }
    return engine.listFactsBySession(sourceId, flags.sessionId, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
      grep: flags.grep ?? undefined,
      excludeAuditRows: true,
    });
  }
  if (resolvedSince) {
    // Post-review fix: `--since-last-run`/`--watch` resolve `resolvedSince`
    // from a cursor written as the PRIOR RUN's wall-clock start time
    // (`writeCursor(sourceId, tStart, ...)` in runRecallOnce — creation-time
    // semantics). Comparing that cursor against event time
    // (COALESCE(valid_from, created_at)) drops rows created after the cursor
    // but backdated to an earlier valid_from — a delayed extraction of a
    // past conversation would never surface on the next tick. An explicit
    // `--since DURATION`/`--today` cutoff is a genuine "what happened in
    // this window" question and keeps event-time ordering.
    return engine.listFactsSince(sourceId, resolvedSince, {
      eventTime: !flags.sinceLastRun,
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
      grep: flags.grep ?? undefined,
      excludeAuditRows: true,
    });
  }
  return engine.listFactsSince(sourceId, new Date(0), {
    eventTime: true,
    activeOnly: !flags.includeExpired,
    limit: flags.limit,
    grep: flags.grep ?? undefined,
    excludeAuditRows: true,
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
    let priorTickStart: RecallCursor = readRecallCursor(sourceId, 'watch') ?? wallClockCursor(defaultCursorStart());

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

export async function runForget(engine: BrainEngine | (() => Promise<BrainEngine>), args: string[]): Promise<void> {
  const purge = await import('./forget-purge.ts');
  if (purge.routesToForgetPurge(args)) return purge.runForgetPurge(engine, args);
  const idArg = args.find(a => /^\d+$/.test(a));
  if (!idArg) {
    process.stderr.write('Usage: gbrain forget <fact-id> [--reason <text>] [--source <id>] [--request-id <uuid>] [--json]\n');
    process.exit(1);
  }
  const id = parseInt(idArg, 10);

  // Optional --reason <text> passes through to the fence's "forgotten:
  // <reason>" context cell so the markdown carries the rationale.
  let reason: string | undefined = undefined;
  const idx = args.indexOf('--reason');
  if (idx >= 0 && idx + 1 < args.length) reason = args[idx + 1];
  const requestIndex = args.findIndex(arg => arg === '--request-id' || arg.startsWith('--request-id='));
  const sourceIndex = args.findIndex(arg => arg === '--source' || arg.startsWith('--source='));
  const requestValue = requestIndex < 0 ? undefined : args[requestIndex].startsWith('--request-id=')
    ? args[requestIndex].slice('--request-id='.length) : args[requestIndex + 1];
  const sourceValue = sourceIndex < 0 ? undefined : args[sourceIndex].startsWith('--source=')
    ? args[sourceIndex].slice('--source='.length) : args[sourceIndex + 1];
  const { parseWriteRequestId } = await import('../core/persistence/preconditions.ts');
  const { randomUUID } = await import('node:crypto');
  const { opError, operations } = await import('../core/operations.ts');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  const json = args.includes('--json');
  let requestId: string;
  try {
    if (requestIndex >= 0 && (!requestValue || requestValue.startsWith('--'))) {
      throw opError('invalid_params', '--request-id requires a UUID.',
        `Give --request-id the UUID an earlier attempt of this forget printed, or omit it and gbrain forget ${id} generates one.`);
    }
    if (sourceIndex >= 0 && (!sourceValue || sourceValue.startsWith('--'))) {
      throw opError('invalid_params', '--source requires a source ID.', `Give --source the id of the source that holds fact ${id}, e.g. --source default, or omit it to use the default source.`,
        { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists the source ids, read-only.', requires_exclusive: false } });
    }
    requestId = parseWriteRequestId(requestValue) ?? randomUUID();
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return;
    throw error;
  }
  const params: Record<string, unknown> = { id: String(id), request_id: requestId, ...(reason !== undefined ? { reason } : {}) };

  // v0.33: thin-client routing. Without this, `gbrain forget <id>` on a
  // thin-client install would call the local fence helper against the empty
  // local PGLite and report "No fact" while the real fact lives on the
  // remote brain.
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
    try {
      if (sourceValue) throw opError('invalid_params', '--source cannot override the remote memory writer grant.',
        'Drop --source: on a remote brain the connection\'s memory writer grant decides the source.',
        { fix: { argv: ['gbrain', 'forget', String(id), ...(reason !== undefined ? ['--reason', reason] : []), '--request-id', requestId], consent: [], actor: 'agent',
          requires_exclusive: false, why: `The same forget of fact ${id} without --source, under the same request id.` } });
      const raw = await callRemoteTool(cfg!, 'forget', params, { timeoutMs: 30_000 });
      const result = unpackToolResult<{ id: string; expired: boolean }>(raw);
      if (json) console.log(JSON.stringify(result, null, 2));
      else process.stdout.write(result.expired ? `Forgot fact id=${id}\n` : `Fact id=${id} was already withdrawn\n`);
    } catch (error) {
      if (await reportPersistenceCliError(error, json)) return;
      console.error(error instanceof Error ? error.message : String(error));
      console.error(`Retry the same forget with --request-id ${requestId}.`);
      const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
      setCliExitVerdict(1);
    }
    return;
  }

  try {
    const { maybeDelegateLocalOperation } = await import('../core/persistence/local-client.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    const cli = getCliOptions();
    const source = sourceValue ?? null;
    const delegated = await maybeDelegateLocalOperation('forget', params, cfg, {
      brain: cli.brain, source, timeoutMs: cli.timeoutMs ?? undefined,
    });
    let result: { id: string; expired: boolean; similar_active?: { candidates?: Array<{ fact_id: string; similarity: number }>; next?: string } };
    if (delegated.handled) result = delegated.result as typeof result;
    else {
      const connected = typeof engine === 'function' ? await engine() : engine;
      const sourceId = await resolveSourceId(connected, source);
      const op = operations.find(operation => operation.name === 'forget')!;
      result = await op.handler({ engine: connected, config: cfg ?? { engine: 'pglite' }, remote: false,
        dryRun: false, sourceId, logger: { info: console.log, warn: console.warn, error: console.error } }, params) as typeof result;
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      process.stdout.write(result.expired ? `Forgot fact id=${id}\n` : `Fact id=${id} was already withdrawn\n`);
      const similar = result.similar_active;
      if (similar?.candidates?.length) {
        process.stdout.write(`Close matches still active: ${similar.candidates.map(c => `#${c.fact_id} (${c.similarity})`).join(', ')}\n`);
      }
      if (similar?.next) {
        const { agentBlock } = await import('../core/agent-markers.ts');
        process.stderr.write(agentBlock({ next: similar.next }));
      }
    }
  } catch (error) {
    if (await reportPersistenceCliError(error, json)) return;
    throw error;
  }
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
