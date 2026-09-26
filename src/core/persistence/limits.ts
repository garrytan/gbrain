import { OperationError } from '../ops/contract.ts';
import { DEFAULT_JOURNAL_LIMITS, type JournalLimits, type SqlEngine } from './model.ts';

export function journalLimitKey(key:keyof JournalLimits):string {
  return `persistence.limits.${key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`)}`;
}
/** Database configuration applies to every server sharing this brain. */
export async function readJournalLimits(engine:SqlEngine,overrides?:Partial<JournalLimits>):Promise<JournalLimits> {
  const rows=await engine.executeRaw<{key:string;value:string}>("SELECT key,value FROM config WHERE key LIKE 'persistence.limits.%'");
  const configured=new Map(rows.map(row=>[row.key,row.value]));
  const limits={...DEFAULT_JOURNAL_LIMITS};
  for(const key of Object.keys(limits) as Array<keyof JournalLimits>) {
    const value=configured.get(journalLimitKey(key));
    if(value!==undefined) {
      if(!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new OperationError('invalid_params',`Invalid ${journalLimitKey(key)}: expected a nonnegative integer.`);
      }
      limits[key]=Number(value);
    }
    if(overrides?.[key]!==undefined) limits[key]=overrides[key]!;
    if(!Number.isSafeInteger(limits[key]) || limits[key]<0) throw new TypeError(`Invalid journal limit: ${key}`);
  }
  return limits;
}
