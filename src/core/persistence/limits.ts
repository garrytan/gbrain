import { OperationError } from '../ops/contract.ts';
import { DEFAULT_JOURNAL_LIMITS, type JournalLimits, type SqlEngine } from './model.ts';

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
    throw new OperationError('invalid_params',`Invalid ${key}: expected a nonnegative integer.`);
  }
  return Number(value);
}
/** Database configuration applies to every server sharing this brain. */
export async function readJournalLimits(engine:SqlEngine,overrides?:Partial<JournalLimits>):Promise<JournalLimits> {
  const rows=await engine.executeRaw<{key:string;value:string}>("SELECT key,value FROM config WHERE key LIKE 'persistence.limits.%'");
  const configured=new Map(rows.map(row=>[row.key,row.value]));
  const limits={...DEFAULT_JOURNAL_LIMITS};
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
/** Permanent accounting a compacted receipt keeps (authority, outcome, effects); measured ~3.9 KB for put_page. */
const RETAINED_RECEIPT_BYTES = 4096;
const RESERVED_RECEIPT_BYTES = 16_384;
/**
 * A cumulative cap value that covers one more year at the scope's recent
 * admission rate (sampled from its latest 1,000 admissions), never less than
 * double the current cap.
 */
export async function oneYearCapacity(engine:SqlEngine,scope:string,setting:'LifetimeIds'|'TerminalBytes',used:number,limit:number):Promise<number> {
  const principal=/^principal:([^:]+):(.+)$/.exec(scope);
  const [sample]=await engine.executeRaw<{admissions:number;age_seconds:number|null}>(`SELECT count(*)::int AS admissions,
    EXTRACT(EPOCH FROM (now()-min(created_at)))::float8 AS age_seconds FROM (SELECT created_at FROM persistence_requests
    ${principal ? 'WHERE principal_kind=$1 AND principal_id=$2' : ''} ORDER BY sequence DESC LIMIT 1000) recent`,
  principal ? [principal[1],principal[2]] : []);
  const perDay=sample.admissions/Math.max(1/24,(sample.age_seconds ?? 0)/86_400);
  const retention=await readReceiptRetentionDays(engine).catch(()=>DEFAULT_RECEIPT_RETENTION_DAYS);
  const needed=setting==='LifetimeIds' ? used+perDay*365 : used+perDay*(365*RETAINED_RECEIPT_BYTES+retention*RESERVED_RECEIPT_BYTES);
  const value=Math.max(Math.ceil(needed),2*limit,1);
  return setting==='TerminalBytes' ? Math.ceil(value/1024**2)*1024**2 : value;
}
