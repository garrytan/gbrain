import { loadConfigFileOnly } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { loadActivePack, type LoadActivePackInput } from './load-active.ts';
import { type ResolvedPack } from './registry.ts';

export type EngineSchemaOptions = Omit<LoadActivePackInput, 'cfg' | 'dbConfig' | 'perSourceDb'>;

export async function readDbSchemaPack(
  engine: Pick<BrainEngine, 'getConfig'> | null | undefined,
): Promise<string | undefined> {
  return (await engine?.getConfig('schema_pack'))?.trim() || undefined;
}

export async function engineSchemaInput(
  engine: Pick<BrainEngine, 'getConfig'> | null | undefined,
  options: EngineSchemaOptions,
): Promise<LoadActivePackInput> {
  const dbConfig = await readDbSchemaPack(engine);
  const perSourceDb = new Map<string, string>();
  if (options.sourceId) {
    const value = (await engine?.getConfig(`schema_pack.source.${options.sourceId}`))?.trim();
    if (value) perSourceDb.set(options.sourceId, value);
  }
  return { ...options, cfg: loadConfigFileOnly(), dbConfig, perSourceDb };
}

export async function loadActivePackForEngine(
  engine: Pick<BrainEngine, 'getConfig'> | null | undefined,
  options: EngineSchemaOptions,
): Promise<ResolvedPack> {
  return loadActivePack(await engineSchemaInput(engine, options));
}

