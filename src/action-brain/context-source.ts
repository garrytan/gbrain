import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import type { BrainEngine } from '../core/engine.ts';

const execFileAsync = promisify(execFile);

export const ACTION_DRAFT_CONTEXT_PAGE_LIMIT = 3;
export const ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS = 800;
export const ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT = 10;
export const ACTION_DRAFT_CONTEXT_MAX_CHARS = 4000;
const KEYWORD_SEARCH_LIMIT = 20;
const ENTITY_SLUG_PREFIXES = ['people/', 'companies/'] as const;

export interface ActionDraftContextSourceInput {
  source_contact: string;
  source_thread: string;
}

export interface ActionDraftContextExcerpt {
  slug: string;
  text: string;
}

export interface ActionDraftContextThreadMessage {
  sender: string;
  ts: string;
  text: string;
}

export interface ActionDraftContextSourceResult {
  gbrain_page_slugs: string[];
  excerpts: ActionDraftContextExcerpt[];
  thread: ActionDraftContextThreadMessage[];
  context_hash: string;
}

export interface BuildActionDraftContextSourceOptions {
  threadMessages?: ActionDraftContextThreadMessage[];
  threadMessagesRunner?: ActionDraftThreadMessagesRunner;
}

export type ActionDraftThreadMessagesRunner = (request: {
  thread: string;
  limit: number;
}) => Promise<ActionDraftContextThreadMessage[]>;

export async function buildActionDraftContextSource(
  engine: BrainEngine,
  input: ActionDraftContextSourceInput,
  options: BuildActionDraftContextSourceOptions = {}
): Promise<ActionDraftContextSourceResult> {
  const sourceContact = normalizeOptionalString(input.source_contact);
  const sourceThread = normalizeOptionalString(input.source_thread);

  let excerpts: ActionDraftContextExcerpt[] = [];
  if (sourceContact) {
    try {
      const keywordHits = await engine.searchKeyword(sourceContact, {
        limit: KEYWORD_SEARCH_LIMIT,
        detail: 'low',
      });
      const slugs = selectEntitySlugs(keywordHits.map((hit) => hit.slug));
      excerpts = await buildExcerpts(engine, slugs);
    } catch {
      excerpts = [];
    }
  }

  const thread = await resolveThreadMessages(sourceThread, options);
  const cappedThread = capThreadByCharsOldestFirst(thread, excerpts, ACTION_DRAFT_CONTEXT_MAX_CHARS);

  const result: ActionDraftContextSourceResult = {
    gbrain_page_slugs: excerpts.map((excerpt) => excerpt.slug),
    excerpts,
    thread: cappedThread,
    context_hash: '',
  };

  result.context_hash = sha256(stableStringify(result));
  return result;
}

export const buildContextSource = buildActionDraftContextSource;

async function buildExcerpts(engine: BrainEngine, slugs: string[]): Promise<ActionDraftContextExcerpt[]> {
  const excerpts: ActionDraftContextExcerpt[] = [];

  for (const slug of slugs) {
    const page = await engine.getPage(slug);
    if (!page || typeof page.compiled_truth !== 'string') {
      continue;
    }

    const text = truncate(page.compiled_truth.trim(), ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS);
    if (text.length === 0) {
      continue;
    }

    excerpts.push({ slug, text });
  }

  return excerpts;
}

async function resolveThreadMessages(
  sourceThread: string | null,
  options: BuildActionDraftContextSourceOptions
): Promise<ActionDraftContextThreadMessage[]> {
  if (!sourceThread) {
    return [];
  }

  if (options.threadMessages) {
    return normalizeThreadMessages(options.threadMessages);
  }

  const runner = options.threadMessagesRunner ?? runWacliThreadMessages;
  try {
    return normalizeThreadMessages(
      await runner({
        thread: sourceThread,
        limit: ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT,
      })
    );
  } catch {
    return [];
  }
}

function normalizeThreadMessages(messages: ActionDraftContextThreadMessage[]): ActionDraftContextThreadMessage[] {
  return messages
    .map((message) => ({
      sender: normalizeOptionalString(message.sender) ?? '',
      ts: normalizeOptionalString(message.ts) ?? '',
      text: normalizeOptionalString(message.text) ?? '',
    }))
    .filter((message) => message.text.length > 0)
    .slice(-ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT);
}

function capThreadByCharsOldestFirst(
  thread: ActionDraftContextThreadMessage[],
  excerpts: ActionDraftContextExcerpt[],
  maxChars: number
): ActionDraftContextThreadMessage[] {
  const excerptChars = excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
  const threadChars = thread.reduce((sum, message) => sum + message.text.length, 0);
  if (excerptChars + threadChars <= maxChars) {
    return thread;
  }

  const allowedThreadChars = Math.max(0, maxChars - excerptChars);
  if (allowedThreadChars === 0) {
    return [];
  }

  const keptReversed: ActionDraftContextThreadMessage[] = [];
  let usedChars = 0;

  for (let idx = thread.length - 1; idx >= 0; idx -= 1) {
    const message = thread[idx];
    const remaining = allowedThreadChars - usedChars;
    if (remaining <= 0) {
      break;
    }

    if (message.text.length <= remaining) {
      keptReversed.push(message);
      usedChars += message.text.length;
      continue;
    }

    keptReversed.push({
      ...message,
      text: message.text.slice(message.text.length - remaining),
    });
    usedChars += remaining;
    break;
  }

  return keptReversed.reverse();
}

async function runWacliThreadMessages(request: {
  thread: string;
  limit: number;
}): Promise<ActionDraftContextThreadMessage[]> {
  const args = ['messages', 'list', '--thread', request.thread, '--limit', String(request.limit), '--json'];
  const result = await execFileAsync('wacli', args, {
    maxBuffer: 16 * 1024 * 1024,
  });

  const payload = JSON.parse(result.stdout) as {
    success?: boolean;
    data?: { messages?: Array<Record<string, unknown>> };
  };

  if (!payload.success || !Array.isArray(payload.data?.messages)) {
    return [];
  }

  return payload.data.messages.map((message) => ({
    sender: asString(message.SenderName),
    ts: asString(message.Timestamp),
    text: asString(message.Text),
  }));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function selectEntitySlugs(slugs: string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const slug of slugs) {
    if (!isEntitySlug(slug) || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    selected.push(slug);
    if (selected.length >= ACTION_DRAFT_CONTEXT_PAGE_LIMIT) {
      break;
    }
  }

  return selected;
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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
