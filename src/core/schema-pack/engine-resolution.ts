import { createHash } from 'node:crypto';
import { loadConfigFileOnly } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { loadActivePack, loadResolvedPackByName, type LoadActivePackInput } from './load-active.ts';
import { invalidatePackCache, type ResolvedPack } from './registry.ts';

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

export interface ApprovedSchemaIdentity {
  name: string;
  identity: string;
  resolvedManifestHash: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function approvedSchemaIdentity(pack: ResolvedPack): ApprovedSchemaIdentity {
  return {
    name: pack.manifest.name,
    identity: pack.identity,
    resolvedManifestHash: createHash('sha256').update(JSON.stringify(canonical(pack.manifest))).digest('hex'),
  };
}

export class SchemaApprovalError extends OperationError {
  readonly code = 'schema_identity_mismatch';
  constructor(message: string) {
    super('schema_identity_mismatch', message);
    this.name = 'SchemaApprovalError';
  }
}

export interface ApprovedSchemaCheck {
  pack: ResolvedPack;
  binding: { key: 'schema_pack'; value: string; expectedValue: string | null } | null;
}

export async function checkApprovedSchemaForEngine(
  engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>,
  approved: ApprovedSchemaIdentity,
  options: EngineSchemaOptions & { allowBinding?: boolean },
): Promise<ApprovedSchemaCheck> {
  if (options.remote !== false) throw new SchemaApprovalError('Approved schema binding requires a trusted local caller.');
  invalidatePackCache(approved.name);
  const pack = await loadResolvedPackByName(approved.name);
  const actual = approvedSchemaIdentity(pack);
  if (actual.name !== approved.name || actual.identity !== approved.identity || actual.resolvedManifestHash !== approved.resolvedManifestHash) {
    throw new SchemaApprovalError('The approved schema or its inherited definitions changed; inspect the source again.');
  }
  const overrides = [options.perCall, process.env.GBRAIN_SCHEMA_PACK?.trim(), options.gbrainYml];
  const sourceOverrides = await engine.executeRaw<{ key: string; value: string }>(
    "SELECT key, value FROM config WHERE key LIKE 'schema_pack.source.%'",
  );
  overrides.push(...sourceOverrides.map(row => row.value.trim()));
  if (overrides.some(value => value && value !== approved.name)) {
    throw new SchemaApprovalError('A schema override disagrees with the approved schema; clear it before connecting.');
  }
  const expectedValue = await engine.getConfig('schema_pack');
  const dbPack = expectedValue?.trim();
  if (dbPack === approved.name) return { pack, binding: null };
  if (!options.allowBinding) throw new SchemaApprovalError('The selected brain is not bound to the approved schema.');
  return { pack, binding: { key: 'schema_pack', value: approved.name, expectedValue } };
}
