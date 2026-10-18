import { opError } from '../ops/contract.ts';
import { PAGE_BODY_CONFIG_KEYS, pageRecoveryBytes, segmentedPageCeiling } from '../page-body/limits.ts';
import { DEFAULT_JOURNAL_LIMITS, type JournalLimits, type SqlEngine } from './model.ts';
import { COMPACTED_HEADROOM_BYTES, RECEIPT_RESERVATION_FLOOR } from './receipt-bytes.ts';

/** Fallback compacted receipt size when no receipt is sampled; a compacted put_page measures about 3.9 KB. */
export const RETAINED_RECEIPT_BYTES = 4096;

export const RECEIPT_RETENTION_KEY = 'persistence.receipt_retention_days';
export const DEFAULT_RECEIPT_RETENTION_DAYS = 30;

export function journalLimitKey(key:keyof JournalLimits):string {
  return `persistence.limits.${key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`)}`;
}
/** Every database config key the persistence journal reads. */
export const JOURNAL_CONFIG_KEYS: readonly string[] = [
  ...(Object.keys(DEFAULT_JOURNAL_LIMITS) as Array<keyof JournalLimits>).map(journalLimitKey), RECEIPT_RETENTION_KEY,
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
    if(!Number.isSafeInteger(limits[key]) || limits[key]<0) throw new TypeError(`Invalid journal limit: ${key}`);
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

/**
 * A cumulative cap value that covers one more year at the scope's recent
 * admission rate (sampled from its latest 1,000 admissions), never less than
 * double the current cap. Receipt bytes use the sample's measured
 * reservations: what its receipts reserve now while the retention window
 * holds them, and their compacted size after (capacity-forecast.ts
 * `recommendedLimit`, the formula doctor uses too).
 */
export async function oneYearCapacity(engine:SqlEngine,scope:string,setting:'LifetimeIds'|'TerminalBytes',used:number,limit:number):Promise<number> {
  const principal=/^principal:([^:]+):(.+)$/.exec(scope);
  const [sample]=await engine.executeRaw<{admissions:number;age_seconds:number|null;gross:number|null;net:number|null}>(`SELECT count(*)::int AS admissions,
    EXTRACT(EPOCH FROM (now()-min(created_at)))::float8 AS age_seconds,avg(terminal_reservation)::float8 AS gross,
    avg(LEAST(terminal_reservation,octet_length(authority::text)+COALESCE(octet_length(outcome::text),0)+COALESCE(octet_length(error_detail::text),0)+${COMPACTED_HEADROOM_BYTES}))::float8 AS net
    FROM (SELECT created_at,terminal_reservation,authority,outcome,error_detail FROM persistence_requests
    ${principal ? 'WHERE principal_kind=$1 AND principal_id=$2' : ''} ORDER BY sequence DESC LIMIT 1000) recent`,
  principal ? [principal[1],principal[2]] : []);
  const perDay=sample.admissions/Math.max(1/24,(sample.age_seconds ?? 0)/86_400);
  const retention=await readReceiptRetentionDays(engine).catch(()=>DEFAULT_RECEIPT_RETENTION_DAYS);
  const measured=(value:number|null|undefined,fallback:number)=>Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : fallback;
  return setting==='LifetimeIds' ? recommendedLimit('lifetime_ids',used,limit,{perDay},retention)
    : recommendedLimit('terminal_bytes',used,limit,{perDay:perDay*measured(sample.gross,RECEIPT_RESERVATION_FLOOR),netPerDay:perDay*measured(sample.net,RETAINED_RECEIPT_BYTES)},retention);
}
