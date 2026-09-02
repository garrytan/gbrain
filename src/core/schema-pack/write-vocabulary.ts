// #4655 — write-time pack vocabulary enforcement helpers.
//
// Best-effort loader + fail-loud membership checks shared by the write
// surfaces (capture op, add_link op, `gbrain capture` CLI). Contract:
//   - Pack resolves → an EXPLICIT undeclared name (page type / link verb)
//     is rejected with an error that names the pack AND its declared
//     vocabulary, so agents can self-correct without a round-trip to
//     `gbrain schema explain`.
//   - Pack cannot be resolved (missing, corrupt, trust-gated) → null →
//     the write proceeds exactly as before. #4655 asks for enforcement
//     where a vocabulary exists, not a new way for writes to fail.
//   - The DEFAULT 'note' path is never checked through these helpers —
//     callers only validate EXPLICIT names (flag / param / frontmatter),
//     so bare `gbrain capture` keeps working even under a pack that does
//     not declare 'note'.

import { loadConfigFileOnly } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { loadActivePack } from './load-active.ts';
import type { ResolvedPack } from './registry.ts';

export interface WriteVocabularyContext {
  engine: Pick<BrainEngine, 'getConfig'>;
  /** Fail-closed trust: anything not strictly false is treated as remote. */
  remote: boolean | undefined;
  sourceId?: string;
}

/**
 * Resolve the active pack for write-time vocabulary checks. Pairs the
 * engine's DB-plane `schema_pack` key with FILE-ONLY config (the
 * `loadActivePackForLocalEngine` posture — a post-unify DB-side pack flip
 * stays visible) while still threading `remote` (fail-closed) + `sourceId`
 * from the operation context. Never throws; null = "no resolvable pack",
 * which callers MUST treat as "no vocabulary to enforce".
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

/** Bounded preview so a giant pack can't flood an error envelope. */
function previewNames(names: readonly string[]): string {
  if (names.length === 0) return 'none declared';
  const shown = names.slice(0, 12);
  const suffix = names.length > shown.length ? `, … (${names.length} total)` : '';
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
