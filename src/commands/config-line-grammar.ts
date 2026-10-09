/**
 * `gbrain config` for line-grammar keys and gbrain's internal rows: a
 * line-grammar setting commits with the extraction generation
 * (core/line-grammar-config.ts), so the graph follows the setting, and
 * `_internal.*` keys are never set or unset by hand.
 */
import type { BrainEngine } from '../core/engine.ts';
import {
  applyLineGrammarConfigChange, describeLineGrammarChange, invalidLineGrammarValue, isInternalConfigKey, isLineGrammarKey,
} from '../core/line-grammar-config.ts';

async function changeLineGrammarConfig(engine: BrainEngine, mutate: (tx: BrainEngine) => Promise<void>): Promise<void> {
  const change = await applyLineGrammarConfigChange(engine, mutate);
  for (const line of (await describeLineGrammarChange(engine, change)).lines) console.error(`[config] ${line}`);
}

/** Handles `config set` for an internal or line-grammar key; returns false for any other key. */
export async function setLineGrammarConfig(engine: BrainEngine, key: string, value: string): Promise<boolean> {
  if (isInternalConfigKey(key)) {
    console.error(`[config] ${key} is internal state gbrain maintains itself; it cannot be set. For the line grammar, set line_grammar.enabled instead.`);
    process.exit(1);
  }
  if (!isLineGrammarKey(key)) return false;
  const err = invalidLineGrammarValue(key, value);
  if (err) { console.error(`[config] ${err}`); process.exit(1); }
  await changeLineGrammarConfig(engine, tx => tx.setConfig(key, value));
  return true;
}

/**
 * Delete config rows; line-grammar keys commit with the extraction generation in one transaction.
 * `_internal.*` keys are gbrain's own state: a single unset refuses one, a pattern unset skips them.
 */
export async function unsetConfigKeys(engine: BrainEngine, keys: string[], opts: { single?: boolean } = {}): Promise<number> {
  if (opts.single && keys.some(isInternalConfigKey)) {
    console.error(`[config] ${keys[0]} is internal state gbrain maintains itself; it cannot be unset.`);
    process.exit(1);
  }
  let deleted = 0;
  for (const k of keys.filter(k => !isLineGrammarKey(k) && !isInternalConfigKey(k))) deleted += Math.max(0, await engine.unsetConfig(k));
  const grammarKeys = keys.filter(isLineGrammarKey);
  if (grammarKeys.length) await changeLineGrammarConfig(engine, async tx => { for (const k of grammarKeys) deleted += await tx.unsetConfig(k); });
  return deleted;
}
