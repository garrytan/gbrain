/**
 * Shared builders for the conversation-archive suites (GST-2768): synthetic sessions, a static reader, and readers of
 * what the archive wrote. Every value is synthetic.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ArchiveChannel, ArchiveConversation, ArchiveReader } from '../../src/core/transcripts/archive.ts';
import type { TranscriptFormat } from '../../src/core/transcripts/types.ts';

export type Turn = ['user' | 'assistant', string, string];

export function conversation(harness: TranscriptFormat, key: string, turns: Turn[], channel?: ArchiveChannel, raw?: Record<string, unknown>): ArchiveConversation {
  return {
    harness,
    conversationKey: key,
    ...(channel ? { channel } : {}),
    session: {
      meta: { harness, sessionId: key, startedAt: turns[0]?.[1], ...(raw ? { raw } : {}) },
      messages: turns.map(([role, timestamp, text]) => ({ role, timestamp, text })),
    },
  };
}

export function staticReader(harness: TranscriptFormat, convs: ArchiveConversation[] | (() => ArchiveConversation[])): ArchiveReader {
  return { harness, name: harness, list: async () => (typeof convs === 'function' ? convs() : convs) };
}

export interface ArchivedPage { slug: string; revision: number; frontmatter: Record<string, unknown>; body: string }

export async function archivedPages(engine: BrainEngine, sourceId = 'conversations'): Promise<ArchivedPage[]> {
  const rows = await engine.executeRaw<{ slug: string; type: string; revision: number | string; frontmatter: unknown; compiled_truth: string }>(
    'SELECT slug, type, generation AS revision, frontmatter, compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug', [sourceId]);
  return rows.map(r => ({
    slug: r.slug,
    revision: Number(r.revision),
    frontmatter: { type: r.type, ...((typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter) as Record<string, unknown>) },
    body: r.compiled_truth,
  }));
}

/** Every archive config row except transcripts.archive.last_read.*, which records what each run read (and when), not what it archived. */
export async function ledgerRows(engine: BrainEngine): Promise<Array<{ key: string; value: string }>> {
  return engine.executeRaw<{ key: string; value: string }>("SELECT key, value FROM config WHERE key LIKE 'transcripts.archive.%' AND key NOT LIKE 'transcripts.archive.last\\_read.%' ORDER BY key");
}
