/**
 * `gbrain config set redaction.*`: value refusal before the write, and the
 * projection re-seal after `redaction.projection_classes` changes (the chunks
 * on disk must be cut with the class list the policy names; see
 * core/page-state/redaction-reseal.ts).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfigSnapshot } from '../../core/config-snapshot.ts';
import { REDACTION_CONFIG_KEYS, redactionConfigValueRefusal } from '../../core/redaction-policy.ts';
import { resealRedactionProjections } from '../../core/page-state/redaction-reseal.ts';

/** Refuse a malformed `redaction.*` value; nothing is written. */
export function refuseInvalidRedactionValue(key: string, value: string): void {
  const refusal = redactionConfigValueRefusal(key, value);
  if (!refusal) return;
  console.error(`[config] ${refusal} Nothing was written.`);
  process.exit(1);
}

/** After `redaction.projection_classes` is written: publish the new policy and re-seal the affected pages. */
export async function resealAfterRedactionChange(engine: BrainEngine, key: string): Promise<void> {
  if (key !== REDACTION_CONFIG_KEYS.projection) return;
  await loadConfigSnapshot(engine); // publishes the policy this process now applies
  const r = await resealRedactionProjections(engine);
  console.log(`[config] redaction projection: ${r.scanned} page(s) scanned, ${r.resealed} re-chunked, ${r.unchanged} unchanged, `
    + `${r.superseded} superseded, ${r.failed} failed.${r.resealed ? ' Run gbrain embed --stale to embed the re-chunked pages.' : ''}`
    + `${r.failed ? ` Re-run gbrain config set ${key} ${r.classes.join(',') || 'none'} after fixing the failures.` : ''}`);
}
