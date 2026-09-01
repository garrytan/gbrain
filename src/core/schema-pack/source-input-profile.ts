import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ResolvedPack } from './registry.ts';
import { getExtractableSpec } from './extractable.ts';

export const ATOM_INPUT_PROFILE_VERSION = 'gbrain.extract_atoms.input_profile.v1' as const;

const AtomInputProfileSchema = z.object({
  schema_version: z.literal(ATOM_INPUT_PROFILE_VERSION),
  source: z.literal('compiled_truth'),
  selector: z.string().regex(/^heading:[^\r\n]+$/u),
  prior_interpretation: z.literal('exclude'),
  windowing: z.object({
    mode: z.literal('markdown_heading_and_turn_aware'),
    max_chars: z.number().int().min(1_000).max(200_000),
    overlap_chars: z.number().int().min(0),
    coverage: z.literal('complete'),
  }).strict(),
  reconciliation_grain: z.literal('parent_page'),
  evidence_anchor_validation: z.literal('exact_source_anchor_required'),
  /** Pack-owned governance/audit labels. Runtime behavior never branches on
   * these values, but the exact file bytes remain profile-hashed. */
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.windowing.overlap_chars >= value.windowing.max_chars) {
    ctx.addIssue({
      code: 'custom',
      path: ['windowing', 'overlap_chars'],
      message: 'overlap_chars must be smaller than max_chars',
    });
  }
});

export type AtomInputProfile = z.infer<typeof AtomInputProfileSchema>;

export interface ResolvedAtomInputProfile {
  page_type: string;
  pack_identity: string;
  declaring_pack: string;
  profile_path: string;
  profile_sha256: string;
  profile: AtomInputProfile;
}

export interface AtomSourceWindow {
  index: number;
  start: number;
  end: number;
  text: string;
  sha256: string;
  evidence_anchors: string[];
}

export interface PreparedAtomSource {
  selected_source: string;
  source_section_sha256: string;
  source_start: number;
  source_end: number;
  windows: AtomSourceWindow[];
  evidence_anchors: string[];
  coverage_sha256: string;
}

const EVIDENCE_ANCHOR_RE = /<a id="(evidence-[^"]+)"><\/a>/gu;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafePackFile(pack: ResolvedPack, pageType: string, value: string): string {
  if (isAbsolute(value)) throw new Error('extractable.input_profile must be relative');
  const segments = value.split(/[\\/]+/u);
  if (segments.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('extractable.input_profile contains an unsafe path segment');
  }
  const origin = pack.page_type_declaration_origins[pageType];
  if (!origin?.manifest_path) {
    throw new Error(`cannot locate declaring pack for extractable page type: ${pageType}`);
  }
  const packRoot = dirname(origin.manifest_path);
  const candidate = resolve(packRoot, value);
  const lexicalRelative = relative(packRoot, candidate);
  if (lexicalRelative.startsWith(`..${sep}`) || lexicalRelative === '..' || isAbsolute(lexicalRelative)) {
    throw new Error('extractable.input_profile escapes its declaring pack');
  }
  let cursor = packRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error('extractable.input_profile may not traverse symlinks');
    }
  }
  if (!lstatSync(candidate).isFile()) {
    throw new Error('extractable.input_profile must name a regular file');
  }
  const realRoot = realpathSync(packRoot);
  const realCandidate = realpathSync(candidate);
  const realRelative = relative(realRoot, realCandidate);
  if (realRelative.startsWith(`..${sep}`) || realRelative === '..' || isAbsolute(realRelative)) {
    throw new Error('extractable.input_profile resolves outside its declaring pack');
  }
  return realCandidate;
}

export function resolveAtomInputProfile(
  pack: ResolvedPack,
  pageType: string,
): ResolvedAtomInputProfile | null {
  const path = getExtractableSpec(pack.manifest, pageType)?.input_profile;
  if (!path) return null;
  const resolvedPath = assertSafePackFile(pack, pageType, path);
  const bytes = readFileSync(resolvedPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    throw new Error(`extractable.input_profile is not valid JSON: ${path}`);
  }
  const profile = AtomInputProfileSchema.parse(raw);
  const origin = pack.page_type_declaration_origins[pageType];
  return {
    page_type: pageType,
    pack_identity: pack.identity,
    declaring_pack: origin.pack_name,
    profile_path: path,
    profile_sha256: sha256(bytes),
    profile,
  };
}

function selectedHeading(profile: AtomInputProfile): string {
  return profile.selector.slice('heading:'.length).trim();
}

function selectHeadingSection(content: string, profile: AtomInputProfile): {
  text: string;
  start: number;
  end: number;
} {
  const heading = `## ${selectedHeading(profile)}`;
  const candidates = content.startsWith(`${heading}\n`) ? [0] : [];
  let cursor = content.indexOf(`\n${heading}\n`);
  while (cursor >= 0) {
    candidates.push(cursor + 1);
    cursor = content.indexOf(`\n${heading}\n`, cursor + heading.length + 2);
  }
  if (candidates.length !== 1) {
    throw new Error(
      `extract_atoms input selector expected exactly one ${JSON.stringify(heading)} section; found ${candidates.length}`,
    );
  }
  const start = candidates[0];
  const nextHeading = content.indexOf('\n## ', start + heading.length);
  const end = nextHeading < 0 ? content.length : nextHeading + 1;
  const text = content.slice(start, end).trimEnd();
  if (text.length === 0) throw new Error('extract_atoms selected source section is empty');
  return { text, start, end: start + text.length };
}

function windowEnd(text: string, start: number, maxChars: number): number {
  const hardEnd = Math.min(text.length, start + maxChars);
  if (hardEnd === text.length) return hardEnd;
  const minimum = start + Math.floor(maxChars * 0.7);
  for (const boundary of ['\n#### ', '\n### ', '\n<a id="evidence-', '\n\n', '\n']) {
    const found = text.lastIndexOf(boundary, hardEnd);
    if (found >= minimum) return found + (boundary === '\n\n' ? 2 : 1);
  }
  return hardEnd;
}

export function prepareAtomSource(
  content: string,
  resolved: ResolvedAtomInputProfile,
): PreparedAtomSource {
  const selected = selectHeadingSection(content, resolved.profile);
  const { max_chars: maxChars, overlap_chars: overlapChars } = resolved.profile.windowing;
  const windows: AtomSourceWindow[] = [];
  let start = 0;
  while (start < selected.text.length) {
    const end = windowEnd(selected.text, start, maxChars);
    const text = selected.text.slice(start, end);
    const evidenceAnchors = [...text.matchAll(EVIDENCE_ANCHOR_RE)].map(match => match[1]);
    windows.push({
      index: windows.length,
      start,
      end,
      text,
      sha256: sha256(text),
      evidence_anchors: [...new Set(evidenceAnchors)],
    });
    if (end === selected.text.length) break;
    const desiredStart = Math.max(start + 1, end - overlapChars);
    const paragraph = selected.text.lastIndexOf('\n\n', end - 1);
    start = paragraph >= desiredStart ? paragraph + 2 : desiredStart;
  }
  let coveredThrough = 0;
  for (const window of windows) {
    if (window.start > coveredThrough) throw new Error('extract_atoms source windows contain a gap');
    coveredThrough = Math.max(coveredThrough, window.end);
  }
  if (coveredThrough !== selected.text.length) {
    throw new Error('extract_atoms source windows do not cover the complete selected source');
  }
  const evidenceAnchors = [...new Set(windows.flatMap(window => window.evidence_anchors))];
  const coverage = windows.map(window => ({
    index: window.index,
    start: window.start,
    end: window.end,
    sha256: window.sha256,
  }));
  return {
    selected_source: selected.text,
    source_section_sha256: sha256(selected.text),
    source_start: selected.start,
    source_end: selected.end,
    windows,
    evidence_anchors: evidenceAnchors,
    coverage_sha256: sha256(JSON.stringify(coverage)),
  };
}
