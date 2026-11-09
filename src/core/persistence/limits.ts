import { opError, type OperationError } from '../ops/contract.ts';
import { PAGE_BODY_CONFIG_KEYS, pageRecoveryBytes, segmentedPageCeiling } from '../page-body/limits.ts';
import { DEFAULT_JOURNAL_LIMITS, principalKey, type JournalLimits, type Principal, type SqlEngine } from './model.ts';
import { COMPACTED_HEADROOM_BYTES, COMPACTED_RECEIPT_BYTES_SQL, EFFECT_BYTES_SQL, RECEIPT_RESERVATION_FLOOR } from './receipt-bytes.ts';

/** Fallback compacted receipt size when no receipt is sampled; a compacted put_page measures about 3.9 KB. */
export const RETAINED_RECEIPT_BYTES = 4096;

export const RECEIPT_RETENTION_KEY = 'persistence.receipt_retention_days';
export const DEFAULT_RECEIPT_RETENTION_DAYS = 30;
/**
 * GBRA-108: while receipts not yet compacted reserve more than this target (`readCompactableReceiptBytes`), housekeeping compacts settled receipts and re-derivable
 * producer refusals older than HOUSEKEEPING_FLOOR_DAYS instead of waiting out the default retention (compaction-pass.ts
 * `EARLY_SQL`; an explicit retention is kept as set), and doctor tells the host operator. 0 turns both off. Never a write refusal.
 */
export const RECEIPT_TARGET_KEY = 'persistence.housekeeping.receipt_target_bytes';
export const DEFAULT_RECEIPT_TARGET_BYTES = 8 * 1024 ** 3;
export const HOUSEKEEPING_FLOOR_DAYS = 7;
export async function readReceiptTargetBytes(engine:SqlEngine):Promise<number> {
  const [row]=await engine.executeRaw<{value:string}>('SELECT value FROM config WHERE key=$1',[RECEIPT_TARGET_KEY]);
  return row ? parseJournalConfigValue(RECEIPT_TARGET_KEY,row.value) : DEFAULT_RECEIPT_TARGET_BYTES;
}
/**
 * The reserved bytes the receipt target counts: terminal receipts not yet compacted that no recovery holds (the rows of the
 * persistence_requests_compactable index). A compacted receipt keeps about 1-4 KB so its request id stays idempotent and never
 * shrinks further, so counting those would keep a large brain above the target forever with nothing left to compact.
 */
export async function readCompactableReceiptBytes(engine:SqlEngine):Promise<number> {
  const [row]=await engine.executeRaw<{bytes:string}>(`SELECT COALESCE(SUM(terminal_reservation),0)::text AS bytes FROM persistence_requests
    WHERE recovery IS NULL AND NOT compacted AND state IN ('committed','conflict','failed','cancelled')`);
  return Number(row?.bytes ?? 0);
}

export function journalLimitKey(key:keyof JournalLimits):string {
  return `persistence.limits.${key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`)}`;
}
/** Every database config key the persistence journal reads. */
export const JOURNAL_CONFIG_KEYS: readonly string[] = [
  ...(Object.keys(DEFAULT_JOURNAL_LIMITS) as Array<keyof JournalLimits>).map(journalLimitKey), RECEIPT_RETENTION_KEY, RECEIPT_TARGET_KEY,
];
export function parseJournalConfigValue(key:string,value:string):number {
  if(!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw opError('invalid_params',`Invalid ${key}: expected a nonnegative integer.`,
      `Set ${key} to a whole number of 0 or more with gbrain config set ${key} followed by the number, or unset it to use the default.`);
  }
  return Number(value);
}
/**
 * Database configuration applies to every server sharing this brain. An unset `worktree_recovery_bytes` defaults to
 * room for the largest page `pages.max_bytes` admits and the largest page stored in segments (page-body/limits.ts
 * `pageRecoveryBytes`, never below 256 MiB; the stored maximum is one probe of pages_segmented_body_bytes_idx, v260, or
 * the engine ceiling while that index is not valid: JOURNAL_LIMITS_SQL); an
 * engine that is not PGLite (or a stub without a `kind`) counts as Postgres, the larger ceiling.
 */
/**
 * The journal's one config statement. Its last row (key NULL) is the largest page stored in segments, read only while
 * pages_segmented_body_bytes_idx is valid (the CASE leaves the subquery unexecuted otherwise, so an index the online
 * v260 build left INVALID never turns each limit read into a scan of pages); 'unindexed' then stands for a page at the
 * engine ceiling, the most any stored page can hold.
 */
export const JOURNAL_LIMITS_SQL=`SELECT key,value FROM config WHERE key LIKE 'persistence.limits.%' OR key IN ('${PAGE_BODY_CONFIG_KEYS.segmentedStorage}','${PAGE_BODY_CONFIG_KEYS.maxBytes}')
    UNION ALL SELECT NULL,CASE WHEN (SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('pages_segmented_body_bytes_idx')) IS TRUE
      THEN (SELECT max(body_bytes) FROM pages WHERE body_storage='segmented')::text ELSE 'unindexed' END`;
export async function readJournalLimits(engine:SqlEngine & { kind?: string },overrides?:Partial<JournalLimits>):Promise<JournalLimits> {
  const rows=await engine.executeRaw<{key:string|null;value:string|null}>(JOURNAL_LIMITS_SQL);
  const kind=engine.kind === 'pglite' ? 'pglite' : 'postgres';
  const configured=new Map(rows.filter(row=>row.key!==null && row.value!==null).map(row=>[row.key!,row.value!]));
  const stored=rows.find(row=>row.key===null)?.value ?? null;
  const storedSegmented=stored==='unindexed' ? segmentedPageCeiling(kind) : Number(stored ?? 0);
  const limits={...DEFAULT_JOURNAL_LIMITS,worktreeRecoveryBytes:pageRecoveryBytes(kind,configured.get(PAGE_BODY_CONFIG_KEYS.segmentedStorage) ?? null,
    configured.get(PAGE_BODY_CONFIG_KEYS.maxBytes) ?? null,DEFAULT_JOURNAL_LIMITS.worktreeRecoveryBytes,storedSegmented)};
  for(const key of Object.keys(limits) as Array<keyof JournalLimits>) {
    const value=configured.get(journalLimitKey(key));
    if(value!==undefined) limits[key]=parseJournalConfigValue(journalLimitKey(key),value);
    if(overrides?.[key]!==undefined) limits[key]=overrides[key]!;
    if((!Number.isSafeInteger(limits[key]) || limits[key]<0) && !(limits[key]===Infinity && DEFAULT_JOURNAL_LIMITS[key]===Infinity)) throw new TypeError(`Invalid journal limit: ${key}`);
  }
  return limits;
}
export async function readReceiptRetentionDays(engine:SqlEngine):Promise<number> {
  const [row]=await engine.executeRaw<{value:string}>('SELECT value FROM config WHERE key=$1',[RECEIPT_RETENTION_KEY]);
  return row ? parseJournalConfigValue(RECEIPT_RETENTION_KEY,row.value) : DEFAULT_RECEIPT_RETENTION_DAYS;
}
export type CapacityResource = 'lifetime_ids' | 'terminal_bytes';
/** The cap that covers one more year: ids at the id rate; bytes at the net rate plus the retention window held at the gross rate. */
export function recommendedLimit(resource: CapacityResource, used: number, limit: number, rate: { perDay: number; netPerDay?: number }, retentionDays: number): number {
  const needed = resource === 'lifetime_ids' ? used + rate.perDay * 365
    : used + (rate.netPerDay ?? rate.perDay) * 365 + Math.max(0, rate.perDay - (rate.netPerDay ?? rate.perDay)) * retentionDays;
  const value = Math.max(Math.ceil(needed), 2 * limit, 1);
  return resource === 'terminal_bytes' ? Math.ceil(value / 1024 ** 2) * 1024 ** 2 : value;
}

/** Newest admissions a one-year read walks for the 7-day window (the walk reads the sequence index newest first). */
const WINDOW_WALK_ROWS = 200_000;
/**
 * A cumulative cap value that covers one more year, never less than double the current cap. GST-2107: while the scope
 * admitted anything in the last 7 days it uses the window's mean rates over the window `readCapacityForecast` uses
 * (7 days, or the brain's age, at least a day), so an admission refusal names the same value as doctor and one bulk hour
 * is not projected for a year. A scope idle for a week is sized from its latest 1,000 admissions, however old. Receipt
 * bytes use measured reservations: what receipts reserve while the retention window holds them, and their compacted size
 * after (`recommendedLimit`).
 */
export async function oneYearCapacity(engine:SqlEngine,scope:string,setting:'LifetimeIds'|'TerminalBytes',used:number,limit:number):Promise<number> {
  const principal=/^principal:([^:]+):(.+)$/.exec(scope);
  const where=principal ? 'WHERE principal_kind=$1 AND principal_id=$2' : '';
  const [sample]=await engine.executeRaw<{admissions:number;age_seconds:number|null;gross:number|null;net:number|null;
    window_ids?:number|null;window_gross?:number|null;window_net?:number|null;window_span_days?:number|null;brain_age_days?:number|null}>(`WITH recent AS (
      SELECT id,created_at,terminal_reservation,authority,outcome,error_detail,client_request_id FROM persistence_requests ${where} ORDER BY sequence DESC LIMIT 1000),
    w AS (SELECT * FROM (SELECT id,created_at,terminal_reservation,authority,outcome,error_detail,client_request_id FROM persistence_requests ${where}
      ORDER BY sequence DESC LIMIT ${WINDOW_WALK_ROWS}) walk WHERE created_at>now()-interval '7 days'),
    e AS (SELECT request_id,SUM(${EFFECT_BYTES_SQL}) AS bytes FROM persistence_effects WHERE request_id IN (SELECT id FROM w) GROUP BY request_id)
    SELECT (SELECT count(*)::int FROM recent) AS admissions,(SELECT EXTRACT(EPOCH FROM (now()-min(created_at)))::float8 FROM recent) AS age_seconds,
      (SELECT avg(terminal_reservation)::float8 FROM recent) AS gross,
      (SELECT avg(LEAST(terminal_reservation,octet_length(authority::text)+COALESCE(octet_length(outcome::text),0)+COALESCE(octet_length(error_detail::text),0)+${COMPACTED_HEADROOM_BYTES}))::float8 FROM recent) AS net,
      (SELECT count(*)::int FROM w) AS window_ids,(SELECT EXTRACT(EPOCH FROM now()-min(created_at))/86400 FROM w)::float8 AS window_span_days,(SELECT COALESCE(SUM(terminal_reservation),0)::float8 FROM w) AS window_gross,
      (SELECT COALESCE(SUM(${COMPACTED_RECEIPT_BYTES_SQL('w', 'e')}),0)::float8 FROM w LEFT JOIN e ON e.request_id=w.id) AS window_net,
      (SELECT EXTRACT(EPOCH FROM now()-created_at)/86400 FROM persistence_requests ORDER BY sequence LIMIT 1)::float8 AS brain_age_days`,
  principal ? [principal[1],principal[2]] : []);
  const retention=await readReceiptRetentionDays(engine).catch(()=>DEFAULT_RECEIPT_RETENTION_DAYS);
  const windowIds=Number(sample.window_ids ?? 0);
  if(windowIds>0) {
    // A week busier than the walk reads the walk's own span, so the rate is never diluted over days it did not read.
    const windowDays=windowIds>=WINDOW_WALK_ROWS ? Math.max(1/24,Number(sample.window_span_days ?? 0)) : Math.min(7,Math.max(1,Number(sample.brain_age_days ?? 7)));
    return setting==='LifetimeIds' ? recommendedLimit('lifetime_ids',used,limit,{perDay:windowIds/windowDays},retention)
      : recommendedLimit('terminal_bytes',used,limit,{perDay:Number(sample.window_gross)/windowDays,netPerDay:Number(sample.window_net)/windowDays},retention);
  }
  const perDay=sample.admissions/Math.max(1/24,(sample.age_seconds ?? 0)/86_400);
  const measured=(value:number|null|undefined,fallback:number)=>Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : fallback;
  return setting==='LifetimeIds' ? recommendedLimit('lifetime_ids',used,limit,{perDay},retention)
    : recommendedLimit('terminal_bytes',used,limit,{perDay:perDay*measured(sample.gross,RECEIPT_RESERVATION_FLOOR),netPerDay:perDay*measured(sample.net,RETAINED_RECEIPT_BYTES)},retention);
}

/**
 * Upload sessions (Wave B, spec 6.2): staged bytes and open sessions per principal and per brain, counted in
 * persistence_counters under their own keys (`principal:<kind>:<id>:staged` and `brain:staged` in intent_bytes,
 * `principal:<kind>:<id>:uploads` in outstanding_count), and the idle and hard lifetime of a session. Begin reserves a
 * session's declared bytes; commit (in its publication), abort or expiry releases them. Database config
 * (`persistence.limits.<snake_key>`) overrides each default.
 */
export interface UploadLimits {
  principalStagedBytes: number; brainStagedBytes: number; principalUploads: number;
  uploadIdleSeconds: number; uploadMaxSeconds: number;
}
export const DEFAULT_UPLOAD_LIMITS: Readonly<UploadLimits> = Object.freeze({
  principalStagedBytes: 512 * 1024 ** 2, brainStagedBytes: 2 * 1024 ** 3, principalUploads: 4,
  uploadIdleSeconds: 60 * 60, uploadMaxSeconds: 24 * 60 * 60,
});
const uploadLimitKey = (key: keyof UploadLimits) => `persistence.limits.${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
export const UPLOAD_CONFIG_KEYS: readonly string[] = (Object.keys(DEFAULT_UPLOAD_LIMITS) as Array<keyof UploadLimits>).map(uploadLimitKey);

export async function readUploadLimits(engine: SqlEngine): Promise<UploadLimits> {
  const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config WHERE key=ANY($1::text[])', [[...UPLOAD_CONFIG_KEYS]]);
  const configured = new Map(rows.map(row => [row.key, row.value]));
  const limits = { ...DEFAULT_UPLOAD_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof UploadLimits>) {
    const value = configured.get(uploadLimitKey(key));
    if (value !== undefined) limits[key] = parseJournalConfigValue(uploadLimitKey(key), value);
  }
  return limits;
}

export const BRAIN_STAGED_KEY = 'brain:staged';
export function stagedCounterKeys(principal: Principal): { staged: string; uploads: string } {
  return { staged: `${principalKey(principal)}:staged`, uploads: `${principalKey(principal)}:uploads` };
}
/** The upload-session counter keys, which carry no journal capacity (diagnostics.ts skips them). */
export function isStagedCounterKey(key: string): boolean {
  return key === BRAIN_STAGED_KEY || (key.startsWith('principal:') && (key.endsWith(':staged') || key.endsWith(':uploads')));
}

/**
 * The CTE that deletes the parts and releases the reservations of the upload stagings a preceding CTE named `gone`
 * (columns id, kind, principal_kind, principal_id, reserved_bytes) moved out of a live state, in the same statement so
 * capacity is never free while its bytes remain; it locks the counter rows in key order as admission does. Constant
 * SQL; the caller ends the statement.
 */
export const RELEASE_STAGED_CTE = `released_parts AS (DELETE FROM page_body_staging_parts p USING gone g WHERE p.staging_id = g.id AND g.kind = 'upload' RETURNING 1),
  released_keys AS (
    SELECT key, SUM(bytes)::bigint AS bytes, SUM(n)::bigint AS n FROM (
      SELECT 'principal:'||principal_kind||':'||principal_id||':staged' AS key, reserved_bytes AS bytes, 0 AS n FROM gone WHERE kind='upload'
      UNION ALL SELECT '${BRAIN_STAGED_KEY}', reserved_bytes, 0 FROM gone WHERE kind='upload'
      UNION ALL SELECT 'principal:'||principal_kind||':'||principal_id||':uploads', 0, 1 FROM gone WHERE kind='upload') r GROUP BY key),
  released_locked AS (SELECT c.key FROM persistence_counters c WHERE c.key IN (SELECT key FROM released_keys) ORDER BY c.key COLLATE "C" FOR UPDATE),
  released AS (UPDATE persistence_counters c SET intent_bytes=c.intent_bytes-LEAST(d.bytes,c.intent_bytes),
      outstanding_count=c.outstanding_count-LEAST(d.n,c.outstanding_count)
    FROM released_keys d JOIN released_locked l ON l.key=d.key WHERE c.key=d.key RETURNING c.key)`;

/**
 * `write_quota_exhausted` for an upload-session cap: staged bytes or open sessions. `used` is null for the brain-wide
 * cap, whose usage counts other principals' uploads and is never reported. Committing, aborting or letting a
 * session expire frees it; the host can raise the cap (reversible).
 */
export function stagedQuotaExhausted(resource: string, setting: keyof UploadLimits, used: number | null, limit: number, need: number,
  reason: 'staged_bytes' | 'open_uploads'): OperationError {
  const key = uploadLimitKey(setting);
  const value = Math.max(limit * 2, (used ?? 0) + need);
  const usage = used === null ? `limit ${limit}` : `${used} used of ${limit}`;
  return opError('write_quota_exhausted', `Upload capacity exhausted: ${resource} (${usage}, this upload needs ${need}).`,
    `Commit or abort your open uploads (abort_page_upload), or let them expire, then begin again with the same request_id. `
    + `The brain host can raise the cap: gbrain config set ${key} ${value} (undo with gbrain config unset ${key}).`,
    { reason, detail: key.slice('persistence.limits.'.length), docs: 'docs/guides/write-refusals.md#write_quota_exhausted',
      fix: { argv: ['gbrain', 'config', 'set', key, String(value)], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: 'Open upload sessions hold their declared bytes until they commit, abort or expire; a larger cap admits more at once and is reversible.' } });
}
