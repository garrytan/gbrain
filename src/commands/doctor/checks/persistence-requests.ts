import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readRequestIndexStates, REQUEST_INDEXES_REPAIR_COMMAND } from '../../../core/persistence/checkpoint-validation.ts';
import { oneYearCapacity, readJournalLimits, journalLimitKey } from '../../../core/persistence/limits.ts';

const WINDOW_DAYS = 7;
const SAMPLE = 10_000;
const WARN_DAYS = 90;
const HORIZON_DAYS = 3650;

/**
 * #5762: the managed sync checkpoint validation relies on two request
 * indexes that Postgres builds CONCURRENTLY. Reports each one missing, left
 * INVALID by an interrupted build, or still building (with progress), and the
 * one command that rebuilds it on a current schema.
 */
export async function requestIndexesCheck(engine: BrainEngine): Promise<Check> {
  const docs = 'docs/guides/repair.md#request-indexes';
  try {
    const indexes = await readRequestIndexStates(engine);
    const broken = indexes.filter(index => index.state === 'missing' || index.state === 'invalid');
    const building = indexes.filter(index => index.state === 'building');
    const details = { count: broken.length, indexes, repair: 'request-indexes', command: REQUEST_INDEXES_REPAIR_COMMAND, docs };
    if (broken.length) return { name: 'persistence_request_indexes', status: 'warn', details,
      message: `${broken.map(index => `${index.name} is ${index.state === 'invalid' ? 'INVALID' : 'missing'}`).join('; ')}: managed sync checkpoints can time out `
        + `on a large request table. Rebuild on the brain host: ${REQUEST_INDEXES_REPAIR_COMMAND}` };
    if (building.length) return { name: 'persistence_request_indexes', status: 'warn', details,
      message: `Still building: ${building.map(index => `${index.name} (${index.progress?.phase ?? 'building'}${index.progress?.blocks_total
        ? `, ${index.progress.blocks_done}/${index.progress.blocks_total} blocks` : ''})`).join('; ')}. It is safe to leave running; rerun gbrain doctor to follow it.` };
    return { name: 'persistence_request_indexes', status: 'ok', message: 'Managed sync request indexes are valid.', details };
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
 * Warns when a scope would exhaust its lifetime IDs within 90 days, with the
 * same `gbrain config set` value `persistence_capacity` prints.
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
    const soon = scopes.filter(scope => scope.days_to_exhaustion !== null && scope.days_to_exhaustion < WARN_DAYS);
    // Every principal shares one brain-wide key, so each key gets the largest value any scope needs.
    const needed = new Map<string, number>();
    for (const scope of soon) {
      const value = await oneYearCapacity(engine, scope.scope, 'LifetimeIds', scope.lifetime_ids, scope.limit);
      needed.set(scope.config_key, Math.max(needed.get(scope.config_key) ?? 0, value));
    }
    const commands = [...needed].map(([key, value]) => `gbrain config set ${key} ${value}`);
    const details = { rows: Number(table?.rows ?? 0), rows_exact: engine.kind !== 'postgres', window_days: WINDOW_DAYS, scopes,
      commands, verify: 'gbrain doctor --json (check persistence_request_growth)', docs };
    const rows = `${details.rows_exact ? '' : '~'}${details.rows} request row(s)`;
    if (!soon.length) return { name: 'persistence_request_growth', status: 'ok', details,
      message: `${rows}; no scope exhausts its lifetime request IDs within ${WARN_DAYS} days at its last-${WINDOW_DAYS}-day rate.` };
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
