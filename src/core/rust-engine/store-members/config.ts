/** Config members: key and value strings in the store's `config` table (BrainEngine getConfig .. getAllConfig, getConfigValues). */
import { storeCall, type StoreMember } from './common.ts';

export const getConfig: StoreMember<[key: string], string | null> = (brain, key) =>
  storeCall({ member: 'getConfig' }, () => brain.getConfig(key));

export const setConfig: StoreMember<[key: string, value: string], void> = async (brain, key, value) => {
  await storeCall({ member: 'setConfig' }, () => brain.setConfig(key, value));
};

export const unsetConfig: StoreMember<[key: string], number> = (brain, key) =>
  storeCall({ member: 'unsetConfig' }, () => brain.unsetConfig(key));

export const listConfigKeys: StoreMember<[prefix: string], string[]> = (brain, prefix) =>
  storeCall({ member: 'listConfigKeys' }, () => brain.listConfigKeys(prefix));

export const getAllConfig: StoreMember<[], Record<string, string>> = (brain) =>
  storeCall({ member: 'getAllConfig' }, () => brain.getAllConfig());

export const getConfigValues: StoreMember<[keys: readonly string[]], Array<{ key: string; value: string }>> = (brain, keys) =>
  storeCall({ member: 'getConfigValues' }, () => brain.getConfigValues([...keys]));
