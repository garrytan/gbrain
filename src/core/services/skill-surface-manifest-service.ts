import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type SkillSurfaceLoadability = {
  agent_loadable: boolean;
  mcp_resource_loadable: boolean;
  docs_only: boolean;
};

export type SkillSurfaceManifestEntry = SkillSurfaceLoadability & {
  id: string;
  uri: string;
  title: string;
  description: string;
  relative_path: string;
  mime_type: 'text/markdown';
  sha256: string;
  version: string | null;
};

export type SkillSurfaceResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: 'text/markdown';
  manifestHash: string;
  version?: string;
};

export type SkillSurfaceResourceContent = {
  uri: string;
  mimeType: 'text/markdown';
  text: string;
};

type SkillSurfaceDocDefinition = {
  id: string;
  uri: string;
  title: string;
  description: string;
  relativePath: string;
  loadability: SkillSurfaceLoadability;
};

const DOC_DEFINITIONS: SkillSurfaceDocDefinition[] = [
  {
    id: 'agent-rules',
    uri: 'mbrain://docs/agent-rules',
    title: 'MBrain Agent Rules',
    description: 'Compact governed-read and routed-write rules for agents.',
    relativePath: 'docs/MBRAIN_AGENT_RULES.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
  {
    id: 'skillpack',
    uri: 'mbrain://docs/skillpack',
    title: 'MBrain Skillpack',
    description: 'Reference architecture and guide index for MBrain agents.',
    relativePath: 'docs/MBRAIN_SKILLPACK.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
  {
    id: 'guide-brain-agent-loop',
    uri: 'mbrain://docs/guides/brain-agent-loop',
    title: 'Brain-Agent Loop',
    description: 'Read, respond, route durable writes, and sync the brain.',
    relativePath: 'docs/guides/brain-agent-loop.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
  {
    id: 'guide-brain-first-lookup',
    uri: 'mbrain://docs/guides/brain-first-lookup',
    title: 'Brain-First Lookup',
    description: 'Canonical retrieve_context to read_context lookup protocol.',
    relativePath: 'docs/guides/brain-first-lookup.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
  {
    id: 'guide-source-attribution',
    uri: 'mbrain://docs/guides/source-attribution',
    title: 'Source Attribution',
    description: 'Citation and authority rules for facts in the brain.',
    relativePath: 'docs/guides/source-attribution.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
  {
    id: 'guide-search-modes',
    uri: 'mbrain://docs/guides/search-modes',
    title: 'Search Modes',
    description: 'When to probe, read canonical evidence, or use lower-level search tools.',
    relativePath: 'docs/guides/search-modes.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
  {
    id: 'mcp-instructions',
    uri: 'mbrain://docs/mcp-instructions',
    title: 'MCP Instructions',
    description: 'Compact MCP initialize instructions shipped with MBrain.',
    relativePath: 'docs/MCP_INSTRUCTIONS.md',
    loadability: { agent_loadable: true, mcp_resource_loadable: true, docs_only: false },
  },
];

const docContentCache = new Map<string, string>();

export function buildSkillSurfaceManifest(baseDir = process.cwd()): SkillSurfaceManifestEntry[] {
  return DOC_DEFINITIONS.map((definition) => {
    const text = readSkillSurfaceDocText(definition.relativePath, baseDir);
    return {
      id: definition.id,
      uri: definition.uri,
      title: definition.title,
      description: definition.description,
      relative_path: definition.relativePath,
      mime_type: 'text/markdown',
      sha256: sha256(text),
      version: extractVersion(text),
      ...definition.loadability,
    };
  });
}

export function listSkillSurfaceResources(baseDir = process.cwd()): SkillSurfaceResource[] {
  return buildSkillSurfaceManifest(baseDir)
    .filter((entry) => entry.mcp_resource_loadable)
    .map((entry) => ({
      uri: entry.uri,
      name: entry.title,
      description: entry.description,
      mimeType: entry.mime_type,
      manifestHash: entry.sha256,
      ...(entry.version ? { version: entry.version } : {}),
    }));
}

export function readSkillSurfaceResource(
  uri: string,
  baseDir = process.cwd(),
): SkillSurfaceResourceContent | null {
  const definition = DOC_DEFINITIONS.find((entry) => entry.uri === uri);
  if (!definition || !definition.loadability.mcp_resource_loadable) return null;
  return {
    uri,
    mimeType: 'text/markdown',
    text: readSkillSurfaceDocText(definition.relativePath, baseDir),
  };
}

export function skillSurfaceDocumentDefinitions(): readonly SkillSurfaceDocDefinition[] {
  return DOC_DEFINITIONS;
}

function readSkillSurfaceDocText(relativePath: string, baseDir: string): string {
  const path = resolveSkillSurfaceDocPath(relativePath, baseDir);
  let content = docContentCache.get(path);
  if (content === undefined) {
    content = readFileSync(path, 'utf-8');
    docContentCache.set(path, content);
  }
  return content;
}

function resolveSkillSurfaceDocPath(relativePath: string, baseDir: string): string {
  const candidates = [
    join(baseDir, relativePath),
    join(__dirname, '..', '..', '..', relativePath),
    join(__dirname, '..', '..', '..', '..', relativePath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Skill surface document not found: ${relativePath}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function extractVersion(text: string): string | null {
  const explicit = text.match(/<!--\s*(?:mbrain-agent-rules-version|skillpack-version):\s*([^>\s]+)\s*-->/i);
  return explicit?.[1] ?? null;
}
