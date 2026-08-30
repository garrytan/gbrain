import { loadConfigFileOnly } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { loadActivePack } from './load-active.ts';
import type { ResolvedPack } from './registry.ts';

export interface WriteVocabularyContext {
  engine: Pick<BrainEngine, 'getConfig'>;
  remote: boolean | undefined;
  sourceId?: string;
}

/**
 * Resolve the active pack for write-time vocabulary checks.
 *
 * This is deliberately best-effort: legacy write paths already tolerate a
 * missing or broken pack, but when a pack resolves, explicit vocabulary values
 * should not mint undeclared page types or link verbs.
 */
export async function loadActivePackForWriteVocabulary(
  ctx: WriteVocabularyContext,
): Promise<ResolvedPack | null> {
  let dbConfig: string | undefined;
  try {
    dbConfig = (await ctx.engine.getConfig('schema_pack'))?.trim() || undefined;
  } catch {
    dbConfig = undefined;
  }

  try {
    return await loadActivePack({
      cfg: loadConfigFileOnly(),
      remote: ctx.remote === false ? false : true,
      sourceId: ctx.sourceId,
      dbConfig,
    });
  } catch {
    return null;
  }
}

export function packDeclaresPageType(pack: ResolvedPack, typeName: string): boolean {
  return pack.manifest.page_types.some((t) => t.name === typeName);
}

export function packDeclaresLinkType(pack: ResolvedPack, linkType: string): boolean {
  return pack.manifest.link_types.some((t) => t.name === linkType);
}

function previewNames(names: readonly string[]): string {
  if (names.length === 0) return 'none declared';
  const shown = names.slice(0, 12);
  const suffix = names.length > shown.length ? `, ... (${names.length} total)` : '';
  return `${shown.join(', ')}${suffix}`;
}

export function undeclaredPageTypeMessage(typeName: string, pack: ResolvedPack, surface: string): string {
  return `${surface}: page type '${typeName}' is not declared in active schema pack '${pack.manifest.name}'.`;
}

export function undeclaredPageTypeSuggestion(pack: ResolvedPack): string {
  const names = pack.manifest.page_types.map((t) => t.name).sort();
  return `Use a declared page type (${previewNames(names)}), or add this type to the active schema pack before writing.`;
}

export function undeclaredLinkTypeMessage(linkType: string, pack: ResolvedPack, surface: string): string {
  return `${surface}: link type '${linkType}' is not declared in active schema pack '${pack.manifest.name}'.`;
}

export function undeclaredLinkTypeSuggestion(pack: ResolvedPack): string {
  const names = pack.manifest.link_types.map((t) => t.name).sort();
  return `Use a declared link type (${previewNames(names)}), or add this link type to the active schema pack before writing.`;
}
