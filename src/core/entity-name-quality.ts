/**
 * #4222 — shared generic-token reject list for entity-name quality gating.
 *
 * Over-eager extractors mint entity pages from generic English tokens
 * ("Will", "Info", "Chief", "Unknown") and bare @handles. Once minted, the
 * by-mention auto-linker treats them as real entities and every body-text
 * occurrence of the word accretes another edge — a near-empty page with
 * thousands of links (a "junk hub") that poisons graph signals and
 * relational recall.
 *
 * One list, three consumers (keep them in sync by importing from HERE):
 *   - `enrichEntity` (src/core/enrichment-service.ts) refuses to MINT a
 *     page for a junk name. Existing pages stay trusted (CK12 precedent:
 *     a user-created page is authoritative even if the title is on the
 *     list) — only creation is gated.
 *   - `buildGazetteer` (src/core/by-mention.ts) drops single-generic-token
 *     PERSON titles so an already-minted junk page stops accreting edges.
 *   - The `junk_entity_hubs` doctor check (warn + list, never auto-delete)
 *     surfaces hubs that predate these gates.
 *
 * Scope discipline: the list gates SINGLE-token names only. "Will Smith"
 * is never affected — multi-token names bypass every consumer's check.
 * Comparisons are case-insensitive.
 */

/**
 * Lowercase single tokens that are almost never a real entity's full name.
 * Conservative by design: each entry must be a word whose standalone
 * appearance in prose is overwhelmingly NOT a reference to a specific
 * person/company. When in doubt, leave it out — a missed junk token is a
 * doctor warning; an over-broad one silently suppresses a real entity.
 */
export const GENERIC_ENTITY_TOKENS: ReadonlySet<string> = new Set([
  // The observed junk-hub names from #4222.
  'will', 'something', 'info', 'chief', 'unknown', 'readme', 'founders',
  // Same class: role/collective words extractors capitalize into "names".
  'founder', 'team', 'staff', 'everyone', 'someone', 'anyone', 'people',
  'person', 'company', 'admin', 'user', 'users', 'contact', 'support',
  // Document/structure words that title-case into candidates.
  'update', 'updates', 'note', 'notes', 'meeting', 'meetings', 'summary',
  'general', 'misc', 'other', 'various', 'agenda', 'minutes', 'draft',
  'welcome', 'hello', 'thanks', 'inbox', 'untitled', 'unnamed',
  // Placeholder tokens.
  'none', 'null', 'undefined', 'test', 'todo', 'tbd',
]);

/** Case-insensitive membership test against GENERIC_ENTITY_TOKENS. */
export function isGenericEntityToken(token: string): boolean {
  return GENERIC_ENTITY_TOKENS.has(token.trim().toLowerCase());
}

/** Bare social/@-mention handle, e.g. `@alice_dev` — not a display name. */
const BARE_HANDLE_RE = /^@\S+$/;

/**
 * Should this name be refused as a NEW entity page? True for a single
 * generic token or a bare @handle. Multi-word names always pass.
 */
export function isJunkEntityName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (BARE_HANDLE_RE.test(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  return words.length === 1 && isGenericEntityToken(words[0]!);
}
