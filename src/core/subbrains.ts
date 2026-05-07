import type { BrainEngine } from './engine.ts';
import { slugifySegment } from './sync.ts';

export const SUBBRAIN_REGISTRY_CONFIG_KEY = 'subbrains.v1';

export interface SubbrainConfig {
  id: string;
  path: string;
  prefix: string;
  default?: boolean;
}

export interface SubbrainRegistry {
  subbrains: Record<string, SubbrainConfig>;
}

export interface AddSubbrainInput {
  id: string;
  path: string;
  prefix?: string;
  default?: boolean;
}

const RESERVED_SEGMENTS = new Set(['.git', 'node_modules', 'ops']);

export function parseSubbrainRegistry(raw: string | null): SubbrainRegistry {
  if (!raw || raw.trim().length === 0) {
    return { subbrains: {} };
  }

  const parsed = JSON.parse(raw) as Partial<SubbrainRegistry>;
  const rawSubbrains = parsed.subbrains && typeof parsed.subbrains === 'object' && !Array.isArray(parsed.subbrains)
    ? parsed.subbrains
    : {};

  const subbrains: Record<string, SubbrainConfig> = {};
  const prefixes = new Set<string>();
  for (const [key, value] of Object.entries(rawSubbrains)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Malformed sub-brain registry entry: ${key}`);
    }

    const candidate = value as Partial<SubbrainConfig>;
    const id = validateSubbrainId(candidate.id ?? '');
    if (id !== key) {
      throw new Error(`Sub-brain id does not match registry key: ${key}`);
    }
    if (typeof candidate.path !== 'string' || candidate.path.trim().length === 0) {
      throw new Error(`Sub-brain path must be a non-empty string: ${id}`);
    }
    const prefix = validateSubbrainPrefix(candidate.prefix ?? '');
    if (prefixes.has(prefix)) {
      throw new Error(`Sub-brain prefix already exists: ${prefix}`);
    }
    prefixes.add(prefix);
    if (candidate.default !== undefined && typeof candidate.default !== 'boolean') {
      throw new Error(`Sub-brain default flag must be boolean: ${id}`);
    }

    subbrains[id] = {
      id,
      path: candidate.path,
      prefix,
      ...(candidate.default ? { default: true } : {}),
    };
  }

  return { subbrains };
}

export function serializeSubbrainRegistry(registry: SubbrainRegistry): string {
  const sortedEntries = Object.entries(registry.subbrains)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    subbrains: Object.fromEntries(sortedEntries),
  });
}

export async function loadSubbrainRegistry(engine: Pick<BrainEngine, 'getConfig'>): Promise<SubbrainRegistry> {
  return parseSubbrainRegistry(await engine.getConfig(SUBBRAIN_REGISTRY_CONFIG_KEY));
}

export async function saveSubbrainRegistry(
  engine: Pick<BrainEngine, 'setConfig'>,
  registry: SubbrainRegistry,
): Promise<void> {
  await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, serializeSubbrainRegistry(registry));
}

export function validateSubbrainId(value: string): string {
  return validateSubbrainSegment(value, 'Sub-brain id');
}

export function validateSubbrainPrefix(value: string): string {
  return validateSubbrainSegment(value, 'Sub-brain prefix');
}

function validateSubbrainSegment(value: string, label: string): string {
  const segment = value.trim();
  if (!segment) {
    throw new Error(`${label} must be a non-empty single slug segment`);
  }
  if (segment.includes('/')) {
    throw new Error(`${label} must be a single slug segment`);
  }
  if (RESERVED_SEGMENTS.has(segment) || segment.startsWith('.')) {
    throw new Error(`${label} is reserved: ${segment}`);
  }
  if (slugifySegment(segment) !== segment) {
    throw new Error(`${label} must already be slugified: ${segment}`);
  }
  return segment;
}

export function addSubbrainToRegistry(
  registry: SubbrainRegistry,
  input: AddSubbrainInput,
): SubbrainRegistry {
  const id = validateSubbrainId(input.id);
  const prefix = validateSubbrainPrefix(input.prefix ?? id);

  if (registry.subbrains[id]) {
    throw new Error(`Sub-brain already exists: ${id}`);
  }

  for (const subbrain of Object.values(registry.subbrains)) {
    if (subbrain.prefix === prefix) {
      throw new Error(`Sub-brain prefix already exists: ${prefix}`);
    }
  }

  const subbrains: Record<string, SubbrainConfig> = {};
  for (const [key, subbrain] of Object.entries(registry.subbrains)) {
    subbrains[key] = input.default ? { ...subbrain, default: undefined } : { ...subbrain };
    if (subbrains[key].default === undefined) {
      delete subbrains[key].default;
    }
  }

  subbrains[id] = {
    id,
    path: input.path,
    prefix,
    ...(input.default ? { default: true } : {}),
  };

  return { subbrains };
}

export function removeSubbrainFromRegistry(
  registry: SubbrainRegistry,
  id: string,
): SubbrainRegistry {
  const normalizedId = validateSubbrainId(id);
  const subbrains = { ...registry.subbrains };
  delete subbrains[normalizedId];
  return { subbrains };
}

export function findSubbrainBySlugPrefix(
  registry: SubbrainRegistry,
  slug: string,
): SubbrainConfig | null {
  const prefix = slug.split('/')[0];
  for (const subbrain of Object.values(registry.subbrains)) {
    if (subbrain.prefix === prefix) {
      return subbrain;
    }
  }
  return null;
}

export function stripSubbrainPrefix(subbrain: SubbrainConfig, slug: string): string {
  if (slug === subbrain.prefix) {
    throw new Error(`Slug is missing path after prefix: ${subbrain.prefix}`);
  }
  const prefix = `${subbrain.prefix}/`;
  if (!slug.startsWith(prefix)) {
    throw new Error(`Slug does not start with sub-brain prefix: ${subbrain.prefix}`);
  }
  const stripped = slug.slice(prefix.length);
  if (!stripped) {
    throw new Error(`Slug is missing path after prefix: ${subbrain.prefix}`);
  }
  return stripped;
}
