/**
 * chatgpt-export.ts — ChatGPT data-export adapter (cathedral-4, CP1).
 *
 * v1 consumes the EXTRACTED conversations.json (the export zip is not
 * unwrapped here — "unzip first" is documented; a zip wrapper is a filed
 * TODO so this module stays dependency-free). One file = MANY conversations.
 *
 * The mapping is a TREE, not a list: regenerated answers create sibling
 * branches. The canonical transcript is the `current_node` parent-pointer
 * walk (root-ward, then reversed) — off-path branches are dropped BY DESIGN
 * (they were regenerated away). When `current_node` is missing, the fallback
 * is the leaf with the latest message create_time. Orphaned parents (pointer
 * to a missing node) terminate the walk without error. This walk is the
 * intricate part of the whole adapter set — the edge fixture pins branched,
 * orphaned, and fallback cases.
 *
 * PROVISIONAL: shape assembled from the widely-documented export format, not
 * verified against a fresh export on this machine; the drift alarm
 * (bytesRead > 0, sessions == 0) is the runtime backstop.
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

export const CHATGPT_SPEC_TARGET: HostSpecTarget = {
  id: 'chatgpt-export-2026-08',
  status: 'provisional',
  verifiedAt: '2026-08-14',
  references: [
    'ChatGPT settings data-export archive: conversations.json',
    'test/fixtures/transcripts/chatgpt-conversations.json',
  ],
  note:
    'Top level: ARRAY of conversations {title, create_time epoch, ' +
    'conversation_id|id, current_node, mapping}. mapping: {node_id: {id, ' +
    'parent, children, message}}. message: {author:{role}, create_time, ' +
    "content:{content_type, parts:[...]}}. Kept: role user/assistant with " +
    'non-empty STRING parts (multimodal dict parts skipped). system/tool ' +
    'roles skipped. Canonical path = current_node parent walk; fallback = ' +
    'latest-create_time leaf. Monolithic JSON: over-cap files are REJECTED, ' +
    'never truncated (a partial parse is invalid JSON).',
};

function epochToIso(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  return new Date(Math.round(v * 1000)).toISOString();
}

interface MappingNode {
  id?: string;
  parent?: string | null;
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[] };
  } | null;
}

/** Text of a node's message when it is a keepable user/assistant turn. */
function nodeToMessage(node: MappingNode): TranscriptMessage | null {
  const msg = node.message;
  if (!msg || typeof msg !== 'object') return null;
  const role = msg.author?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const parts = msg.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join('\n')
    .trim();
  if (!text) return null;
  return { role, timestamp: epochToIso(msg.create_time), text };
}

/** Walk parent pointers from a leaf to the root; missing parents terminate. */
function walkFrom(mapping: Record<string, MappingNode>, leafId: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = leafId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node: MappingNode | undefined = mapping[cur];
    if (!node) break; // orphaned pointer — stop quietly
    const m = nodeToMessage(node);
    if (m) out.push(m);
    cur = typeof node.parent === 'string' ? node.parent : undefined;
  }
  return out.reverse();
}

/** Fallback when current_node is absent: leaf with the newest create_time. */
function latestLeaf(mapping: Record<string, MappingNode>): string | undefined {
  const hasChild = new Set<string>();
  for (const node of Object.values(mapping)) {
    const parent = node?.parent;
    if (typeof parent === 'string') hasChild.add(parent);
  }
  let best: string | undefined;
  let bestTime = -Infinity;
  for (const [id, node] of Object.entries(mapping)) {
    if (hasChild.has(id)) continue;
    const t = typeof node?.message?.create_time === 'number' ? node.message.create_time : 0;
    if (t >= bestTime) {
      bestTime = t;
      best = id;
    }
  }
  return best;
}

export const chatgptExportAdapter: TranscriptAdapter = {
  format: 'chatgpt',
  specTarget: CHATGPT_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.json')) return false;
    const head = sample.toString('utf8');
    return head.includes('"mapping"') && !head.includes('"chat_messages"');
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const { data, bytes: size } = loadExportConversations(path, {
      maxBytes: opts.maxBytes,
      label: 'chatgpt',
    });

    let sessions = 0;
    for (const conv of data) {
      if (typeof conv !== 'object' || conv === null) continue;
      const c = conv as Record<string, unknown>;
      const mapping = (typeof c.mapping === 'object' && c.mapping !== null ? c.mapping : null) as
        | Record<string, MappingNode>
        | null;
      if (!mapping) continue;
      const leaf =
        typeof c.current_node === 'string' && c.current_node in mapping
          ? c.current_node
          : latestLeaf(mapping);
      if (!leaf) continue;
      const messages = walkFrom(mapping, leaf);
      if (!messages.length) continue;
      // Fallback ids are CONTENT-DERIVED, never a bare per-file ordinal: two
      // export files' first id-less conversations would otherwise both hash
      // from the same string and dedup-skip or abort each other.
      const sessionId =
        (typeof c.conversation_id === 'string' && c.conversation_id) ||
        (typeof c.id === 'string' && c.id) ||
        `chatgpt-fallback-${typeof c.title === 'string' ? c.title : ''}-${
          typeof c.create_time === 'number' ? c.create_time : ''
        }-${messages[0]?.timestamp ?? ''}-${sessions}`;
      sessions++;
      yield {
        meta: {
          harness: 'chatgpt',
          sessionId,
          title: typeof c.title === 'string' ? c.title : undefined,
          startedAt: epochToIso(c.create_time) || messages[0].timestamp || undefined,
          raw: {
            conversation_id: sessionId,
            title: typeof c.title === 'string' ? c.title : null,
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
        sessions === 0 ? 'no conversations with user/assistant text on the canonical path' : undefined,
    };
  },
};
