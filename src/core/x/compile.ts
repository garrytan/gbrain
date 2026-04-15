/**
 * Compile fetched X data into GBrain-compatible markdown pages.
 *
 * Unlike the original Obsidian build-vault.mjs (wikilinks, numbered folders),
 * this outputs standard GBrain frontmatter and files by primary subject
 * per brain-filing-rules.
 */

import type { FetchTweetResult, ThreadResult, ThreadReply } from './types.ts';

export interface CompiledPage {
  /** GBrain slug (e.g. "sources/x/karpathy-llm-knowledge-bases") */
  slug: string;
  /** Full markdown content with YAML frontmatter */
  content: string;
  /** The author handle for cross-linking */
  authorHandle: string | null;
  /** The author display name */
  authorName: string | null;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/g, '').replace(/t\.co\/\S+/g, '');
}

function cleanText(value: string): string {
  return compact(stripUrls(value ?? ''));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function titleFromText(text: string, fallback: string): string {
  const firstLine = cleanText(
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '',
  );
  return (firstLine || fallback).slice(0, 56);
}

function escapeYaml(value: string): string {
  return String(value ?? '').replace(/"/g, '\\"');
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return '';
  }
}

function excerptFromText(value: string | null, maxLength = 180): string {
  const cleaned = cleanText(value ?? '');
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;
  const sliced = cleaned.slice(0, maxLength);
  return `${sliced.slice(0, sliced.lastIndexOf(' ')).trim()}...`;
}

export interface CompileOptions {
  /** Override titles by tweet ID */
  titleOverrides?: Record<string, string>;
}

/**
 * Compile a single fetched tweet (with optional thread) into a GBrain page.
 */
export function compileTweetPage(
  result: FetchTweetResult,
  thread: ThreadReply[],
  opts: CompileOptions = {},
): CompiledPage | null {
  const normalized = result.normalized;
  if (!normalized || normalized.tombstone) return null;

  const author = normalized.author?.handle ?? 'unknown';
  const authorName = normalized.author?.name ?? null;
  const tweetId = result.tweetId ?? normalized.id ?? 'unknown';
  const text = normalized.text ?? '';
  const title =
    opts.titleOverrides?.[tweetId] ?? titleFromText(text, `${author}-${tweetId}`);
  const slug = `sources/x/${slugify(`${author}-${title}`)}`;
  const date = formatDate(normalized.createdAt);
  const tags = ['x-post', `author/${author}`];

  // Build frontmatter
  const frontmatter = [
    '---',
    `type: source`,
    `title: "${escapeYaml(title)}"`,
    `slug: "${slug}"`,
    `tags: [${tags.map((t) => `"${escapeYaml(t)}"`).join(', ')}]`,
    `source_type: x`,
    `source_url: "${result.targetUrl}"`,
    `tweet_id: "${tweetId}"`,
    `author_handle: "${escapeYaml(author)}"`,
    ...(authorName ? [`author_name: "${escapeYaml(authorName)}"`] : []),
    ...(date ? [`date: "${date}"`] : []),
    ...(normalized.metrics
      ? [`likes: ${normalized.metrics.likes ?? 0}`, `reposts: ${normalized.metrics.reposts ?? 0}`]
      : []),
    `thread_count: ${thread.length}`,
    '---',
  ].join('\n');

  // Build body
  const lines: string[] = [
    frontmatter,
    '',
    `# ${title}`,
    '',
    text,
    '',
    `[Source: @${author} on X](${result.targetUrl})`,
    '',
  ];

  // Metrics
  if (normalized.metrics) {
    const m = normalized.metrics;
    const parts: string[] = [];
    if (m.likes) parts.push(`${m.likes} likes`);
    if (m.reposts) parts.push(`${m.reposts} reposts`);
    if (m.replies) parts.push(`${m.replies} replies`);
    if (m.views) parts.push(`${m.views} views`);
    if (parts.length > 0) {
      lines.push(`*${parts.join(' · ')}*`);
      lines.push('');
    }
  }

  // Linked URLs
  if (normalized.urls && normalized.urls.length > 0) {
    const realUrls = normalized.urls.filter(
      (u) => u.expandedUrl && !u.expandedUrl.includes('x.com/') && !u.expandedUrl.includes('twitter.com/'),
    );
    if (realUrls.length > 0) {
      lines.push('## Linked Resources');
      for (const u of realUrls) {
        lines.push(`- [${u.displayUrl || u.expandedUrl}](${u.expandedUrl})`);
      }
      lines.push('');
    }
  }

  // Thread continuations
  if (thread.length > 0) {
    lines.push('## Thread');
    for (const reply of thread) {
      lines.push('');
      lines.push(reply.text ?? '');
      lines.push('');
      lines.push(`[Source: @${author} continuation](${reply.url})`);
    }
    lines.push('');
  }

  // Media
  if (normalized.media && normalized.media.length > 0) {
    lines.push('## Media');
    for (const m of normalized.media) {
      if (m.mediaUrlHttps) {
        lines.push(`- ![${m.type || 'media'}](${m.mediaUrlHttps})`);
      }
    }
    lines.push('');
  }

  return {
    slug,
    content: lines.join('\n'),
    authorHandle: author !== 'unknown' ? author : null,
    authorName,
  };
}

/**
 * Compile a batch of fetched tweets with their threads into GBrain pages.
 * Returns compiled pages + a list of unique authors for people-page creation.
 */
export function compileBatch(
  results: FetchTweetResult[],
  threads: ThreadResult[],
  opts: CompileOptions = {},
): { pages: CompiledPage[]; authors: Map<string, { handle: string; name: string | null }> } {
  const threadByRootId = new Map<string, ThreadReply[]>();
  for (const t of threads) {
    if (t.rootId) {
      threadByRootId.set(t.rootId, t.thread);
    }
  }

  const pages: CompiledPage[] = [];
  const authors = new Map<string, { handle: string; name: string | null }>();

  for (const result of results) {
    const rootId = result.tweetId ?? result.normalized?.id;
    const thread = rootId ? (threadByRootId.get(rootId) ?? []) : [];
    const page = compileTweetPage(result, thread, opts);
    if (!page) continue;

    pages.push(page);

    if (page.authorHandle) {
      authors.set(page.authorHandle, {
        handle: page.authorHandle,
        name: page.authorName,
      });
    }
  }

  return { pages, authors };
}

/**
 * Generate a minimal people-page stub for an X author.
 * Only created if the person doesn't already exist in the brain.
 */
export function compileAuthorPage(handle: string, name: string | null): CompiledPage {
  const slug = `people/${slugify(handle)}`;
  const displayName = name || handle;

  const content = [
    '---',
    `type: person`,
    `title: "${escapeYaml(displayName)}"`,
    `slug: "${slug}"`,
    `tags: ["x-author"]`,
    `x_handle: "${escapeYaml(handle)}"`,
    '---',
    '',
    `# ${displayName}`,
    '',
    `[@${handle} on X](https://x.com/${handle})`,
    '',
  ].join('\n');

  return { slug, content, authorHandle: handle, authorName: name };
}
