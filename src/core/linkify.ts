/**
 * Pure functions for gbrain linkify. No I/O, no DB, no engine — takes a
 * pre-built alias map and config; returns rewritten text plus diagnostics.
 *
 * See: docs/superpowers/specs/2026-05-15-gbrain-linkify-design.md
 */

export type AliasMap = Map<string, Set<string>>;

export interface PageMeta {
  slug: string;
  name: string;
  domain: string | null;
  isAutoStub: boolean;
}

export interface LinkifyConfig {
  defaultDomains: string[];
  stopwords: Set<string>;
  firstMentionOnly: boolean;
}
// Note: `dryRun` is intentionally NOT in LinkifyConfig — linkifyMarkdown is
// a pure text rewriter that never writes files. Dry-run is a CLI-level
// concern handled in runLinkify against opts.dryRun.

export type Diagnostic =
  | { kind: 'resolved_by_default_domain'; match: string; chosen: string; rejected: string[]; occurrences: number }
  | { kind: 'ambiguous_unresolved'; match: string; candidates: string[]; occurrences: number }
  | { kind: 'auto_stub_excluded_total'; count: number }
  | { kind: 'stopword_dropped_all_keys'; slug: string; name: string }
  | { kind: 'malformed_frontmatter'; slug: string; field: string; reason: string }
  | { kind: 'concurrent_modification_skipped'; file: string }
  | { kind: 'icloud_placeholder_skipped'; file: string }
  | { kind: 'enoent'; file: string };

export interface LinkifyResult {
  text: string;
  diagnostics: Diagnostic[];
  counts: { linked: number; ambiguous: number; uniquePeople: Set<string> };
}

const BOUNDARY_LEFT = "(?<![\\p{L}\\p{N}_'\\u2019])";
const BOUNDARY_RIGHT = "(?![\\p{L}\\p{N}_])";

export function linkifyMarkdown(
  markdown: string,
  aliasMap: AliasMap,
  pageMeta: Map<string, PageMeta>,
  config: LinkifyConfig,
): LinkifyResult {
  void pageMeta;
  void config;
  const diagnostics: Diagnostic[] = [];
  const uniquePeople = new Set<string>();
  let linked = 0;
  let ambiguous = 0;
  if (aliasMap.size === 0) return { text: markdown, diagnostics, counts: { linked, ambiguous, uniquePeople } };

  const keys = Array.from(aliasMap.keys()).sort((a, b) => b.length - a.length);
  const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = BOUNDARY_LEFT + '(' + escaped.join('|') + ')' + BOUNDARY_RIGHT;
  const re = new RegExp(pattern, 'giu');

  const parts: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const match = m[0];
    const key = match.toLowerCase();
    const slugs = aliasMap.get(key);
    parts.push(markdown.slice(cursor, m.index));
    if (slugs && slugs.size === 1) {
      const slug = Array.from(slugs)[0];
      parts.push(`[[${slug}|${match}]]`);
      linked++;
      uniquePeople.add(slug);
    } else {
      parts.push(match);
      if (slugs && slugs.size > 1) ambiguous++;
    }
    cursor = m.index + match.length;
  }
  parts.push(markdown.slice(cursor));
  return { text: parts.join(''), diagnostics, counts: { linked, ambiguous, uniquePeople } };
}
