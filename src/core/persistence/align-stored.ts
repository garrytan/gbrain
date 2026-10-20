import { resolveParsedSubtype, type ParsedMarkdown } from '../markdown.ts';

/**
 * Aligns a canonical file's parse with what its import over `stored` keeps (#1035, #5521): a file without an explicit
 * `type:` (or whose type was only inferred from its path, #6605) keeps the stored type, and the subtype is resolved
 * against that type, so the stored subtype is kept too. Import does the same, in this order. The write guard
 * (page-prepare.ts) and reconcile (reconcile-state.ts, reconcile-prepare.ts) share it.
 */
export function alignWithStored(parsed: ParsedMarkdown, stored: { type: string; frontmatter?: Record<string, unknown> | null }, inferred: boolean): void {
  if (inferred || !parsed.typeExplicit) parsed.type = stored.type as ParsedMarkdown['type'];
  resolveParsedSubtype(parsed, stored);
}
