/**
 * Stored-type classification against the active schema pack.
 *
 * Motivation (alias-footgun incident class): an agent writes an explicit
 * frontmatter `type:` that is either an ALIAS of a canonical type or entirely
 * UNDECLARED in the pack. gbrain stores the string literally and never
 * re-normalizes it (import-file.ts type preservation), so the misrouting is
 * silent — different agents file the same concept under different types and
 * directories, and nobody notices until retrieval quality degrades. gbrain
 * cannot stop agent-side filing decisions, but it CAN make every non-canonical
 * explicit type loud at ingest (sync/import summary + SyncResult) and at audit
 * (`gbrain schema lint` data-plane rules).
 *
 * The pack parameter is structural (name + aliases + path_prefixes only) so
 * import-file can pass its thin activePack shape; the full SchemaPackManifest
 * satisfies it too.
 */

export interface TypeUsagePack {
  page_types: ReadonlyArray<{
    name: string;
    path_prefixes: ReadonlyArray<string>;
    aliases?: ReadonlyArray<string>;
  }>;
}

export type StoredTypeClass =
  | { kind: 'canonical' }
  | { kind: 'alias_of'; canonical: string; directory?: string }
  | { kind: 'undeclared' };

/**
 * Classify an explicit stored type against the pack: canonical page_type name,
 * alias of one (reports the canonical type + its filing directory =
 * path_prefixes[0]), or undeclared.
 */
export function classifyStoredType(type: string, pack: TypeUsagePack): StoredTypeClass {
  for (const pt of pack.page_types) {
    if (pt.name === type) return { kind: 'canonical' };
  }
  for (const pt of pack.page_types) {
    if (pt.aliases && pt.aliases.includes(type)) {
      return {
        kind: 'alias_of',
        canonical: pt.name,
        directory: pt.path_prefixes[0],
      };
    }
  }
  return { kind: 'undeclared' };
}

/**
 * Type strings come from user/agent frontmatter and get echoed into terminal
 * warnings — strip control/non-printable characters (ANSI-escape hygiene) and
 * cap the length so a hostile or garbled value can't mangle the terminal.
 */
export function sanitizeTypeForDisplay(type: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = type.replace(/[\x00-\x1f\x7f]/g, '');
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

/**
 * Stricter gate for embedding a type into a COPY-PASTEABLE command hint
 * (`gbrain schema add-type '<t>'`): display sanitization keeps quotes and
 * shell metacharacters, so a type like `x'; touch pwn; #` would escape the
 * quoting when an operator pastes the hint. Returns the value only when it
 * is a plain slug-safe token; callers render a placeholder otherwise.
 */
export function safeCliToken(v: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) ? v : null;
}

/** One aggregated warning bucket per distinct non-canonical type. */
export interface TypeWarningCount {
  kind: 'alias_of' | 'undeclared';
  type: string;
  canonical?: string;
  directory?: string;
  count: number;
}

/**
 * Render the once-per-type-per-run summary lines for a sync/import run.
 * Returns [] when there is nothing to say.
 */
export function renderTypeWarningSummary(warnings: ReadonlyArray<TypeWarningCount>): string[] {
  const lines: string[] = [];
  for (const w of warnings) {
    const t = sanitizeTypeForDisplay(w.type);
    if (w.kind === 'alias_of') {
      const dir = w.directory ? ` (pages file under ${sanitizeTypeForDisplay(w.directory)})` : '';
      lines.push(
        `⚠ type '${t}' is an alias of '${sanitizeTypeForDisplay(w.canonical ?? '')}'${dir}: ` +
        `${w.count} file(s) used it explicitly — agents may route it inconsistently. ` +
        `Declare it as a page type or retype (gbrain schema --help).`,
      );
    } else {
      lines.push(
        `⚠ type '${t}' is not declared in the active schema pack: ${w.count} file(s) — ` +
        `stored as-is. Declare it (gbrain schema add-type) or use a canonical type.`,
      );
    }
  }
  return lines;
}
