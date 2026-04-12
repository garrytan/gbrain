import { extname, posix } from 'path';
import type { LinkInput, LinkReconcileResult } from './types.ts';
import { isSyncable, pathToSlug } from './sync.ts';

export const OBSIDIAN_LINK_TYPE = 'obsidian_link';
export const OBSIDIAN_EMBED_TYPE = 'obsidian_embed';

export interface ObsidianLinkToken {
  raw: string;
  target: string;
  display?: string;
  heading?: string;
  embed: boolean;
  markdown: boolean;
  offset: number;
}

export interface VaultIndexEntry {
  relativePath: string;
  slug: string;
}

export interface VaultIndex {
  entries: VaultIndexEntry[];
  byExact: Map<string, VaultIndexEntry[]>;
  byBasename: Map<string, VaultIndexEntry[]>;
  byExactLower: Map<string, VaultIndexEntry[]>;
  byBasenameLower: Map<string, VaultIndexEntry[]>;
  slugCollisions: Map<string, string[]>;
}

export interface ResolvedObsidianLink {
  token: ObsidianLinkToken;
  status: 'resolved' | 'unresolved' | 'ambiguous' | 'file_embed';
  linkType?: string;
  toSlug?: string;
  toPath?: string;
  candidates?: string[];
}

export interface ObsidianLinkReport {
  filesScanned: number;
  wikilinksFound: number;
  resolved: number;
  unresolved: Array<{ source: string; raw: string; target: string }>;
  ambiguous: Array<{ source: string; raw: string; target: string; candidates: string[] }>;
  fileEmbeds: Array<{ source: string; raw: string; target: string }>;
  slugCollisions: Array<{ slug: string; paths: string[] }>;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  missingSources: string[];
  missingTargets: Array<{ source: string; target: string; toSlug: string }>;
}

export interface DesiredLinksForFile {
  sourcePath: string;
  sourceSlug: string;
  linksByType: Map<string, LinkInput[]>;
  resolved: ResolvedObsidianLink[];
}

export function createEmptyObsidianReport(): ObsidianLinkReport {
  return {
    filesScanned: 0,
    wikilinksFound: 0,
    resolved: 0,
    unresolved: [],
    ambiguous: [],
    fileEmbeds: [],
    slugCollisions: [],
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    missingSources: [],
    missingTargets: [],
  };
}

export function mergeLinkReconcileResult(report: ObsidianLinkReport, result: LinkReconcileResult): void {
  report.added += result.added;
  report.updated += result.updated;
  report.removed += result.removed;
  report.unchanged += result.unchanged;
}

export function buildVaultIndex(relativePaths: string[]): VaultIndex {
  const entries: VaultIndexEntry[] = [];
  const byExact = new Map<string, VaultIndexEntry[]>();
  const byBasename = new Map<string, VaultIndexEntry[]>();
  const byExactLower = new Map<string, VaultIndexEntry[]>();
  const byBasenameLower = new Map<string, VaultIndexEntry[]>();
  const slugToPaths = new Map<string, string[]>();

  for (const path of relativePaths.map(normalizeVaultPath).filter(isSyncable)) {
    const entry = { relativePath: path, slug: pathToSlug(path) };
    entries.push(entry);
    addMap(byExact, stripMarkdownExtension(path), entry);
    addMap(byExact, path, entry);
    addMap(byBasename, basenameWithoutExtension(path), entry);
    addMap(byExactLower, stripMarkdownExtension(path).toLowerCase(), entry);
    addMap(byExactLower, path.toLowerCase(), entry);
    addMap(byBasenameLower, basenameWithoutExtension(path).toLowerCase(), entry);
    addStringMap(slugToPaths, entry.slug, path);
  }

  const slugCollisions = new Map<string, string[]>();
  for (const [slug, paths] of slugToPaths) {
    if (paths.length > 1) slugCollisions.set(slug, paths);
  }

  return { entries, byExact, byBasename, byExactLower, byBasenameLower, slugCollisions };
}

export function extractObsidianLinks(content: string): ObsidianLinkToken[] {
  const masked = maskIgnoredMarkdownRegions(content);
  const links: ObsidianLinkToken[] = [];

  const wikiRe = /(!)?\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiRe.exec(masked))) {
    if (isEscaped(masked, match.index)) continue;
    const raw = content.slice(match.index, match.index + match[0].length);
    const inner = match[2].trim();
    const { target, display } = splitAlias(inner);
    const { pathTarget, heading } = splitHeading(target);
    links.push({
      raw,
      target: pathTarget,
      display,
      heading,
      embed: Boolean(match[1]),
      markdown: false,
      offset: match.index,
    });
  }

  const markdownRe = /(!)?\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  while ((match = markdownRe.exec(masked))) {
    if (isEscaped(masked, match.index)) continue;
    const rawDest = match[3].trim();
    const dest = parseMarkdownDestination(rawDest);
    if (!dest || isExternalDestination(dest)) continue;
    const raw = content.slice(match.index, match.index + match[0].length);
    const decoded = safeDecodeUri(dest);
    const { pathTarget, heading } = splitHeading(decoded);
    links.push({
      raw,
      target: pathTarget,
      display: match[2] || undefined,
      heading,
      embed: Boolean(match[1]),
      markdown: true,
      offset: match.index,
    });
  }

  return links.sort((a, b) => a.offset - b.offset);
}

export function desiredLinksForFile(
  sourceRelativePath: string,
  content: string,
  index: VaultIndex,
  report?: ObsidianLinkReport,
): DesiredLinksForFile {
  const sourcePath = normalizeVaultPath(sourceRelativePath);
  const sourceSlug = pathToSlug(sourcePath);
  const tokens = extractObsidianLinks(content);
  const linksByType = new Map<string, LinkInput[]>();
  const resolved: ResolvedObsidianLink[] = [];

  if (report) {
    report.filesScanned++;
    report.wikilinksFound += tokens.length;
  }

  for (const token of tokens) {
    const r = resolveObsidianLink(sourcePath, token, index);
    resolved.push(r);
    if (r.status === 'resolved' && r.toSlug && r.linkType) {
      const links = linksByType.get(r.linkType) || [];
      links.push({ to_slug: r.toSlug, context: linkContext(token) });
      linksByType.set(r.linkType, links);
      if (report) report.resolved++;
    } else if (report && r.status === 'unresolved') {
      report.unresolved.push({ source: sourcePath, raw: token.raw, target: token.target });
    } else if (report && r.status === 'ambiguous') {
      report.ambiguous.push({
        source: sourcePath,
        raw: token.raw,
        target: token.target,
        candidates: r.candidates || [],
      });
    } else if (report && r.status === 'file_embed') {
      report.fileEmbeds.push({ source: sourcePath, raw: token.raw, target: token.target });
    }
  }

  return { sourcePath, sourceSlug, linksByType, resolved };
}

export function resolveObsidianLink(
  sourceRelativePath: string,
  token: ObsidianLinkToken,
  index: VaultIndex,
): ResolvedObsidianLink {
  const normalizedTarget = normalizeTarget(token.target);
  if (token.embed && hasNonMarkdownExtension(normalizedTarget)) {
    return { token, status: 'file_embed' };
  }

  const sourcePath = normalizeVaultPath(sourceRelativePath);
  const sourceDir = posix.dirname(sourcePath) === '.' ? '' : posix.dirname(sourcePath);
  const candidates: VaultIndexEntry[] = [];

  if (!normalizedTarget) {
    candidates.push(...exactEntries(index, stripMarkdownExtension(sourcePath)));
  } else {
    const targetNoExt = stripMarkdownExtension(normalizedTarget);
    const targetWithExt = hasMarkdownExtension(normalizedTarget) ? normalizedTarget : `${targetNoExt}.md`;

    if (sourceDir && !targetNoExt.includes('/')) {
      candidates.push(...exactEntries(index, `${sourceDir}/${targetNoExt}`));
      candidates.push(...exactEntries(index, `${sourceDir}/${targetWithExt}`));
    }

    candidates.push(...exactEntries(index, targetNoExt));
    candidates.push(...exactEntries(index, targetWithExt));

    if (!targetNoExt.includes('/')) {
      candidates.push(...(index.byBasename.get(targetNoExt) || []));
    }

    if (candidates.length === 0) {
      const lowerCandidates: VaultIndexEntry[] = [];
      if (sourceDir && !targetNoExt.includes('/')) {
        lowerCandidates.push(...(index.byExactLower.get(`${sourceDir}/${targetNoExt}`.toLowerCase()) || []));
        lowerCandidates.push(...(index.byExactLower.get(`${sourceDir}/${targetWithExt}`.toLowerCase()) || []));
      }
      lowerCandidates.push(...(index.byExactLower.get(targetNoExt.toLowerCase()) || []));
      lowerCandidates.push(...(index.byExactLower.get(targetWithExt.toLowerCase()) || []));
      if (!targetNoExt.includes('/')) {
        lowerCandidates.push(...(index.byBasenameLower.get(targetNoExt.toLowerCase()) || []));
      }
      candidates.push(...lowerCandidates);
    }
  }

  const unique = uniqueEntries(candidates);
  if (unique.length === 1) {
    const entry = unique[0];
    return {
      token,
      status: 'resolved',
      linkType: token.embed ? OBSIDIAN_EMBED_TYPE : OBSIDIAN_LINK_TYPE,
      toSlug: entry.slug,
      toPath: entry.relativePath,
    };
  }
  if (unique.length > 1) {
    return { token, status: 'ambiguous', candidates: unique.map(e => e.relativePath) };
  }
  return { token, status: 'unresolved' };
}

export function addSlugCollisionsToReport(index: VaultIndex, report: ObsidianLinkReport): void {
  for (const [slug, paths] of index.slugCollisions) {
    report.slugCollisions.push({ slug, paths });
  }
}

function addMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function addStringMap(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function exactEntries(index: VaultIndex, key: string): VaultIndexEntry[] {
  return index.byExact.get(normalizeVaultPath(key)) || [];
}

function uniqueEntries(entries: VaultIndexEntry[]): VaultIndexEntry[] {
  const seen = new Set<string>();
  const unique: VaultIndexEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.relativePath)) continue;
    seen.add(entry.relativePath);
    unique.push(entry);
  }
  return unique;
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/');
}

function normalizeTarget(target: string): string {
  return normalizeVaultPath(target.trim()).replace(/^\/+/, '');
}

function stripMarkdownExtension(path: string): string {
  return normalizeVaultPath(path).replace(/\.mdx?$/i, '');
}

function basenameWithoutExtension(path: string): string {
  return posix.basename(stripMarkdownExtension(path));
}

function hasMarkdownExtension(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

function hasNonMarkdownExtension(path: string): boolean {
  const ext = extname(path);
  return ext !== '' && !hasMarkdownExtension(path);
}

function splitAlias(inner: string): { target: string; display?: string } {
  const idx = inner.indexOf('|');
  if (idx === -1) return { target: inner.trim() };
  return {
    target: inner.slice(0, idx).trim(),
    display: inner.slice(idx + 1).trim() || undefined,
  };
}

function splitHeading(target: string): { pathTarget: string; heading?: string } {
  const idx = target.indexOf('#');
  if (idx === -1) return { pathTarget: target.trim() };
  return {
    pathTarget: target.slice(0, idx).trim(),
    heading: target.slice(idx + 1).trim() || undefined,
  };
}

function linkContext(token: ObsidianLinkToken): string {
  const parts = [token.raw];
  if (token.display) parts.push(`alias: ${token.display}`);
  if (token.heading) parts.push(`anchor: ${token.heading}`);
  return parts.join(' | ');
}

function parseMarkdownDestination(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('<')) {
    const end = raw.indexOf('>');
    return end === -1 ? null : raw.slice(1, end);
  }
  return raw.split(/\s+/)[0] || null;
}

function isExternalDestination(dest: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(dest);
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isEscaped(content: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

function maskIgnoredMarkdownRegions(content: string): string {
  const chars = content.split('');
  const maskRange = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };

  if (content.startsWith('---')) {
    const frontmatterEnd = content.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
    if (frontmatterEnd?.[0]) maskRange(0, frontmatterEnd[0].length);
  }

  for (const match of content.matchAll(/<!--[\s\S]*?-->/g)) {
    maskRange(match.index || 0, (match.index || 0) + match[0].length);
  }

  const lines = content.split('\n');
  let offset = 0;
  let fenceStart: number | null = null;
  let fenceMarker: string | null = null;
  for (const line of lines) {
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[2][0];
      if (fenceStart === null) {
        fenceStart = offset;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        maskRange(fenceStart, offset + line.length);
        fenceStart = null;
        fenceMarker = null;
      }
    }
    offset += line.length + 1;
  }
  if (fenceStart !== null) maskRange(fenceStart, content.length);

  for (const match of content.matchAll(/`[^`\n]*`/g)) {
    maskRange(match.index || 0, (match.index || 0) + match[0].length);
  }

  return chars.join('');
}
