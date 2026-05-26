import { createHash } from 'crypto';
import matter from 'gray-matter';
import { splitBody } from '../markdown.ts';
import type { ProjectionTargetType } from './projection-targets.ts';

export interface AssertionFenceRow {
  assertion_id: string;
  property: string;
  value: string;
  source_refs: string[];
}

export interface MarkdownProjectionInput {
  target_id: string;
  target_type: ProjectionTargetType;
  title?: string;
  frontmatter: Record<string, unknown>;
  compiled_truth?: string;
  timeline?: string;
  assertions?: AssertionFenceRow[];
  body_without_hash?: string;
}

export interface ParsedMarkdownProjection {
  target_id: string;
  target_type: ProjectionTargetType;
  frontmatter: Record<string, unknown>;
  projection_hash: string;
  body_without_hash: string;
  compiled_truth: string;
  timeline: string;
  assertions: AssertionFenceRow[];
}

const PROJECTION_COMMENT_PATTERN = /^<!-- mbrain-projection target_id="([^"]+)" target_type="([^"]+)" hash="([^"]+)" -->\n*/;
const ASSERTION_FENCE_PATTERN = /```mbrain-assertions\n([\s\S]*?)\n```/;

export function projectionContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function renderAssertionFence(rows: AssertionFenceRow[]): string {
  return [
    '```mbrain-assertions',
    JSON.stringify(rows, null, 2),
    '```',
  ].join('\n');
}

export function parseAssertionFence(fence: string): AssertionFenceRow[] {
  const trimmed = fence.trim();
  const match = /^```mbrain-assertions\n([\s\S]*?)\n```$/.exec(trimmed);
  if (!match) throw new Error('invalid mbrain assertion fence');
  const parsed = JSON.parse(match[1] ?? '[]') as unknown;
  if (!Array.isArray(parsed)) throw new Error('mbrain assertion fence must contain an array');
  return parsed.map(normalizeAssertionFenceRow);
}

export function renderMarkdownProjection(input: MarkdownProjectionInput | ParsedMarkdownProjection): string {
  const frontmatter = { ...input.frontmatter };
  const bodyWithoutHash = 'body_without_hash' in input && input.body_without_hash
    ? input.body_without_hash
    : buildProjectionBody(input);
  const projectionHash = projectionContentHash(bodyWithoutHash);
  const yamlContent = matter.stringify('', frontmatter).trim();
  return [
    yamlContent,
    '',
    `<!-- mbrain-projection target_id="${input.target_id}" target_type="${input.target_type}" hash="${projectionHash}" -->`,
    '',
    bodyWithoutHash,
  ].join('\n') + '\n';
}

export function parseMarkdownProjection(content: string): ParsedMarkdownProjection {
  const { data, content: body } = matter(content);
  const normalizedBody = body.trimStart();
  const commentMatch = PROJECTION_COMMENT_PATTERN.exec(normalizedBody);
  if (!commentMatch) throw new Error('missing mbrain projection hash comment');

  const target_id = commentMatch[1]!;
  const target_type = commentMatch[2]! as ProjectionTargetType;
  const projection_hash = commentMatch[3]!;
  const body_without_hash = normalizedBody.slice(commentMatch[0].length).trimEnd();
  const expectedHash = projectionContentHash(body_without_hash);
  if (projection_hash !== expectedHash) {
    throw new Error(`projection hash mismatch: expected ${expectedHash}, got ${projection_hash}`);
  }

  const assertions = extractAssertionFenceRows(body_without_hash);
  const bodyWithoutFence = body_without_hash.replace(ASSERTION_FENCE_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim();
  const { compiled_truth, timeline } = splitBody(bodyWithoutFence);

  return {
    target_id,
    target_type,
    frontmatter: { ...data },
    projection_hash,
    body_without_hash,
    compiled_truth: compiled_truth.trim(),
    timeline: timeline.trim(),
    assertions,
  };
}

function buildProjectionBody(input: MarkdownProjectionInput | ParsedMarkdownProjection): string {
  const sections = [(input.compiled_truth ?? '').trim()];
  const assertions = input.assertions ?? [];
  if (assertions.length > 0) sections.push(renderAssertionFence(assertions));
  const timeline = (input.timeline ?? '').trim();
  if (timeline) sections.push(['---', '', timeline].join('\n'));
  return sections.filter((section) => section.length > 0).join('\n\n');
}

function extractAssertionFenceRows(body: string): AssertionFenceRow[] {
  const match = ASSERTION_FENCE_PATTERN.exec(body);
  if (!match) return [];
  return parseAssertionFence(match[0]);
}

function normalizeAssertionFenceRow(value: unknown): AssertionFenceRow {
  const row = value as Record<string, unknown>;
  const assertion_id = requiredString(row, 'assertion_id');
  const property = requiredString(row, 'property');
  const rowValue = requiredString(row, 'value');
  const sourceRefs = row.source_refs;
  if (!Array.isArray(sourceRefs) || sourceRefs.some((ref) => typeof ref !== 'string')) {
    throw new Error('assertion fence source_refs must be an array of strings');
  }
  return {
    assertion_id,
    property,
    value: rowValue,
    source_refs: sourceRefs,
  };
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`assertion fence ${key} must be a non-empty string`);
  }
  return value;
}
