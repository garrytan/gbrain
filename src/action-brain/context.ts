import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import type { BrainEngine } from '../core/engine.ts';

const execFileAsync = promisify(execFile);

export const ACTION_DRAFT_CONTEXT_PAGE_LIMIT = 3;
export const ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS = 800;
export const ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT = 10;
export const ACTION_DRAFT_CONTEXT_MAX_CHARS = 4000;
const ENTITY_SLUG_PREFIXES = ['people/', 'companies/'] as const;
const KEYWORD_SEARCH_LIMIT = 20;

export interface ActionDraftContextSource {
  source_contact: string;
  source_thread: string;
}

export interface ActionDraftThreadMessage {
  id: string;
  sender: string;
  ts: string;
  text: string;
}

export interface ActionDraftPageContext {
  slug: string;
  excerpt: string;
}

export interface ActionDraftContextSnapshot {
  gbrain_page_slugs: string[];
  excerpts_sha256: Record<string, string>;
  source_thread_snapshot_ids: string[];
}

export interface ActionDraftContext {
  gbrainAvailable: boolean;
  pages: ActionDraftPageContext[];
  thread: ActionDraftThreadMessage[];
  gbrainContext: string;
  threadContext: string;
  context: string;
  context_hash: string;
  context_snapshot: ActionDraftContextSnapshot;
}

export interface BuildActionDraftContextOptions {
  threadMessages?: ActionDraftThreadMessage[];
  threadMessagesRunner?: ActionDraftThreadMessagesRunner;
  now?: Date;
}

export type ActionDraftThreadMessagesRunner = (request: {
  thread: string;
  limit: number;
  now?: Date;
}) => Promise<ActionDraftThreadMessage[]>;

export async function buildActionDraftContext(
  engine: BrainEngine,
  source: ActionDraftContextSource,
  options: BuildActionDraftContextOptions = {}
): Promise<ActionDraftContext> {
  const sourceContact = normalizeOptionalString(source.source_contact);
  const sourceThread = normalizeOptionalString(source.source_thread);

  let gbrainAvailable = true;
  let pages: ActionDraftPageContext[] = [];

  if (sourceContact) {
    try {
      const hits = await engine.searchKeyword(sourceContact, {
        limit: KEYWORD_SEARCH_LIMIT,
        detail: 'low',
      });
      const slugs = selectEntitySlugs(hits.map((hit) => hit.slug));
      pages = await buildPageContexts(engine, slugs);
    } catch {
      // Context sourcing must fail-open: continue with an empty gbrain context.
      gbrainAvailable = false;
      pages = [];
    }
  }

  const thread = await resolveThreadMessages(sourceThread, options);

  const gbrainContext = pages
    .map((page) => `<page slug="${escapeXmlAttribute(page.slug)}">${escapeXmlText(page.excerpt)}</page>`)
    .join('\n');
  const threadContext = thread
    .map((message) => `<msg sender="${escapeXmlAttribute(message.sender)}" ts="${escapeXmlAttribute(message.ts)}">${escapeXmlText(message.text)}</msg>`)
    .join('\n');

  const rawContext = [gbrainContext, threadContext].filter((part) => part.length > 0).join('\n');
  const context = truncateOldestFirst(rawContext, ACTION_DRAFT_CONTEXT_MAX_CHARS);

  const contextSnapshot = buildSnapshot(pages, thread);
  const hashSeed = stableStringify({
    context,
    context_snapshot: contextSnapshot,
  });

  return {
    gbrainAvailable,
    pages,
    thread,
    gbrainContext,
    threadContext,
    context,
    context_hash: sha256(hashSeed),
    context_snapshot: contextSnapshot,
  };
}

export const buildContext = buildActionDraftContext;

async function buildPageContexts(engine: BrainEngine, slugs: string[]): Promise<ActionDraftPageContext[]> {
  const pages: ActionDraftPageContext[] = [];
  for (const slug of slugs) {
    const page = await engine.getPage(slug);
    if (!page || typeof page.compiled_truth !== 'string' || page.compiled_truth.trim().length === 0) {
      continue;
    }

    pages.push({
      slug,
      excerpt: truncate(page.compiled_truth.trim(), ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS),
    });
  }
  return pages;
}

function buildSnapshot(pages: ActionDraftPageContext[], thread: ActionDraftThreadMessage[]): ActionDraftContextSnapshot {
  const excerptsSha: Record<string, string> = {};
  for (const page of pages) {
    excerptsSha[page.slug] = sha256(page.excerpt);
  }

  return {
    gbrain_page_slugs: pages.map((page) => page.slug),
    excerpts_sha256: excerptsSha,
    source_thread_snapshot_ids: thread.map((message) => message.id).filter((id) => id.length > 0),
  };
}

async function resolveThreadMessages(
  sourceThread: string | null,
  options: BuildActionDraftContextOptions
): Promise<ActionDraftThreadMessage[]> {
  if (!sourceThread) {
    return [];
  }

  const provided = options.threadMessages;
  if (provided) {
    return normalizeThreadMessages(provided);
  }

  const runner = options.threadMessagesRunner ?? runWacliThreadMessages;
  try {
    const messages = await runner({
      thread: sourceThread,
      limit: ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT,
      now: options.now,
    });
    return normalizeThreadMessages(messages);
  } catch {
    return [];
  }
}

function normalizeThreadMessages(messages: ActionDraftThreadMessage[]): ActionDraftThreadMessage[] {
  return messages
    .map((message) => ({
      id: normalizeOptionalString(message.id) ?? '',
      sender: normalizeOptionalString(message.sender) ?? '',
      ts: normalizeOptionalString(message.ts) ?? '',
      text: normalizeOptionalString(message.text) ?? '',
    }))
    .filter((message) => message.text.length > 0)
    .slice(-ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT);
}

async function runWacliThreadMessages(request: {
  thread: string;
  limit: number;
}): Promise<ActionDraftThreadMessage[]> {
  const args = ['messages', 'list', '--thread', request.thread, '--limit', String(request.limit), '--format', 'json'];
  const output = await execFileAsync('wacli', args, {
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    env: process.env,
  });

  const stdout = output.stdout ?? '';
  if (stdout.trim().length === 0) {
    return [];
  }

  const payload = JSON.parse(stdout) as {
    success?: boolean;
    data?: { messages?: Array<Record<string, unknown>> };
  };

  if (!payload.success || !Array.isArray(payload.data?.messages)) {
    return [];
  }

  return payload.data.messages.map((entry) => ({
    id: asString(entry.MsgID),
    sender: asString(entry.SenderName),
    ts: asString(entry.Timestamp),
    text: asString(entry.Text),
  }));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function selectEntitySlugs(slugs: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const slug of slugs) {
    if (!isEntitySlug(slug) || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    unique.push(slug);

    if (unique.length >= ACTION_DRAFT_CONTEXT_PAGE_LIMIT) {
      break;
    }
  }

  return unique;
}

function isEntitySlug(slug: string): boolean {
  return ENTITY_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

function truncateOldestFirst(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/'/g, '&apos;');
}
