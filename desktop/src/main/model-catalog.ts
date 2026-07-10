import { getRecipe } from '../../../src/core/ai/recipes/index.js';

export type DesktopModelTouchpoint = 'chat' | 'embedding';

export interface DesktopProviderModels {
  models: string[];
  source: 'catalog' | 'ollama';
  warning?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export async function listDesktopProviderModels(
  provider: string,
  touchpoint: DesktopModelTouchpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopProviderModels> {
  const normalized = provider.trim().toLowerCase() === 'zeroentropy' ? 'zeroentropyai' : provider.trim().toLowerCase();
  const catalog = [...(getRecipe(normalized)?.touchpoints[touchpoint]?.models ?? [])];
  if (normalized !== 'ollama' || touchpoint !== 'embedding') {
    return { models: catalog, source: 'catalog' };
  }

  const configuredBase = process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434';
  const root = configuredBase.replace(/\/v1\/?$/i, '').replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const local = (body.models ?? []).map(item => item.name || item.model || '');
    return { models: unique([...local, ...catalog]), source: 'ollama' };
  } catch (error) {
    return {
      models: catalog,
      source: 'catalog',
      warning: `未连接到本机 Ollama（${error instanceof Error ? error.message : String(error)}），已显示常用向量模型。`,
    };
  }
}
