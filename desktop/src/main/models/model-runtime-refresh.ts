import type { SetupPayload } from '../config-manager.js';

const RUNTIME_FIELDS = ['provider_base_urls', 'provider_touchpoint_base_urls', 'provider_touchpoint_api_keys'] as const;

function runtimeField(value: unknown): string {
  if (value == null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return '{}';
  return JSON.stringify(value);
}

export function modelServiceRuntimeChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return RUNTIME_FIELDS.some(key => runtimeField(before[key]) !== runtimeField(after[key]));
}

export interface RunningModelHotUpdate {
  sidecarReady: boolean;
  needsSetup: boolean;
  migrationRequired: boolean;
  applySourceConfiguration: boolean;
  payload: SetupPayload;
  current: {
    engine: 'pglite' | 'postgres';
    databasePath?: string;
    databaseUrl?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
  };
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return (left?.trim() || undefined) === (right?.trim() || undefined);
}

/** Chat, OCR, and provider edits can refresh a live gateway. Database, source, and embedding changes cannot. */
export function canHotUpdateRunningModels(input: RunningModelHotUpdate): boolean {
  if (!input.sidecarReady || input.needsSetup || input.migrationRequired || input.applySourceConfiguration) return false;
  const payload = input.payload;
  if (payload.resetAdvancedModelRouting || payload.customProvider || payload.customProviders) return false;
  if (payload.keys && Object.values(payload.keys).some(value => value?.trim())) return false;
  if (payload.engine !== input.current.engine) return false;
  if (payload.databasePath !== undefined && !sameOptional(payload.databasePath, input.current.databasePath)) return false;
  if (payload.databaseUrl !== undefined && !sameOptional(payload.databaseUrl, input.current.databaseUrl)) return false;
  const requestedEmbedding = payload.modelConfig?.embeddingModel?.trim();
  if (requestedEmbedding && requestedEmbedding !== input.current.embeddingModel?.trim()) return false;
  const requestedDimensions = payload.modelConfig?.embeddingDimensions;
  if (typeof requestedDimensions === 'number' && requestedDimensions !== input.current.embeddingDimensions) return false;
  return true;
}

export async function refreshRunningGateway(sidecar: {
  current: { adminRequest(path: string, init?: RequestInit): Promise<unknown> } | null;
  state: { phase: string } | null;
}): Promise<void> {
  if (!sidecar.current || sidecar.state?.phase !== 'ready') return;
  await sidecar.current.adminRequest('/admin/api/gateway/reload', { method: 'POST', body: '{}' });
}
