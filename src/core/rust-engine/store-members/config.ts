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
