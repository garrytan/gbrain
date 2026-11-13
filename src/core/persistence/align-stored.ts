import { resolveParsedSubtype, type ParsedMarkdown } from '../markdown.ts';

/**
 * Aligns a canonical file's parse with what its import over `stored` keeps (#1035, #5521): a file without an explicit
 * `type:` (or whose type was only inferred from its path, #6605) keeps the stored type, and the subtype is resolved
 * against that type, so the stored subtype is kept too, and so is the grandfather stamp (#6429). Import over an existing
 * page (import-file.ts), the write guard (page-prepare.ts) and reconcile (reconcile-state.ts, reconcile-prepare.ts) share it.
 * A file that still names the type a schema-pack retype replaced keeps the retyped page's type and stamp (`keepRetypeStamp`);
 * content a caller writes with no file behind it (import-file.ts without `sourcePath`: `put_page`) passes `retypeStamp` false and is
 * read as written, so an explicit type there still wins.
 */
export function alignWithStored(parsed: ParsedMarkdown, stored: { type: string; frontmatter?: Record<string, unknown> | null }, inferred: boolean, retypeStamp = true): void {
  if (!(retypeStamp && keepRetypeStamp(parsed, stored)) && (inferred || !parsed.typeExplicit)) parsed.type = stored.type as ParsedMarkdown['type'];
  resolveParsedSubtype(parsed, stored);
  keepGrandfatherStamp(parsed.frontmatter, stored);
}

/** Sync's reading of a file over the stored page (sync-prepare.ts): the retype stamp, the subtype and the grandfather stamp kept as `alignWithStored` keeps them; an explicit file type is otherwise read as written. */
export function keepStoredStamps(parsed: ParsedMarkdown, stored?: { type: string; frontmatter?: Record<string, unknown> | null } | null): void {
  keepRetypeStamp(parsed, stored);
  resolveParsedSubtype(parsed, stored);
  keepGrandfatherStamp(parsed.frontmatter, stored);
}

/**
 * GST-2568: a schema-pack retype (schema-pack/retype.ts, run by unify-types) changes `pages.type` from `from_type` to
 * `to_type` and stamps `legacy_type: <from_type>` (D8, its per-page rollback record), and optionally a `subtype`, in the
 * database only; it never writes the file. A file that still names `from_type` and carries no `legacy_type` of its own
 * is that page as retyped, so it keeps the stored type and stamp; the stored subtype then follows through
 * `resolveParsedSubtype` (the types now agree). A file that names any other type, or writes `legacy_type` itself, is
 * read as written. Returns whether the stamp was kept.
 */
export function keepRetypeStamp(parsed: ParsedMarkdown, stored?: { type: string; frontmatter?: Record<string, unknown> | null } | null): boolean {
  const legacy = stored?.frontmatter?.legacy_type;
  if (!stored || typeof legacy !== 'string' || Object.hasOwn(parsed.frontmatter, 'legacy_type') || parsed.type !== legacy) return false;
  parsed.type = stored.type as ParsedMarkdown['type'];
  parsed.frontmatter.legacy_type = legacy;
  return true;
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
