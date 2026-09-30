import type { BrainEngine } from '../engine.ts';
import { expandClosure } from './closure.ts';
import { engineSchemaInput } from './engine-resolution.ts';
import { loadActivePack, resolveActivePackNameOnly } from './load-active.ts';
import { SchemaPackTrustGateError } from './op-trust-gate.ts';

export async function expandEngineTypeFilters(
  engine: Pick<BrainEngine, 'getConfig'>,
  options: { type?: string; types?: string[]; sourceId?: string; sourceIds?: string[] },
): Promise<{ type?: undefined; types?: string[] }> {
  if (options.types?.length === 0) return { type: undefined, types: [] };
  if (!options.type && !options.types?.length) return {};
  const sourceIds = options.sourceIds?.length ? options.sourceIds : [options.sourceId];
  const inputs = await Promise.all(sourceIds.map(sourceId => engineSchemaInput(engine, { remote: true, sourceId })));
  const names = new Set(inputs.map(input => resolveActivePackNameOnly(input).pack_name));
  if (names.size > 1) {
    throw new SchemaPackTrustGateError('Type-filtered reads across sources with different schema packs are not supported. Query one source at a time.');
  }
  let pack;
  try {
    pack = await loadActivePack(inputs[0]);
  } catch {
    return { type: undefined, types: [] };
  }
  const scalar = options.type ? expandClosure(options.type, pack.alias_graph) : undefined;
  const multiple = options.types?.length
    ? [...new Set(options.types.flatMap(type => expandClosure(type, pack.alias_graph)))]
    : undefined;
  return { type: undefined, types: (scalar && multiple ? scalar.filter(type => multiple.includes(type)) : scalar ?? multiple)?.sort() };
}
