import type { BrainEngine } from '../../src/core/engine.ts';
import { PMBRAIN_SCHEMA_VERSION_KEY } from '../../src/core/pmbrain-adapters/migration-ledger.ts';

export async function setTestSchemaVersion(engine: BrainEngine, version: string): Promise<void> {
  await engine.setConfig('version', version);
  await engine.setConfig(PMBRAIN_SCHEMA_VERSION_KEY, version);
}
