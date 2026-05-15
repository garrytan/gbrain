/**
 * Pure functions for gbrain linkify. No I/O, no DB, no engine — takes a
 * pre-built alias map and config; returns rewritten text plus diagnostics.
 *
 * See: docs/superpowers/specs/2026-05-15-gbrain-linkify-design.md
 */

import { stripCodeBlocks, WIKILINK_RE, QUALIFIED_WIKILINK_RE } from './link-extraction.ts';

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

function maskSkipZones(content: string): string {
  let masked = content;
  // Frontmatter
  const fmMatch = /^---\n[\s\S]*?\n---\n/.exec(masked);
  if (fmMatch) masked = ' '.repeat(fmMatch[0].length) + masked.slice(fmMatch[0].length);
  // Fenced + inline code
  masked = stripCodeBlocks(masked);
  // Qualified + unqualified wikilinks
  for (const re of [QUALIFIED_WIKILINK_RE, WIKILINK_RE]) {
    re.lastIndex = 0;
    masked = masked.replace(re, (m) => ' '.repeat(m.length));
  }
  // Markdown links
  masked = masked.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => ' '.repeat(m.length));
  // Bare URLs
  masked = masked.replace(/https?:\/\/\S+/g, (m) => ' '.repeat(m.length));
  // Email addresses
  masked = masked.replace(/\S+@[\w.-]+/g, (m) => ' '.repeat(m.length));
  return masked;
}

export function linkifyMarkdown(
  markdown: string,
  aliasMap: AliasMap,
  pageMeta: Map<string, PageMeta>,
  config: LinkifyConfig,
): LinkifyResult {
  const diagnostics: Diagnostic[] = [];
  const uniquePeople = new Set<string>();
  let linked = 0;
  let ambiguous = 0;
  if (aliasMap.size === 0) return { text: markdown, diagnostics, counts: { linked, ambiguous, uniquePeople } };

  const keys = Array.from(aliasMap.keys()).sort((a, b) => b.length - a.length);
  const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = BOUNDARY_LEFT + '(' + escaped.join('|') + ')' + BOUNDARY_RIGHT;
  const re = new RegExp(pattern, 'giu');

  const masked = maskSkipZones(markdown);
  const parts: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const match = markdown.slice(m.index, m.index + m[0].length);
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
