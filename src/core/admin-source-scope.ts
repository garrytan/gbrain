import { isValidSourceId } from './source-id.ts';

export interface AdminClientSourceScope {
  sourceId: string;
  federatedRead: string[];
}

function parseFederatedReadInput(raw: unknown, sourceId: string): string[] {
  if (raw === undefined || raw === null) return [sourceId];
  if (typeof raw === 'string') {
    const values = raw.split(',').map(s => s.trim()).filter(Boolean);
    return values.length > 0 ? values : [sourceId];
  }
  if (Array.isArray(raw)) {
    if (!raw.every(v => typeof v === 'string')) {
      throw new Error('federated_read must be an array of source ids');
    }
    const values = raw.map(v => v.trim()).filter(Boolean);
    return values.length > 0 ? values : [sourceId];
  }
  throw new Error('federated_read must be a string or array');
}

export function normalizeAdminClientSourceScope(
  rawSourceId: unknown,
  rawFederatedRead: unknown,
  availableSourceIds: string[],
): AdminClientSourceScope {
  const knownSources = new Set(availableSourceIds);
  const fallbackSourceId = knownSources.has('default') ? 'default' : (availableSourceIds[0] ?? 'default');
  const sourceId = rawSourceId === undefined || rawSourceId === null || rawSourceId === ''
    ? fallbackSourceId
    : rawSourceId;
  if (!isValidSourceId(sourceId)) {
    throw new Error(`Invalid source_id: ${JSON.stringify(sourceId)}`);
  }
  if (knownSources.size > 0 && !knownSources.has(sourceId)) {
    throw new Error(`Unknown source_id: ${sourceId}`);
  }

  const federatedRead = Array.from(new Set(parseFederatedReadInput(rawFederatedRead, sourceId)));
  for (const id of federatedRead) {
    if (!isValidSourceId(id)) {
      throw new Error(`Invalid federated_read source_id: ${JSON.stringify(id)}`);
    }
    if (knownSources.size > 0 && !knownSources.has(id)) {
      throw new Error(`Unknown federated_read source_id: ${id}`);
    }
  }
  return { sourceId, federatedRead };
}
