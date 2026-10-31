import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readRequestIndexStates, REQUEST_INDEXES_REPAIR_COMMAND } from '../../../core/persistence/checkpoint-validation.ts';
import { oneYearCapacity, readJournalLimits, journalLimitKey } from '../../../core/persistence/limits.ts';
import { claimStall, claimStateOf, MAX_CLAIM_CONFIG_KEY, readMaxClaimMs } from '../../../core/persistence/claim-phase.ts';
import { preparationBudgetMs } from '../../../core/persistence/preparation-budget.ts';
import { readPreparationPolicy } from '../../../core/persistence/switches.ts';
import { resolvePrepare, resolveSessionTimeouts } from '../../../core/db.ts';
import { agentFix, checkError, doctorVerify } from '../check-fix.ts';
import { lostCallerWrites } from '../../../core/repair/failed-writes.ts';
import { readCapacityThresholds } from '../../../core/persistence/capacity-forecast.ts';
import { doctorCapacityForecast, forecastOrNull } from '../capacity-memo.ts';
import { withStatementDeadline } from '../../../core/statement-deadline.ts';
import { DEFERRED_READ_LABEL, repeatedPostprocessDeferrals } from '../../../core/cycle/synthesize-postprocess-deferral.ts';
import { PERSISTENCE_REQUEST_ID_INDEX } from '../../../core/persistence/schema.ts';
import type { TerminalSourceSummary } from '../../../core/persistence/terminal-failures.ts';

const WINDOW_DAYS = 7;
const SAMPLE = 10_000;
const HORIZON_DAYS = 3650;

/**
 * #5762: managed sync checkpoint validation, the page purge's slug lookup and
 * dream synthesis postprocessing read the request table through indexes that
 * Postgres builds CONCURRENTLY. Reports each one missing, left INVALID by an
 * interrupted build, or still building (with progress), and the one command
 * that rebuilds it on a current schema. #6757: also names a source whose
 * synthesis postprocessing deferred three or more passes in a row on a
 * statement timeout, with the read, its elapsed time and the pending outputs;
 * the rebuild is named only when the request-id index is what is missing.
 */
export async function requestIndexesCheck(engine: BrainEngine): Promise<Check> {
  const docs = 'docs/guides/repair.md#request-indexes';
  try {
    const indexes = await readRequestIndexStates(engine);
    const broken = indexes.filter(index => index.state === 'missing' || index.state === 'invalid');
    const building = indexes.filter(index => index.state === 'building');
    const deferred = await repeatedPostprocessDeferrals(engine).catch(() => []);
    const postprocess = deferred.map(d => ({ source_id: d.source_id, consecutive_passes: d.consecutive, read: d.last_read ?? null,
      elapsed_ms: d.last_elapsed_ms ?? null, pending_outputs: d.pending.length, last_deferred_at: d.last_deferred_at ?? null }));
    const details = { count: broken.length, indexes, repair: 'request-indexes', command: REQUEST_INDEXES_REPAIR_COMMAND, docs,
      ...(postprocess.length ? { postprocess_deferred: postprocess } : {}) };
    const deferral = postprocess.length ? ` Dream synthesis postprocessing deferred on a statement timeout ${postprocess.map(d => `${d.consecutive_passes} passes in a row on source ${d.source_id} `
      + `(${d.read ? DEFERRED_READ_LABEL[d.read] : 'a request read'}, ${d.elapsed_ms ?? '?'} ms; ${d.pending_outputs} output(s) pending)`).join('; ')}.` : '';
    if (broken.length) return { name: 'persistence_request_indexes', status: 'warn', details,
      message: `${broken.map(index => `${index.name} is ${index.state === 'invalid' ? 'INVALID' : 'missing'}`).join('; ')}: request-table reads (managed sync checkpoints, write claims, page purges, `
        + `dream synthesis postprocessing) can time out on a large request table. Rebuild on the brain host: ${REQUEST_INDEXES_REPAIR_COMMAND}${deferral}` };
    if (building.length) return { name: 'persistence_request_indexes', status: 'warn', details,
      message: `Still building: ${building.map(index => `${index.name} (${index.progress?.phase ?? 'building'}${index.progress?.blocks_total
        ? `, ${index.progress.blocks_done}/${index.progress.blocks_total} blocks` : ''})`).join('; ')}. It is safe to leave running; rerun gbrain doctor to follow it.${deferral}` };
    if (postprocess.length) return { name: 'persistence_request_indexes', status: 'warn', details,
      message: `Request-table indexes are valid, including ${PERSISTENCE_REQUEST_ID_INDEX.name}, so the timeout is not a missing index.${deferral} `
        + 'The deferred outputs finish without another synthesis call on the first pass whose read completes; compare the elapsed time with the session statement_timeout '
        + '(doctor persistence_session_timeouts).' };
    return { name: 'persistence_request_indexes', status: 'ok', message: 'Request-table indexes are valid.', details };
  } catch (error) {
    return { name: 'persistence_request_indexes', status: 'warn',
      message: `Request indexes could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 0, health: 'unknown', docs } };
  }
}

/**
 * Request-table growth: rows in `persistence_requests`, the admission rate
 * over the last 7 days (sampled from the newest 10,000 admissions per scope,
 * one bounded index read each), lifetime request IDs against
 * `persistence.limits.*`, and the projected days until admission refuses.
 * Warns when a scope would exhaust its lifetime IDs within
 * `persistence.capacity.warn_days` (30), the threshold `persistence_capacity`
 * uses, with the same `gbrain config set` value it prints.
 */
export async function requestGrowthCheck(engine: BrainEngine): Promise<Check> {
  const docs = 'docs/guides/repair.md#request-growth';
  try {
    const [table] = engine.kind === 'postgres'
      ? await engine.executeRaw<{ rows: string }>("SELECT GREATEST(reltuples, 0)::bigint::text AS rows FROM pg_class WHERE oid = to_regclass('persistence_requests')")
      : await engine.executeRaw<{ rows: string }>('SELECT count(*)::text AS rows FROM persistence_requests');
    const counters = await engine.executeRaw<{ key: string; lifetime_ids: string }>(
      "SELECT key,lifetime_ids::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key");
    const limits = await readJournalLimits(engine);
    const { warnDays } = await readCapacityThresholds(engine);
    const now = Date.now();
    const scopes = [];
    for (const counter of counters) {
      const principal = /^principal:([^:]+):(.+)$/.exec(counter.key);
      const [sample] = await engine.executeRaw<{ admissions: number; oldest: string | null }>(`SELECT count(*)::int AS admissions, min(created_at)::text AS oldest
        FROM (SELECT created_at FROM persistence_requests ${principal ? 'WHERE principal_kind=$1 AND principal_id=$2' : ''}
          ORDER BY sequence DESC LIMIT ${SAMPLE}) recent
        WHERE created_at >= now() - interval '${WINDOW_DAYS} days'`, principal ? [principal[1], principal[2]] : []);
      const setting = principal ? 'principalLifetimeIds' : 'brainLifetimeIds';
      const used = Number(counter.lifetime_ids), limit = limits[setting];
      const windowDays = sample.admissions >= SAMPLE && sample.oldest
        ? Math.max(1 / 24, (now - Date.parse(sample.oldest)) / 86_400_000) : WINDOW_DAYS;
      const perDay = sample.admissions / windowDays;
      // Beyond ten years the projection is noise; report no date.
      const daysLeft = perDay > 0 && Math.max(0, limit - used) / perDay <= HORIZON_DAYS ? Math.max(0, limit - used) / perDay : null;
      scopes.push({ scope: counter.key, lifetime_ids: used, limit, config_key: journalLimitKey(setting),
        window_days: Number(windowDays.toFixed(2)), admissions_in_window: sample.admissions, per_day: Math.round(perDay),
        days_to_exhaustion: daysLeft === null ? null : Math.floor(daysLeft),
        exhaustion_date: daysLeft === null ? null : new Date(now + daysLeft * 86_400_000).toISOString().slice(0, 10) });
    }
    const soon = scopes.filter(scope => scope.days_to_exhaustion !== null && scope.days_to_exhaustion < warnDays);
    // Every principal shares one brain-wide key, so each key gets the largest value any scope needs.
    const needed = new Map<string, number>();
    const forecast = soon.length ? await doctorCapacityForecast(engine, { limits }).catch(forecastOrNull) : null;
    for (const scope of soon) {
      const predicted = forecast?.rows.find(row => row.scope === scope.scope && row.resource === 'lifetime_ids');
      const value = predicted && predicted.per_day_7d > 0 ? predicted.recommended_limit
        : await oneYearCapacity(engine, scope.scope, 'LifetimeIds', scope.lifetime_ids, scope.limit);
      needed.set(scope.config_key, Math.max(needed.get(scope.config_key) ?? 0, value));
    }
    const commands = [...needed].map(([key, value]) => `gbrain config set ${key} ${value}`);
    const details = { rows: Number(table?.rows ?? 0), rows_exact: engine.kind !== 'postgres', window_days: WINDOW_DAYS, scopes,
      commands, verify: 'gbrain doctor --json (check persistence_request_growth)', docs };
    const rows = `${details.rows_exact ? '' : '~'}${details.rows} request row(s)`;
    if (!soon.length) return { name: 'persistence_request_growth', status: 'ok', details,
      message: `${rows}; no scope exhausts its lifetime request IDs within ${warnDays} days at its last-${WINDOW_DAYS}-day rate.` };
    return { name: 'persistence_request_growth', status: 'warn', details,
      message: `${rows}. ${soon.map(scope => `${scope.scope} admits ${scope.per_day}/day over the last ${scope.window_days} day(s) and reaches `
        + `${scope.config_key}=${scope.limit} (${scope.lifetime_ids} used) around ${scope.exhaustion_date}`).join('; ')}; admission refuses then. `
        + `Run on the brain host: ${details.commands.join('; ')} — then verify with ${details.verify}.` };
  } catch (error) {
    return { name: 'persistence_request_growth', status: 'warn',
      message: `Request-table growth could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', docs } };
  }
}

/**
 * #6176: a write request that has held its claim longer than
 * `persistence.max_claim_ms` (default 10 minutes). The queue checks only see
 * Minion jobs, so a persistence request whose preparation or publication hangs
 * while its owner keeps renewing the claim was invisible: every later write on
 * its root waits behind it. Names the stuck phase (claim-phase.ts), the root,
 * the claim's age, how many writes wait behind it and whether the same request
 * resumes on its own, with the read-only writer status as the next step.
 * #6278: each stall also carries the claim's step, what it waits on, the owner
 * process and, for a preparation past its budget, `claim.stall`
 * (`preparation_overdue`); the budgets in effect are in the details.
 * A claim that is released and taken again every few seconds never ages past
 * `max_claim_ms`, so a running request is also a stall once it is that old and
 * no request on its root reached a terminal state within the same window.
 */
export async function writeStallCheck(engine: BrainEngine): Promise<Check> {
  const docs = 'docs/guides/troubleshooting.md#persistence-write-stall';
  try {
    const maxClaimMs = await readMaxClaimMs(engine);
    const policy = await readPreparationPolicy(engine);
    const rows = await engine.executeRaw<{ request_id: string; source_id: string; worktree_id: string | null; operation: string; intent_kind: string | null; state: string; claim_phase: unknown;
      execution_token: string | null; claim_lapsed: boolean | null; publication_started: boolean; request_age_ms: string; no_root_progress: boolean; waiting: number }>(
      `SELECT r.request_id::text,r.source_id,r.worktree_id::text,r.operation,r.intent->>'kind' AS intent_kind,r.state,r.claim_phase,r.execution_token::text,r.claim_expires_at<now() AS claim_lapsed,
        r.publication_started,(EXTRACT(EPOCH FROM (now()-r.created_at))*1000)::bigint::text AS request_age_ms,
        NOT EXISTS (SELECT 1 FROM persistence_requests q WHERE ((r.worktree_id IS NOT NULL AND q.worktree_id=r.worktree_id)
          OR (r.worktree_id IS NULL AND q.worktree_id IS NULL AND q.source_id=r.source_id))
          AND q.state IN ('committed','conflict','failed','cancelled') AND q.completed_at>=now()-($1::double precision*interval '1 millisecond')
          AND q.recovery IS NULL AND NOT q.compacted) AS no_root_progress,
        (SELECT count(*)::int FROM persistence_requests q WHERE q.worktree_id=r.worktree_id AND q.state='queued' AND q.sequence>r.sequence) AS waiting
      FROM persistence_requests r WHERE r.state='running' ORDER BY r.sequence LIMIT 100`, [maxClaimMs]);
    const now = Date.now();
    const stalls = rows.flatMap(row => {
      const claim = claimStateOf(row, now);
      if (!claim) return [];
      // An owner that predates phase recording never stamps its claims; the request's own age bounds the claim's.
      const held = claim.claim_age_ms ?? (row.claim_phase == null ? Math.max(0, Number(row.request_age_ms)) : null);
      const stalledWithoutProgress = row.no_root_progress && Number(row.request_age_ms) >= maxClaimMs;
      if (!(held !== null && held >= maxClaimMs) && !stalledWithoutProgress) return [];
      const claimAgeMs = held ?? claim.claim_age_ms ?? 0;
      const requestAgeMs = Math.max(0, Number(row.request_age_ms));
      const budget = preparationBudgetMs({ operation: row.operation, intent: row.intent_kind ? { kind: row.intent_kind } : null }, policy, 30_000);
      return [{ request_id: row.request_id, source_id: row.source_id, root: row.worktree_id, operation: row.operation, intent_kind: row.intent_kind, phase: claim.phase,
        claim_age_ms: claimAgeMs, request_age_ms: requestAgeMs, phase_age_ms: claim.phase_age_ms, step: claim.step, step_age_ms: claim.step_age_ms, waiting_on: claim.waiting_on, owner: claim.owner,
        budget_ms: budget, stall: claimStall(claim, budget), waiting_behind: row.waiting, resumes_on_its_own: claim.resumes_on_its_own,
        why: stalledWithoutProgress && !(held !== null && held >= maxClaimMs)
          ? `${claim.why} No request on this root reached a terminal state during the claim window, even though its claim was renewed.` : claim.why }];
    });
    const details = { max_claim_ms: maxClaimMs, config_key: MAX_CLAIM_CONFIG_KEY, count: stalls.length, stalls, docs,
      preparation_policy: { sync_preparation_ms: policy.syncMs, maintenance_preparation_ms: policy.maintenanceMs, preparation_ceiling_ms: policy.ceilingMs, max_preparation_attempts: policy.maxAttempts, max_transient_retries: policy.transientRetries } };
    if (!stalls.length) return { name: 'persistence_write_stall', status: 'ok', details,
      message: `No write request has held its claim longer than ${MAX_CLAIM_CONFIG_KEY} (${maxClaimMs} ms).` };
    const first = stalls[0]!;
    const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
    return { name: 'persistence_write_stall', status: 'warn', details,
      message: `${stalls.length} write request(s) have stalled beyond ${MAX_CLAIM_CONFIG_KEY} (${maxClaimMs} ms). `
        + stalls.slice(0, 3).map(stall => `Request ${stall.request_id} (${stall.operation}) on source ${stall.source_id}, root ${stall.root ?? 'database-only'}, `
          + `is stuck in phase ${stall.phase} after ${minutes(Math.max(stall.claim_age_ms, stall.request_age_ms))}; ${stall.waiting_behind} queued write(s) wait behind it. ${stall.why}`).join(' ')
        + ` Next: inspect it with gbrain sources writer status --source ${first.source_id} --json, then restart the gbrain serve that owns the root`
        + `${first.resumes_on_its_own ? ' if it is still stuck after its transaction ends' : ''}. The root trigger of a hang is not known yet; attach that status output when reporting it.`,
      fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--source', first.source_id, '--json'],
        'Read-only: shows the owner, the stuck request\'s claim phase and every write waiting behind it on that root.', 'persistence_write_stall', { docs }) };
  } catch (error) {
    return checkError('persistence_write_stall', 'inspect running write requests', error, { details: { health: 'unknown', docs } });
  }
}

/**
 * #6278 (plan item 1.4): whether the session timeouts gbrain configures as
 * connection startup parameters (`GBRAIN_STATEMENT_TIMEOUT`, default 5min)
 * actually reach the server through the configured URL. A transaction-mode
 * pooler (PgBouncer, Supavisor) drops or ignores startup parameters, so `SHOW
 * statement_timeout` through the pool reads `0`: statements outside a
 * transaction then have no server-side bound. Preparation reads carry their
 * own transaction-local bound (bounded-reads.ts), so this is a warning about
 * every other autocommit statement, not a stall by itself.
 */
export async function sessionTimeoutsCheck(engine: BrainEngine): Promise<Check> {
  const docs = 'docs/guides/troubleshooting.md#session-timeouts-not-applied';
  const configured = resolveSessionTimeouts().statement_timeout ?? null;
  if (engine.kind !== 'postgres' || configured === null) {
    return { name: 'persistence_session_timeouts', status: 'ok', details: { configured, applied: null, docs },
      message: configured === null ? 'No session statement_timeout is configured (GBRAIN_STATEMENT_TIMEOUT=0).' : 'PGLite has no session to time out.' };
  }
  try {
    // #6803: read outside the doctor entry's statement deadline, whose transaction-local statement_timeout would
    // otherwise be what SHOW reports (a pooler's 0 would read as applied). SHOW touches no table.
    const [row] = await withStatementDeadline(null, () => engine.executeRaw<{ statement_timeout: string }>('SHOW statement_timeout'));
    const applied = row?.statement_timeout ?? null;
    // #6278: the live stall ran through a transaction-mode pooler (Supavisor :6543), which can also leave a cancelled
    // round-trip incomplete (backend in ClientRead). The engine settles those client-side; the pooler mode is still worth naming.
    const url = process.env.GBRAIN_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    const pooler = url !== '' && resolvePrepare(url) === false;
    const poolerNote = pooler ? ' The configured URL is a transaction-mode pooler (prepared statements off): a cancel request may not reach the backend, so a cut-off statement is '
      + 'discarded client-side after GBRAIN_CANCEL_SETTLE_MS (default 2000). The session-mode URL of the same pooler (Supabase: port 5432) avoids both limits for the persistence owner.' : '';
    const details = { configured, applied, docs, ...(pooler ? { pooler: 'transaction_mode' } : {}) };
    if (applied !== '0') return { name: 'persistence_session_timeouts', status: pooler ? 'warn' : 'ok', details: pooler ? { ...details, reason: 'transaction_mode_pooler' } : details,
      message: `The session statement_timeout (${applied}) reaches the server.${poolerNote}` };
    const roleFix = `ALTER ROLE <gbrain role> SET statement_timeout = '${configured}'`;
    return { name: 'persistence_session_timeouts', status: 'warn', details: { ...details, reason: 'session_timeouts_not_applied', role_fix: roleFix },
      message: `session_timeouts_not_applied: gbrain configured statement_timeout=${configured} as a connection startup parameter, but SHOW statement_timeout through the configured URL `
        + 'reads 0. A transaction-mode pooler (PgBouncer, Supavisor) drops startup parameters, so statements outside a transaction have no server-side bound; GBRAIN_STATEMENT_TIMEOUT is '
        + 'ignored there. Preparation reads are bounded by their own transaction-local timeout (the preparation budget covers the gap); a long autocommit statement elsewhere still runs '
        + `until it finishes. To restore the session default, set it on the role: ${roleFix} (the pooler cannot be told to keep it).${poolerNote}` };
  } catch (error) {
    return checkError('persistence_session_timeouts', 'read the session statement_timeout', error, { details: { configured, health: 'unknown', docs } });
  }
}

/**
 * #6429: caller writes (`remember`, `put_page`, `add_timeline_entry`) that
 * ended `conflict` with `source_changed` (the page's file and database
 * differed at publication) or that the managed writer guard refused, whose
 * receipt still holds the intent. The caller saw an error and nothing landed:
 * on the reported brain 68 `remember` writes were lost this way while a
 * database-only grandfather stamp made every file look edited, and only a
 * query on `persistence_requests` showed it. Names the explicit-only replay's
 * preview per source. Read-only.
 */
export async function lostCallerWritesCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const docs = 'docs/guides/repair.md#failed-writes';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const { lost, compacted, not_replayable } = await lostCallerWrites(engine, sources);
    const count = lost.reduce((sum, row) => sum + row.count, 0);
    const kept = not_replayable.unpinned_target + not_replayable.revision_superseded;
    const details = { count, writes: lost, ...(kept ? { not_replayable } : {}), compacted_unreplayable: compacted, repair: 'failed-writes', docs };
    const compactedNote = compacted ? ` ${compacted} older refused receipt(s) were compacted (persistence.receipt_retention_days) and cannot be replayed.` : '';
    const keptNote = kept ? ` ${kept} refused caller write(s) cannot be replayed (${not_replayable.unpinned_target} remember whose subject was inferred, `
      + `${not_replayable.revision_superseded} put_page whose page changed after the revision the caller read); the caller has to write them again.` : '';
    if (!count) return { name: 'lost_caller_writes', status: 'ok', details, message: `Every caller write with a retained receipt committed or was superseded.${keptNote}${compactedNote}` };
    const bySource = new Map<string, number>();
    for (const row of lost) bySource.set(row.source_id, (bySource.get(row.source_id) ?? 0) + row.count);
    const first = [...bySource.keys()][0]!;
    const drift = lost.filter(row => row.reason === 'source_changed').reduce((sum, row) => sum + row.count, 0);
    const memory = lost.filter(row => row.operation === 'remember').reduce((sum, row) => sum + row.count, 0);
    return { name: 'lost_caller_writes', status: 'warn', details,
      message: `${count} caller write(s) never landed (${memory} remember; ${drift} refused source_changed because the page's canonical file did not match its database copy `
        + `or was missing, ${count - drift} refused by the managed writer guard): ${[...bySource].map(([source, n]) => `${source}: ${n}`).join(', ')}. The callers saw an error and `
        + `the fact or page edit was dropped. Preview the replay on the brain host: gbrain repair failed-writes --source ${first} — it lists which writes can be replayed and records `
        + `an approval checkpoint for that set (no page content changes); then run the apply command it prints after the user agrees.${keptNote}${compactedNote}`,
      fix: agentFix(['gbrain', 'repair', 'failed-writes', '--source', first],
        'Preview: lists each lost write with its disposition (replay, already_written, duplicate, superseded, unpinned_target, file_database_drift), records an approval checkpoint for the replay set (no page content changes) and prints the apply command.', 'lost_caller_writes', { docs }) };
  } catch (error) {
    return checkError('lost_caller_writes', 'inspect refused caller writes', error, { details: { count: 'unknown', docs } });
  }
}

/**
 * #7146: the rows ranked by what they block. Blocking first, each with what it holds (a recovery record holds every
 * queued write on its source's root, named by its page; a checkpoint blocker holds the source's managed-sync
 * checkpoint) and its fix; then the unresolved rows that block nothing, grouped by source, category, code and origin
 * with counts and the exact drill-down, defect classes first; then the historical rows as a count. A remote caller
 * (`remote`) is shown no page slug: the blockers lose their `slug` and the message names request ids and sources only.
 */
function rankTerminalFailures(sources: TerminalSourceSummary[], remote: boolean, tf: Pick<typeof import('../../../core/persistence/terminal-failures.ts'), 'terminalFailuresArgv' | 'NO_ORIGIN'>) {
  const { terminalFailuresArgv, NO_ORIGIN } = tf;
  const blocking = sources.flatMap(s => s.active_blockers).map(b => ({ kind: b.kind, request_id: b.request_id, source_id: b.source_id, ...(!remote && b.slug ? { slug: b.slug } : {}),
    category: b.category, needs_human: b.needs_human, blocks: b.kind === 'checkpoint' ? 'sync_checkpoint' as const : 'source' as const,
    fix: remote ? null : b.action.argv ?? null }));
  const groups = sources.flatMap(s => s.categories.filter(c => c.unresolved > 0).map(c => ({ source_id: s.source_id, category: c.category, code: c.code, origin: c.origin, rows: c.unresolved,
    defect: s.defects.some(d => d.category === c.category && d.code === c.code && d.origin === c.origin), needs_human: c.needs_human,
    drill_down: terminalFailuresArgv({ sourceId: s.source_id, category: c.category, code: c.code, origin: c.origin ?? NO_ORIGIN }) })))
    .sort((a, b) => Number(b.defect) - Number(a.defect) || b.rows - a.rows || a.source_id.localeCompare(b.source_id) || a.category.localeCompare(b.category));
  const unresolved = { rows: sources.reduce((n, s) => n + s.unresolved.rows, 0), pages: sources.reduce((n, s) => n + s.unresolved.distinct_slugs, 0), groups,
    group_by: sources.filter(s => s.unresolved.rows > 0).map(s => terminalFailuresArgv({ sourceId: s.source_id, groupBy: 'category' })) };
  const historical = { rows: sources.reduce((n, s) => n + s.historical_rows, 0) };
  const lines: string[] = [];
  if (blocking.length) {
    const shown = blocking.slice(0, 5).map(b => `${b.kind === 'recovery' ? 'recovery record' : 'checkpoint blocker'} ${b.request_id}${'slug' in b ? ` (${b.slug})` : ''} on source ${b.source_id} `
      + `blocks ${b.blocks === 'sync_checkpoint' ? 'the managed-sync checkpoint of the source' : 'every queued write on the source\'s root'}${b.fix ? `; fix: ${b.fix.join(' ')}` : ''}`);
    lines.push(`Blocking now (${blocking.length}): ${shown.join('; ')}${blocking.length > 5 ? `; +${blocking.length - 5} more in details.ranked.blocking` : ''}.`);
  }
  if (unresolved.rows) {
    const shown = groups.slice(0, 3).map(g => `${g.category}/${g.code} ×${g.rows} on ${g.source_id}${g.defect ? ' (gbrain defect)' : g.needs_human ? ' (needs a person)' : ''}`);
    lines.push(`Unresolved, not blocking: ${unresolved.rows} row(s) on ${unresolved.pages} page(s) in ${groups.length} group(s): ${shown.join('; ')}${groups.length > 3 ? `; +${groups.length - 3} more group(s)` : ''}. `
      + `Group them: ${unresolved.group_by.slice(0, 2).map(argv => argv.join(' ')).join('; ')} (each group carries its fix and drill-down).`);
  }
  if (historical.rows) lines.push(`Historical: ${historical.rows} row(s) a later write superseded or an older build wrote; nothing to do.`);
  return { ranked: { blocking, unresolved, historical }, text: lines.join(' ') };
}

/**
 * #6650 (L3): terminal write receipts that did not commit, read at doctor time (`terminal-failures.ts`, one bounded
 * aggregate; `terminal-classify.ts` names each class and its fix). Warns on any active blocker (a receipt still holding
 * a publication recovery record, which holds its root, or a receipt PR A's `checkpoint_blockers` names) and on an
 * unresolved gbrain-defect class, whatever the trend; the spike check (the last 24 h against the zero-filled median of
 * the 7 days before, `persistence.terminal_failures.spike_factor` / `spike_min`) is secondary. Rows written by a build
 * older than the release that fixed their class, and rows a later request made moot, are historical and never warn:
 * with nothing else, the check is ok as information. #7146: `details.ranked` and the message rank the rows (blocking,
 * unresolved, historical; `rankTerminalFailures`). Archived sources are skipped; with no engine (the fast path) there
 * is nothing to read.
 */
export async function terminalFailuresCheck(engine: BrainEngine | null, sourceIds?: string[], opts: { remote?: boolean } = {}): Promise<Check | null> {
  if (!engine) return null;
  const name = 'persistence_terminal_failures';
  const docs = 'docs/guides/troubleshooting.md#terminal-write-failures';
  const remote = opts.remote === true;
  try {
    const tf = await import('../../../core/persistence/terminal-failures.ts');
    const { readTerminalFailureSummary, readTerminalThresholds, readCheckpointBlockerMap, isSpike, sevenDayMedian, TERMINAL_WINDOW_KEY, TERMINAL_SPIKE_FACTOR_KEY, TERMINAL_SPIKE_MIN_KEY } = tf;
    const thresholds = await readTerminalThresholds(engine);
    const checkpointBlockers = await readCheckpointBlockerMap(engine, sourceIds);
    const summary = await readTerminalFailureSummary(engine, { sourceIds, thresholds, checkpointBlockers });
    const config = { window_days: { key: TERMINAL_WINDOW_KEY, value: thresholds.windowDays }, spike_factor: { key: TERMINAL_SPIKE_FACTOR_KEY, value: thresholds.spikeFactor },
      spike_min: { key: TERMINAL_SPIKE_MIN_KEY, value: thresholds.spikeMin }, receipt_retention_days: thresholds.retentionDays, window_clamped: thresholds.clamped };
    if (summary.status === 'unknown') {
      return { name, status: 'warn', message: `Terminal write failures could not be read: ${summary.reason}. Health is unknown, not clear; rerun gbrain doctor --only ${name}.`,
        details: { health: 'unknown', config, docs } };
    }
    const sources = summary.sources;
    const blockers = sources.flatMap(s => s.active_blockers);
    const defects = sources.flatMap(s => s.defects.map(d => ({ ...d, source_id: s.source_id })));
    const unresolved = sources.reduce((n, s) => n + s.unresolved.rows, 0);
    const historical = sources.reduce((n, s) => n + s.historical_rows, 0);
    const last24h = sources.reduce((n, s) => n + s.new_last_24h, 0);
    const daily = Array.from({ length: 7 }, (_, i) => sources.reduce((n, s) => n + (s.daily_7d[i] ?? 0), 0));
    const spike = isSpike(last24h, daily, thresholds);
    const oldest = sources.reduce<number | null>((max, s) => s.unresolved.oldest_age_seconds === null ? max : Math.max(max ?? 0, s.unresolved.oldest_age_seconds), null);
    const { ranked, text: ranking } = rankTerminalFailures(sources, remote, tf);
    const details = { count: blockers.length + defects.reduce((n, d) => n + d.rows, 0), active_blockers: blockers.map(({ action: _a, slug, ...b }) => ({ ...b, ...(!remote && slug ? { slug } : {}) })),
      unresolved: { rows: unresolved, distinct_slugs: sources.reduce((n, s) => n + s.unresolved.distinct_slugs, 0), distinct_intents: sources.reduce((n, s) => n + s.unresolved.distinct_intents, 0),
        oldest_age_seconds: oldest },
      historical_rows: historical, new_last_24h: last24h, spike: { last_24h: last24h, median_7d: sevenDayMedian(daily), daily_7d: daily, spiking: spike },
      defects: defects.map(({ action: _a, ...d }) => d), sources: sources.map(s => ({ source_id: s.source_id, active_blockers: s.active_blockers.length, unresolved: s.unresolved.rows,
        historical: s.historical_rows, new_last_24h: s.new_last_24h, categories: s.categories })), ranked, window_days: summary.window_days, config, docs };
    const counts = `${ranking}${ranking ? ' ' : ''}${last24h} ended in the last 24 h; window ${summary.window_days} d${oldest !== null ? `, oldest unresolved ${Math.round(oldest / 3600)} h` : ''}.`;
    // A remote caller is told to run the local check, which names each page and its fix; its actions can carry slugs and paths.
    const hostFix = { argv: ['gbrain', 'doctor', '--only', name, '--json'], consent: [], actor: 'user' as const, requires_exclusive: false, docs,
      why: 'Run on the brain host: the local report names each blocking page and its fix (a remote caller is not shown page slugs or file paths).' };
    if (blockers.length) {
      const first = blockers[0]!;
      return { name, status: 'warn', details, fix: remote ? hostFix : { ...first.action, verify: doctorVerify(name) },
        message: `${blockers.length} write receipt(s) block work right now. ${counts}${remote ? '' : ` ${first.action.why}`}` };
    }
    if (defects.length) {
      const first = defects[0]!;
      return { name, status: 'warn', details, fix: remote ? hostFix : { ...first.action, verify: doctorVerify(name) },
        message: `${defects.reduce((n, d) => n + d.rows, 0)} unresolved write receipt(s) in the last ${summary.window_days} d are a gbrain-defect class (${defects.slice(0, 3)
          .map(d => `${d.category}/${d.code} ×${d.rows} on ${d.source_id}`).join('; ')}). ${counts} ${first.human_reason ?? (remote ? hostFix.why : first.action.why)}` };
    }
    const drill = (sourceId: string) => ['gbrain', 'sources', 'writer', 'failures', sourceId, '--group-by', 'category', '--json'];
    if (spike) {
      const busiest = [...sources].sort((a, b) => b.new_last_24h - a.new_last_24h)[0]!;
      // Rows a build older than their class's fix wrote are an old owner still running, not a new defect: say so and name it.
      const older = sources.reduce((n, s) => n + s.new_last_24h_older_builds.rows, 0);
      if (older * 2 > last24h) {
        const builds = [...new Set(sources.flatMap(s => s.new_last_24h_older_builds.builds))].sort();
        const owner = [...sources].sort((a, b) => b.new_last_24h_older_builds.rows - a.new_last_24h_older_builds.rows)[0]!.source_id;
        return { name, status: 'warn', details: { ...details, spike: { ...details.spike, older_builds: { rows: older, builds } } },
          fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--source', owner, '--json'], 'Read-only: names the write owner of the source, its process and the gbrain version it runs.', name, { docs }),
          message: `${last24h} write receipt(s) ended without committing in the last 24 h, above ${thresholds.spikeFactor}× the 7-day median (${sevenDayMedian(daily)}/day), but ${older} of them `
            + `were written by gbrain ${builds.join(', ') || 'an older build'}, older than the release that fixed their class: an older write owner is still producing these; upgrade or restart it. ${counts}` };
      }
      return { name, status: 'warn', details,
        fix: agentFix(drill(busiest.source_id), 'Read-only: groups the source\'s unresolved receipts by code, origin and category, each with its fix and drill-down filter.', name, { docs }),
        message: `${last24h} write receipt(s) ended without committing in the last 24 h, above ${thresholds.spikeFactor}× the 7-day median (${sevenDayMedian(daily)}/day; `
          + `${TERMINAL_SPIKE_FACTOR_KEY}, ${TERMINAL_SPIKE_MIN_KEY}=${thresholds.spikeMin}). ${counts} Group them: ${drill(busiest.source_id).join(' ')}` };
    }
    if (!unresolved && historical) {
      return { name, status: 'ok', severity: 'info', details, message: `No write receipt blocks work and none is unresolved. ${counts}` };
    }
    return { name, status: 'ok', details,
      message: unresolved + historical ? `No write receipt blocks work and no gbrain-defect class is unresolved. ${counts}`
        : `No terminal write failures in the last ${summary.window_days} d.` };
  } catch (error) {
    return checkError(name, 'read terminal write failures', error, { details: { health: 'unknown', docs } });
  }
}
