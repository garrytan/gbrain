import {
  CANONICALIZE_PATH_SOURCE_KINDS,
  previewCanonicalizePath,
  type CanonicalizePathPreviewInput,
  type CanonicalizePathSourceKind,
} from '../core/services/canonicalize-path-preview-service.ts';
import type { PageType } from '../core/types.ts';

interface ParsedCanonicalizeArgs extends CanonicalizePathPreviewInput {
  json?: boolean;
}

const PAGE_TYPE_VALUES = [
  'person',
  'company',
  'deal',
  'yc',
  'civic',
  'project',
  'concept',
  'source',
  'media',
  'system',
] as const satisfies readonly PageType[];

export async function runCanonicalize(args: string[]): Promise<void> {
  const input = parseCanonicalizeArgs(args);
  const result = await previewCanonicalizePath(input);
  if (input.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatCanonicalizePreview(result));
}

export async function runCanonicalizeCode(args: string[]): Promise<void> {
  const input = parseCanonicalizeArgs(args);
  const result = await previewCanonicalizePath({ ...input, source_kind: 'code_repo' });
  if (input.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatCanonicalizePreview(result));
}

function parseCanonicalizeArgs(args: string[]): ParsedCanonicalizeArgs {
  const parsed: ParsedCanonicalizeArgs = { path: '' };
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--target' || arg === '--target-slug') {
      parsed.target_slug = requireFlagValue(arg, args[++i]);
      continue;
    }
    if (arg.startsWith('--target=')) {
      parsed.target_slug = arg.slice('--target='.length);
      continue;
    }
    if (arg.startsWith('--target-slug=')) {
      parsed.target_slug = arg.slice('--target-slug='.length);
      continue;
    }
    if (arg === '--title') {
      parsed.title = requireFlagValue(arg, args[++i]);
      continue;
    }
    if (arg.startsWith('--title=')) {
      parsed.title = arg.slice('--title='.length);
      continue;
    }
    if (arg === '--type') {
      parsed.type = parsePageType(requireFlagValue(arg, args[++i]));
      continue;
    }
    if (arg.startsWith('--type=')) {
      parsed.type = parsePageType(arg.slice('--type='.length));
      continue;
    }
    if (arg === '--source-kind') {
      parsed.source_kind = parseSourceKind(requireFlagValue(arg, args[++i]));
      continue;
    }
    if (arg.startsWith('--source-kind=')) {
      parsed.source_kind = parseSourceKind(arg.slice('--source-kind='.length));
      continue;
    }
    if (arg === '--now') {
      parsed.now = parseIsoTimestamp(requireFlagValue(arg, args[++i]));
      continue;
    }
    if (arg.startsWith('--now=')) {
      parsed.now = parseIsoTimestamp(arg.slice('--now='.length));
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown canonicalize flag: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) throw new Error('canonicalize requires a path');
  if (positionals.length > 1) throw new Error(`canonicalize accepts one path, got ${positionals.length}`);
  parsed.path = positionals[0];
  return parsed;
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('-')) throw new Error(`${flag} expects a value`);
  return value;
}

function parsePageType(value: string): PageType {
  if (PAGE_TYPE_VALUES.includes(value as PageType)) return value as PageType;
  throw new Error(`--type must be one of: ${PAGE_TYPE_VALUES.join(', ')}`);
}

function parseSourceKind(value: string): CanonicalizePathSourceKind {
  if (CANONICALIZE_PATH_SOURCE_KINDS.includes(value as CanonicalizePathSourceKind)) {
    return value as CanonicalizePathSourceKind;
  }
  throw new Error(`--source-kind must be one of: ${CANONICALIZE_PATH_SOURCE_KINDS.join(', ')}`);
}

function parseIsoTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error('--now must be a valid ISO timestamp');
  }
  return value;
}

function formatCanonicalizePreview(result: Awaited<ReturnType<typeof previewCanonicalizePath>>): string {
  const blocked = result.drafts.filter((draft) => draft.blocked_reasons.length > 0);
  const ready = result.drafts.length - blocked.length;
  const lines = [
    'Preview only: no canonical memory was written.',
    '',
    `Source: ${result.path}`,
    `Kind: ${result.source_kind}`,
    `Target: ${result.target_slug}`,
    `Hash: ${result.source_content_hash}`,
    `Drafts: ${ready} ready, ${blocked.length} blocked`,
  ];

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push('', 'Drafts:');
  for (const draft of result.drafts) {
    const status = draft.blocked_reasons.length > 0
      ? `blocked (${draft.blocked_reasons.join(', ')})`
      : 'ready';
    lines.push(`- ${draft.slug} [${draft.type}] ${draft.title} - ${status}`);
  }

  const markdown = result.drafts.map((draft) => draft.markdown).filter(Boolean).join('\n\n');
  if (markdown) {
    lines.push('', 'Markdown:', '', markdown);
  }

  lines.push('', 'Next:');
  for (const step of result.next_steps) lines.push(`- ${step}`);
  return `${lines.join('\n')}\n`;
}
