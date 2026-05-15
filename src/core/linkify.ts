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

function bumpDiag(diagnostics: Diagnostic[], d: Diagnostic) {
  const dKey = JSON.stringify({
    kind: d.kind,
    match: 'match' in d ? d.match : undefined,
    candidates: 'candidates' in d ? d.candidates : undefined,
    chosen: 'chosen' in d ? d.chosen : undefined,
    rejected: 'rejected' in d ? d.rejected : undefined,
  });
  for (const existing of diagnostics) {
    const eKey = JSON.stringify({
      kind: existing.kind,
      match: 'match' in existing ? existing.match : undefined,
      candidates: 'candidates' in existing ? existing.candidates : undefined,
      chosen: 'chosen' in existing ? existing.chosen : undefined,
      rejected: 'rejected' in existing ? existing.rejected : undefined,
    });
    if (eKey === dKey && 'occurrences' in existing && 'occurrences' in d) {
      (existing as { occurrences: number }).occurrences += d.occurrences;
      return;
    }
  }
  diagnostics.push(d);
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
    } else if (slugs && slugs.size > 1) {
      const defaultDomainSet = new Set(config.defaultDomains);
      const inDefault: string[] = [];
      const outOfDefault: string[] = [];
      for (const s of slugs) {
        const dom = pageMeta.get(s)?.domain;
        if (dom && defaultDomainSet.has(dom)) inDefault.push(s);
        else outOfDefault.push(s);
      }
      if (inDefault.length === 1) {
        const chosen = inDefault[0];
        parts.push(`[[${chosen}|${match}]]`);
        linked++;
        uniquePeople.add(chosen);
        bumpDiag(diagnostics, { kind: 'resolved_by_default_domain', match: key, chosen, rejected: outOfDefault, occurrences: 1 });
      } else {
        parts.push(match);
        ambiguous++;
        bumpDiag(diagnostics, { kind: 'ambiguous_unresolved', match: key, candidates: Array.from(slugs).sort(), occurrences: 1 });
      }
    } else {
      // No match in alias map (regex matched but key not present), or empty Set
      parts.push(match);
    }
    cursor = m.index + match.length;
  }
  parts.push(markdown.slice(cursor));
  return { text: parts.join(''), diagnostics, counts: { linked, ambiguous, uniquePeople } };
}
