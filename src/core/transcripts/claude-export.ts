/**
 * claude-export.ts — Claude.ai data-export adapter (cathedral-4, CP1).
 *
 * v1 consumes the EXTRACTED conversations.json from the account export
 * ("unzip first" documented; zip wrapper is a filed TODO). Flat shape — the
 * cheap sibling of the ChatGPT mapping-tree walk. One file = MANY
 * conversations.
 *
 * PROVISIONAL: shape assembled from the documented export format, not
 * verified against a fresh export on this machine; drift alarm is the
 * runtime backstop.
 */

import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { loadExportConversations } from './export-json.ts';

export const CLAUDE_EXPORT_SPEC_TARGET: HostSpecTarget = {
  id: 'claude-ai-export-2026-08',
  status: 'provisional',
  verifiedAt: '2026-08-14',
  references: [
    'Claude.ai account data export: conversations.json',
    'test/fixtures/transcripts/claude-export.json',
  ],
  note:
    'Top level: ARRAY of conversations {uuid, name, created_at ISO, ' +
    'chat_messages:[{uuid, text, sender, created_at}]}. sender "human" maps ' +
    'to user; "assistant" stays. Empty-text messages are skipped. Monolithic ' +
    'JSON: over-cap files are REJECTED, never truncated.',
};

export const claudeExportAdapter: TranscriptAdapter = {
  format: 'claude-export',
  specTarget: CLAUDE_EXPORT_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.json')) return false;
    const head = sample.toString('utf8');
    // Symmetric guard with the chatgpt detector: a ChatGPT export whose
    // early message TEXT contains the literal key name must not misdetect.
    return head.includes('"chat_messages"') && !head.includes('"mapping"');
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const { data, bytes: size } = loadExportConversations(path, {
      maxBytes: opts.maxBytes,
      label: 'claude',
    });

    let sessions = 0;
    for (const conv of data) {
      if (typeof conv !== 'object' || conv === null) continue;
      const c = conv as Record<string, unknown>;
      const rows = Array.isArray(c.chat_messages) ? c.chat_messages : null;
      if (!rows) continue;
      const messages: TranscriptMessage[] = [];
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;
        const role = r.sender === 'human' ? 'user' : r.sender === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const text = typeof r.text === 'string' ? r.text.trim() : '';
        if (!text) continue;
        messages.push({
          role,
          timestamp: typeof r.created_at === 'string' ? r.created_at : '',
          text,
        });
      }
      if (!messages.length) continue;
      // Content-derived fallback (see chatgpt-export.ts): a bare per-file
      // ordinal collides across export files.
      const sessionId =
        (typeof c.uuid === 'string' && c.uuid) ||
        `claude-export-fallback-${typeof c.name === 'string' ? c.name : ''}-${
          typeof c.created_at === 'string' ? c.created_at : ''
        }-${messages[0]?.timestamp ?? ''}-${sessions}`;
      sessions++;
      yield {
        meta: {
          harness: 'claude-export',
          sessionId,
          title: typeof c.name === 'string' && c.name ? c.name : undefined,
          startedAt:
            (typeof c.created_at === 'string' && c.created_at) || messages[0].timestamp || undefined,
          raw: {
            conversation_uuid: sessionId,
            name: typeof c.name === 'string' ? c.name : null,
            source_path: path,
          },
        },
        messages,
      };
    }
    return {
      bytesRead: size,
      skippedLines: 0,
      truncated: false,
      sessions,
      zeroSessionsReason:
        sessions === 0 ? 'no conversations with human/assistant text messages' : undefined,
    };
  },
};
