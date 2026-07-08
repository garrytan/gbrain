import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { loadActivePack } from '../schema-pack/load-active.ts';
import filingRulesDoc from '../../../skills/_brain-filing-rules.json';

type FilingRulesDoc = {
  dream_synthesize_paths?: {
    globs?: unknown;
  };
};

const moduleDir = dirname(fileURLToPath(import.meta.url));

export async function loadAllowedSlugPrefixes(): Promise<string[]> {
  const explicit = loadAllowedSlugPrefixesFromFiles([
    join(process.cwd(), 'skills', '_brain-filing-rules.json'),
    join(moduleDir, 'skills', '_brain-filing-rules.json'),
    join(moduleDir, '..', '..', '..', 'skills', '_brain-filing-rules.json'),
  ]);
  if (explicit.length > 0) return explicit;

  return uniq([
    ...extractAllowedSlugPrefixes(filingRulesDoc as FilingRulesDoc),
    ...await deriveAllowedSlugPrefixesFromSchemaPack(),
  ]);
}

function loadAllowedSlugPrefixesFromFiles(candidates: string[]): string[] {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FilingRulesDoc;
      const globs = extractAllowedSlugPrefixes(parsed);
      if (globs.length > 0) return globs;
    } catch {
      // Try the next candidate. The embedded fallback below keeps packaged
      // desktop runs from failing when no workspace skills directory exists.
    }
  }
  return [];
}

function extractAllowedSlugPrefixes(doc: FilingRulesDoc): string[] {
  const globs = doc?.dream_synthesize_paths?.globs;
  return Array.isArray(globs) && globs.every((g) => typeof g === 'string')
    ? globs
    : [];
}

async function deriveAllowedSlugPrefixesFromSchemaPack(): Promise<string[]> {
  try {
    const pack = await loadActivePack({ cfg: loadConfig(), remote: false });
    return uniq(
      pack.manifest.page_types
        .filter((pt) => pt.extractable)
        .flatMap((pt) => pt.path_prefixes.map((prefix) => `${prefix}**`)),
    );
  } catch {
    return [];
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}
