import { resolveParsedSubtype, type ParsedMarkdown } from '../markdown.ts';

/**
 * Aligns a canonical file's parse with what its import over `stored` keeps (#1035, #5521): a file without an explicit
 * `type:` (or whose type was only inferred from its path, #6605) keeps the stored type, and the subtype is resolved
 * against that type, so the stored subtype is kept too, and so is the grandfather stamp (#6429). Import over an existing
 * page (import-file.ts), the write guard (page-prepare.ts) and reconcile (reconcile-state.ts, reconcile-prepare.ts) share it.
 */
export function alignWithStored(parsed: ParsedMarkdown, stored: { type: string; frontmatter?: Record<string, unknown> | null }, inferred: boolean): void {
  if (inferred || !parsed.typeExplicit) parsed.type = stored.type as ParsedMarkdown['type'];
  resolveParsedSubtype(parsed, stored);
  keepGrandfatherStamp(parsed.frontmatter, stored);
}

/**
 * #6429: the v0.13.1 grandfather stamped `validate: false` into the database; on an unmanaged brain that path never wrote
 * the file, so the file lacks a key the database carries. The mechanical stamp authors nothing (grandfather.ts): a file
 * without a `validate:` key keeps the stored stamp. GBRA-133: import and sync compare and store it the same way as the
 * write guard, so a legacy page carrying the stamp is not a database edit sync cannot place.
 */
export function keepGrandfatherStamp(frontmatter: Record<string, unknown>, existing?: { frontmatter?: Record<string, unknown> | null } | null): void {
  if (!Object.hasOwn(frontmatter, 'validate') && existing?.frontmatter?.validate === false) frontmatter.validate = false;
}
