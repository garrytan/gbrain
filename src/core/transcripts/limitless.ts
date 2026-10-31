/**
 * limitless.ts — Limitless lifelog adapter (JSON export of the lifelogs API).
 *
 * Input is a `.json` file holding either the list-endpoint envelope
 * (`{ data: { lifelogs: [...] }, meta: { lifelogs: { nextCursor, count } } }`)
 * or a bare array of lifelogs. One lifelog = one session. A lifelog is
 * `{ id, title, markdown, startTime, endTime, isStarred, updatedAt, contents[] }`;
 * a contents node is `{ type, content, startTime, endTime, startOffsetMs,
 * endOffsetMs, children[], speakerName, speakerIdentifier }`. Only
 * `blockquote` nodes are spoken lines; headings are structure and the title
 * already carries the topic. The tree is walked depth-first (children
 * included).
 *
 * Roles are binary in the transcript pipeline: `speakerIdentifier === 'user'`
 * is the wearer (`user`); everyone else is `assistant`, the pipeline's only
 * non-owner role. `speakerName` is kept as the speaker label on every line so
 * the page still says who spoke.
 *
 * Identity: `sessionId` is the lifelog id, so a re-import of an unchanged
 * lifelog is skipped and a changed one updates the same page. The page slug
 * also carries the title slug and start day (the shared slug builder), so a
 * lifelog whose title or start day changes lands on a new page, as with the
 * chatgpt and claude-export adapters.
 *
 * PROVISIONAL: assembled from the public API documentation, not verified
 * against a fresh account export; the drift alarm is the runtime backstop.
 */

import { readFileSync, statSync } from 'node:fs';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { TRANSCRIPT_EXPORT_JSON_HARD_CAP, utcTimestamp } from './types.ts';

export const LIMITLESS_SPEC_TARGET: HostSpecTarget = {
  id: 'limitless-lifelog-api-2026-10',
  status: 'provisional',
  verifiedAt: '2026-10-26',
  references: [
    'https://www.limitless.ai/developers/docs/api',
    'test/fixtures/transcripts/limitless-lifelogs.json',
  ],
  note:
    'GET /v1/lifelogs response saved as .json: envelope {data:{lifelogs:[]}, ' +
    'meta:{lifelogs:{nextCursor,count}}} or a bare array. Lifelog {id, title, ' +
    'startTime, endTime, updatedAt, contents[]}; node {type heading1|heading2|' +
    'blockquote, content, startTime, startOffsetMs, children[], speakerName, ' +
    'speakerIdentifier "user"|null}. Kept: blockquote nodes with text. Monolithic ' +
    'JSON: over-cap files are REJECTED, never truncated.',
};

/** The lifelogs array from either accepted shape, or null when neither matches. */
function lifelogsOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object' || data === null) return null;
  const inner = (data as { data?: { lifelogs?: unknown } }).data?.lifelogs;
  return Array.isArray(inner) ? inner : null;
}

/**
 * ISO instant from the node, else lifelog start + the node's offset (derived
 * from source fields, not invented). The docs call the offset only a
 * "timestamp in milliseconds", so it is trusted only as an offset: inside the
 * lifelog's own span when its end is known, and non-negative otherwise.
 */
function nodeTimestamp(node: Record<string, unknown>, lifelogStart: string, lifelogEnd: string): string {
  const own = utcTimestamp(node.startTime);
  if (own) return own;
  const offset = node.startOffsetMs;
  const base = Date.parse(lifelogStart);
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || Number.isNaN(base)) return '';
  const end = Date.parse(lifelogEnd);
  if (!Number.isNaN(end) && offset > end - base) return '';
  return new Date(base + offset).toISOString();
}

export const limitlessAdapter: TranscriptAdapter = {
  format: 'limitless',
  specTarget: LIMITLESS_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.json')) return false;
    const head = sample.toString('utf8');
    if (head.includes('"chat_messages"') || head.includes('"mapping"')) return false;
    return head.includes('"speakerIdentifier"') || head.includes('"lifelogs"');
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? TRANSCRIPT_EXPORT_JSON_HARD_CAP;
    const size = statSync(path).size;
    if (size > cap) {
      throw new Error(`limitless export too large for import: ${size} bytes (cap ${cap}) — split the export`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`not a Limitless lifelogs JSON file: ${String(err)}`);
    }
    const lifelogs = lifelogsOf(parsed);
    if (!lifelogs) {
      throw new Error('not a Limitless lifelogs JSON file (expected {data:{lifelogs:[...]}} or a top-level array)');
    }

    let sessions = 0;
    let skippedLines = 0;
    for (const entry of lifelogs) {
      if (typeof entry !== 'object' || entry === null) continue;
      const log = entry as Record<string, unknown>;
      const lifelogStart = utcTimestamp(log.startTime);
      const lifelogEnd = utcTimestamp(log.endTime);
      const messages: TranscriptMessage[] = [];

      // Iterative depth-first walk (parent before children, siblings in order);
      // nesting depth is bounded by the heap, not the call stack.
      const stack: unknown[] = Array.isArray(log.contents) ? [...log.contents].reverse() : [];
      while (stack.length) {
        const n = stack.pop();
        if (typeof n !== 'object' || n === null) continue;
        const node = n as Record<string, unknown>;
        if (node.type === 'blockquote') {
          const text = typeof node.content === 'string' ? node.content.trim() : '';
          if (text) {
            const timestamp = nodeTimestamp(node, lifelogStart, lifelogEnd);
            if (timestamp) {
              const speaker = typeof node.speakerName === 'string' ? node.speakerName.trim() : '';
              messages.push({
                role: node.speakerIdentifier === 'user' ? 'user' : 'assistant',
                ...(speaker ? { speaker } : {}),
                timestamp,
                text,
              });
            } else {
              skippedLines++;
            }
          }
        }
        if (Array.isArray(node.children)) {
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
      }
      if (!messages.length) continue;
      // Oldest to newest (the ParsedSession contract); stable, so equal times keep tree order.
      messages.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));

      const title = typeof log.title === 'string' && log.title ? log.title : undefined;
      const sessionId =
        (typeof log.id === 'string' && log.id) ||
        `limitless-fallback-${title ?? ''}-${lifelogStart}-${messages[0].timestamp}-${sessions}`;
      sessions++;
      yield {
        meta: {
          harness: 'limitless',
          sessionId,
          title,
          startedAt: lifelogStart || messages[0].timestamp || undefined,
          // Flat strings only: redaction drops nested raw values.
          raw: {
            lifelog_id: sessionId,
            title: title ?? null,
            updated_at: typeof log.updatedAt === 'string' ? log.updatedAt : null,
            is_starred: log.isStarred === true ? 'true' : 'false',
            source_path: path,
          },
        },
        messages,
      };
    }
    return {
      bytesRead: size,
      skippedLines,
      truncated: false,
      sessions,
      zeroSessionsReason: sessions === 0 ? 'no lifelogs with blockquote (spoken) text nodes' : undefined,
    };
  },
};
