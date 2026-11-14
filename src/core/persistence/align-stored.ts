import { inferTypeFromPack, resolveParsedSubtype, type ParsedMarkdown } from '../markdown.ts';

/**
 * Aligns a canonical file's parse with what its import over `stored` keeps (#1035, #5521): a file without an explicit
 * `type:` (or whose type was only inferred from its path, #6605) keeps the stored type, and the subtype is resolved
 * against that type, so the stored subtype is kept too, and so are the stamps only the database holds (`keepStoredOnlyStamps`). Import over an existing
 * page (import-file.ts), the write guard (page-prepare.ts) and reconcile (reconcile-state.ts, reconcile-prepare.ts) share it.
 * A file that still names the type a schema-pack retype replaced keeps the retyped page's type and stamp (`keepRetypeStamp`);
 * content a caller writes with no file behind it (import-file.ts without `sourcePath`: `put_page`) passes `retypeStamp` false and is
 * read as written, so an explicit type there still wins.
 */
export function alignWithStored(parsed: ParsedMarkdown, stored: { type: string; frontmatter?: Record<string, unknown> | null }, inferred: boolean, retypeStamp = true, write = false): void {
  if (!(retypeStamp && (keepRetypeStamp(parsed, stored) || keepPackRenamedType(parsed, stored, write))) && (inferred || !parsed.typeExplicit)) parsed.type = stored.type as ParsedMarkdown['type'];
  resolveParsedSubtype(parsed, stored);
  keepStoredOnlyStamps(parsed, stored, retypeStamp);
}

/** Sync's reading of a file over the stored page (sync-prepare.ts): the retype stamp, the subtype and the database-only stamps kept as `alignWithStored` keeps them; an explicit file type is otherwise read as written. */
export function keepStoredStamps(parsed: ParsedMarkdown, stored?: { type: string; frontmatter?: Record<string, unknown> | null } | null): void {
  if (!keepRetypeStamp(parsed, stored)) keepPackRenamedType(parsed, stored, true);
  resolveParsedSubtype(parsed, stored);
  keepStoredOnlyStamps(parsed, stored);
}

/**
 * GST-2603: the stamps gbrain wrote into a page's stored frontmatter and never into its file, kept for a file that carries
 * none of its own, so every file-versus-page comparison (page-prepare.ts fileMatchesSnapshot, labelEditFile) and every
 * import of the file reads them the same way: the grandfather stamp (`keepGrandfatherStamp`), and with `retypeRecord` the
 * rollback record of a schema-pack retype (`legacy_type`, the type the page had) once the file's type is the page's type
 * (a file that still names the old type keeps it through `keepRetypeStamp`). A file that writes `legacy_type` itself, or
 * names another type, is read as written. Call it after the parse's type is aligned.
 */
export function keepStoredOnlyStamps(parsed: ParsedMarkdown, stored?: { type: string; frontmatter?: Record<string, unknown> | null } | null, retypeRecord = true): void {
  keepGrandfatherStamp(parsed.frontmatter, stored);
  const legacy = stored?.frontmatter?.legacy_type;
  if (retypeRecord && stored && typeof legacy === 'string' && legacy !== stored.type && parsed.type === stored.type && !Object.hasOwn(parsed.frontmatter, 'legacy_type')) {
    parsed.frontmatter.legacy_type = legacy;
  }
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
 * GST-2584: a page type gbrain itself named and later renamed. Before #6454 an import kept the reserved `type` key in the
 * stored frontmatter, and gbrain wrote that type into the file, with the name gbrain-base 1.0.0 infers from the path
 * (`writing/` is `writing`). A later pack infers another type for the same path and the column took it, so the file and the
 * stored copy still say the 1.0.0 name. A file whose explicit type is that name, equal to the stored copy and to what
 * gbrain-base 1.0.0 infers for its path, while the column says otherwise, is the page as renamed: it keeps the stored type.
 * Any other explicit type (a person's) is read as written. A write (`write`) records the rename as a retype stamp
 * (`legacy_type`: the 1.0.0 name), because the stored copy does not survive the import, so every later import keeps the type
 * through `keepRetypeStamp`; a comparison only reads it. Returns whether the stored type was kept.
 */
export function keepPackRenamedType(parsed: ParsedMarkdown, stored?: { type: string; frontmatter?: Record<string, unknown> | null } | null, write = false): boolean {
  const copy = stored?.frontmatter?.type;
  if (!stored || parsed.typeExplicit !== true || typeof copy !== 'string' || parsed.type !== copy || parsed.type === stored.type || inferTypeFromPack(parsed.slug, { page_types: [] }) !== parsed.type) return false;
  parsed.type = stored.type as ParsedMarkdown['type'];
  if (write) parsed.frontmatter.legacy_type = copy;
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
