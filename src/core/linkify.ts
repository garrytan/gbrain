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

export interface BuildAliasMapResult {
  aliasMap: AliasMap;
  pageMeta: Map<string, PageMeta>;
  startupDiagnostics: Diagnostic[];
}

const APOSTROPHE_STRAIGHT = "'";
const APOSTROPHE_CURLY = "’"; // U+2019 right single quotation mark

function caseFold(s: string): string { return s.normalize('NFC').toLowerCase(); }

function expandApostropheVariants(key: string): string[] {
  const hasStraight = key.indexOf(APOSTROPHE_STRAIGHT) !== -1;
  const hasCurly = key.indexOf(APOSTROPHE_CURLY) !== -1;
  if (!hasStraight && !hasCurly) return [key];
  const variants = new Set<string>([key]);
  if (hasStraight) variants.add(key.split(APOSTROPHE_STRAIGHT).join(APOSTROPHE_CURLY));
  if (hasCurly) variants.add(key.split(APOSTROPHE_CURLY).join(APOSTROPHE_STRAIGHT));
  return Array.from(variants);
}

export async function buildAliasMap(
  engine: {
    queryPersonsForLinkify(): Promise<Array<{
      slug: string;
      type: string;
      frontmatter: Record<string, unknown>;
      isAutoStub: boolean;
    }>>;
    countAutoStubsExcludedFromLinkify(): Promise<number>;
  },
  config: LinkifyConfig,
): Promise<BuildAliasMapResult> {
  const rows = await engine.queryPersonsForLinkify();
  const aliasMap: AliasMap = new Map();
  const pageMeta = new Map<string, PageMeta>();
  const startupDiagnostics: Diagnostic[] = [];

  function addKey(key: string, slug: string): boolean {
    const folded = caseFold(key);
    if (config.stopwords.has(folded)) return false;
    for (const variant of expandApostropheVariants(folded)) {
      let set = aliasMap.get(variant);
      if (!set) { set = new Set(); aliasMap.set(variant, set); }
      set.add(slug);
    }
    return true;
  }

  for (const row of rows) {
    // Apply the same auto-stub polarity rule the SQL filter enforces. The mock
    // engine in tests bypasses the SQL filter, so this is load-bearing — not
    // pure defense. Rule: auto-stub pages excluded unless linkable: true;
    // any page with linkable: false (string or bool) excluded regardless.
    const linkable = (row.frontmatter ?? {}).linkable;
    const isOptedOut = linkable === 'false' || linkable === false;
    if (isOptedOut) continue;
    if (row.isAutoStub && linkable !== 'true' && linkable !== true) continue;
    const fm = row.frontmatter ?? {};
    const name = typeof fm.name === 'string' ? fm.name.trim() : '';
    if (!name) {
      if (fm.name !== undefined) {
        startupDiagnostics.push({ kind: 'malformed_frontmatter', slug: row.slug, field: 'name', reason: 'not a non-empty string' });
      }
      continue;
    }
    const domain = typeof fm.domain === 'string' ? fm.domain.trim().toLowerCase() : null;
    pageMeta.set(row.slug, { slug: row.slug, name, domain, isAutoStub: row.isAutoStub });

    const tokens = name.split(/\s+/).filter(Boolean);
    const derived: string[] = [name];
    if (tokens.length > 0) derived.push(tokens[0]);
    if (tokens.length > 1) derived.push(tokens[tokens.length - 1]);

    if (Array.isArray(fm.linkify_aliases)) {
      for (const a of fm.linkify_aliases) {
        if (typeof a === 'string' && a.trim()) derived.push(a.trim());
        else startupDiagnostics.push({ kind: 'malformed_frontmatter', slug: row.slug, field: 'linkify_aliases', reason: 'non-string entry' });
      }
    }

    let anyAdded = false;
    for (const k of derived) if (addKey(k, row.slug)) anyAdded = true;
    if (!anyAdded) startupDiagnostics.push({ kind: 'stopword_dropped_all_keys', slug: row.slug, name });
  }

  const autoStubExcluded = await engine.countAutoStubsExcludedFromLinkify();
  startupDiagnostics.push({ kind: 'auto_stub_excluded_total', count: autoStubExcluded });

  return { aliasMap, pageMeta, startupDiagnostics };
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
