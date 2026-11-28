/** Config members: key and value strings in the store's `config` table (BrainEngine getConfig .. getAllConfig, getConfigValues). */
import { assertReservedConfigWrite } from '../../config-snapshot.ts';
import { storeCall, type StoreMember } from './common.ts';

export const getConfig: StoreMember<[key: string], string | null> = (brain, key) =>
  storeCall({ member: 'getConfig' }, () => brain.getConfig(key));

/** The stored value (the store has no request snapshot, and its transaction reads see their own writes). */
export const readStoredConfigValue: StoreMember<[key: string], string | null> = (brain, key) =>
  storeCall({ member: 'readStoredConfigValue' }, () => brain.getConfig(key));

/** The reserved policy and brain-first keys (#10304) refuse outside an owner-confirmed command, as PGLite and Postgres refuse them. */
export const setConfig: StoreMember<[key: string, value: string], void> = async (brain, key, value) => {
  assertReservedConfigWrite(key);
  await storeCall({ member: 'setConfig' }, () => brain.setConfig(key, value));
};

export const unsetConfig: StoreMember<[key: string], number> = async (brain, key) => {
  assertReservedConfigWrite(key);
  return storeCall({ member: 'unsetConfig' }, () => brain.unsetConfig(key));
};

export const listConfigKeys: StoreMember<[prefix: string], string[]> = (brain, prefix) =>
  storeCall({ member: 'listConfigKeys' }, () => brain.listConfigKeys(prefix));

export const getAllConfig: StoreMember<[], Record<string, string>> = (brain) =>
  storeCall({ member: 'getAllConfig' }, () => brain.getAllConfig());

export const getConfigValues: StoreMember<[keys: readonly string[]], Array<{ key: string; value: string }>> = (brain, keys) =>
  storeCall({ member: 'getConfigValues' }, () => brain.getConfigValues([...keys]));

/** `LIKE 'schema_pack.source.%'`: each `_` matches any one character, `%` any run, and the rest literally. */
const SCHEMA_PACK_SOURCE_KEY = /^schema.pack\.source\./su;

/**
 * The schema_pack_source_drift rows (engine-sql/doctor-reads.ts): the named `schema_pack.source.<id>` keys through
 * getConfigValues when `sourceIds` is given (`[]` reads none), else every stored key the SQL engines' LIKE pattern
 * matches. Rows come in key order; the SQL statements leave order unspecified and the check reads only count and values.
 */
export const listSchemaPackSourceOverrides: StoreMember<[sourceIds: readonly string[] | null], Array<{ key: string; value: string }>> = async (brain, sourceIds) => {
  const member = { member: 'listSchemaPackSourceOverrides' };
  if (sourceIds) {
    if (sourceIds.length === 0) return [];
    return storeCall(member, () => brain.getConfigValues(sourceIds.map((id) => `schema_pack.source.${id}`)));
  }
  const all: Record<string, string> = await storeCall(member, () => brain.getAllConfig());
  return Object.keys(all).filter((key) => SCHEMA_PACK_SOURCE_KEY.test(key)).sort().map((key) => ({ key, value: all[key]! }));
};
