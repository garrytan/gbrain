/**
 * openclaw-gateway.ts — the conversation archive's reader for current OpenClaw (GST-2768).
 *
 * Current OpenClaw keeps live session rows and transcripts in per-agent SQLite owned by its Gateway; gbrain never
 * opens that file. It reads through the Gateway's RPCs, called with the documented CLI
 * (openclaw gateway call <method> --json --params <json>), which also owns the Gateway credential and device
 * pairing. Verified against OpenClaw 2026.11.3 (test/fixtures/openclaw-gateway/README.md):
 *
 *   - sessions.list {limit, offset}: rows with key, sessionId, agentId, chatType (direct | group | room), createdAt,
 *     updatedAt (epoch ms); paged by hasMore / nextOffset. Archived sessions are not listed, and the call takes no
 *     parameter that lists them.
 *   - chat.history {sessionKey, limit, offset}: messages {role, content (string or [{type: text, text}]),
 *     timestamp (epoch ms), __openclaw {id, seq}}; pages walk backward from the newest (hasMore / nextOffset), each
 *     page oldest first. It still reads an archived session by key. A reset in place keeps the sessionId and drops
 *     the earlier messages from this read.
 *   - Errors come back as a JSON envelope {ok: false, error: {type, code?, message, details?}}: a closed port is
 *     gateway_transport_error, a missing credential gateway_credentials_required, a wrong one gateway_request_error
 *     with details.code AUTH_*.
 *
 * Channel metadata: only the row's chatType counts, and only as one of the three documented values. The key's shape
 * and the derived kind / classification fields never do (a session created with a group-shaped key reads kind
 * group and chatType direct). Anything else is unknown, which the archive resolves owner-only.
 *
 * Failures throw archive_gateway_unreachable, archive_gateway_auth or archive_gateway_failed with the Gateway's
 * message redacted; the reader yields nothing before every read finished, so a failed run changes no ledger row.
 */

import { execFile } from '../spawn.ts';
import { opError } from '../ops/contract.ts';
import { applyRedaction, planRedaction } from '../secret-scan.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import type { TranscriptMessage } from './types.ts';
import { utcTimestamp } from './types.ts';
import type { ArchiveChannel } from './archive-day.ts';
import { conversationHash8 } from './archive-day.ts';

export interface GatewayTransport {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface GatewayConversation {
  harness: 'openclaw';
  conversationKey: string;
  via: 'gateway';
  channel: ArchiveChannel;
  session: { meta: { harness: 'openclaw'; sessionId: string; startedAt?: string; raw: Record<string, unknown> }; messages: TranscriptMessage[] };
}

const LIST_PAGE = 100;
const HISTORY_PAGE = 200;
const MAX_PAGES = 10_000;

/** Redact and bound text that came from the Gateway before it reaches a message, a log or a receipt. */
export function redactGatewayText(text: string): string {
  const clean = applyRedaction(planRedaction(sanitizeForJsonb(text), { highEntropy: true, labeledCredentials: true }));
  return clean.length > 500 ? clean.slice(0, 500) + '...' : clean;
}

function gatewayError(kind: 'unreachable' | 'auth' | 'failed', detail: string): Error {
  const message = redactGatewayText(detail);
  if (kind === 'unreachable') {
    return opError('archive_gateway_unreachable', 'The OpenClaw Gateway did not answer, so no OpenClaw conversation was archived this run: ' + message,
      'Start the Gateway (openclaw gateway) or point gbrain at it (GBRAIN_OPENCLAW_GATEWAY_URL), then rerun gbrain transcripts archive run.',
      { retryable: true, fix: { argv: ['openclaw', 'health', '--json'], consent: [], actor: 'agent', why: 'Shows whether the local OpenClaw Gateway is running, read-only.', requires_exclusive: false } });
  }
  if (kind === 'auth') {
    return opError('archive_gateway_auth', 'The OpenClaw Gateway refused gbrain\'s credential, so no OpenClaw conversation was archived this run: ' + message,
      'Ask the user to give gbrain the Gateway token (GBRAIN_OPENCLAW_GATEWAY_TOKEN, or gateway.auth in the OpenClaw config on this machine), then rerun gbrain transcripts archive run.',
      { fix: { argv: ['openclaw', 'gateway', 'call', 'health', '--json'], consent: [], actor: 'user', why: 'Checks that the Gateway accepts the configured credential, read-only.', requires_exclusive: false } });
  }
  return opError('archive_gateway_failed', 'The OpenClaw Gateway returned an error, so no OpenClaw conversation was archived this run: ' + message,
    'Rerun gbrain transcripts archive run; if it repeats, run gbrain transcripts archive status --json and report the message.', { retryable: true });
}

/** One CLI result: the parsed document, or the stable archive error for its error envelope. */
export function parseGatewayCliOutput(stdout: string, exitCode: number | null): unknown {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    throw gatewayError('unreachable', 'openclaw gateway call exited ' + String(exitCode) + ' without a JSON result: ' + stdout.trim().slice(0, 300));
  }
  const rec = doc && typeof doc === 'object' ? doc as Record<string, unknown> : null;
  if (!rec || rec.ok !== false) return doc;
  const err = (rec.error && typeof rec.error === 'object' ? rec.error : {}) as Record<string, unknown>;
  const type = String(err.type ?? '');
  const message = String(err.message ?? 'no detail');
  const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
  if (type === 'gateway_transport_error') throw gatewayError('unreachable', message);
  if (type === 'gateway_credentials_required' || /^AUTH_/.test(String(details.code ?? '')) || /unauthori[sz]ed|forbidden/i.test(message)) throw gatewayError('auth', message);
  throw gatewayError('failed', message);
}

/** The default transport: the documented CLI on this machine. The token, when gbrain holds one, goes through the environment, never argv. */
export function cliGatewayTransport(opts: { bin?: string; url?: string; token?: string; timeoutMs?: number } = {}): GatewayTransport {
  const bin = opts.bin ?? 'openclaw';
  const url = opts.url ?? process.env.GBRAIN_OPENCLAW_GATEWAY_URL;
  const token = opts.token ?? process.env.GBRAIN_OPENCLAW_GATEWAY_TOKEN;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    call(method, params) {
      const args = ['gateway', 'call', method, '--json', '--params', JSON.stringify(params), '--timeout', String(timeoutMs), ...(url ? ['--url', url] : [])];
      const env = token ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: token } : process.env;
      return new Promise((resolve, reject) => {
        execFile(bin, args, { env, timeout: timeoutMs + 10_000, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
          const code = error && typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : null;
          if (code === 'ENOENT') { reject(gatewayError('unreachable', bin + ' is not on PATH')); return; }
          try {
            resolve(parseGatewayCliOutput(String(stdout), error ? (typeof error.code === 'number' ? error.code : 1) : 0));
          } catch (e) {
            reject(e);
          }
        });
      });
    },
  };
}

/** The verified channel of one sessions.list row. */
export function gatewayChannel(row: Record<string, unknown>): ArchiveChannel {
  const chatType = row.chatType;
  if (chatType !== 'direct' && chatType !== 'group' && chatType !== 'room') return { verified: false };
  const key = String(row.key ?? '');
  const cron = /:cron:([^:]+)/.exec(key);
  return { chatType, verified: true, ...(cron ? { cronJob: cron[1] } : {}) };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' && typeof (b as Record<string, unknown>).text === 'string')
    .map(b => String(b.text))
    .filter(t => t.trim())
    .join('\n')
    .trim();
}

function messageTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return typeof value === 'string' ? utcTimestamp(value) : '';
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

async function readHistory(transport: GatewayTransport, sessionKey: string): Promise<{ sessionId?: string; messages: TranscriptMessage[] }> {
  const pages: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = asRecord(await transport.call('chat.history', { sessionKey, limit: HISTORY_PAGE, ...(offset ? { offset } : {}) }));
    pages.push(page);
    if (page.hasMore !== true || typeof page.nextOffset !== 'number' || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  const seen = new Set<string>();
  const messages: TranscriptMessage[] = [];
  for (const page of pages.reverse()) {
    for (const raw of Array.isArray(page.messages) ? page.messages : []) {
      const m = asRecord(raw);
      const id = asRecord(m.__openclaw).id;
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = messageText(m.content);
      const timestamp = messageTimestamp(m.timestamp);
      if (!text || !timestamp) continue;
      messages.push({ role: m.role, timestamp, text });
    }
  }
  const sessionId = pages.map(p => p.sessionId).find((v): v is string => typeof v === 'string');
  return { ...(sessionId ? { sessionId } : {}), messages };
}

export function openclawGatewayReader(opts: { transport?: GatewayTransport } = {}) {
  const transport = opts.transport ?? cliGatewayTransport();
  return {
    harness: 'openclaw' as const,
    name: 'openclaw-gateway',
    async list(listOpts: { sinceMs?: number } = {}): Promise<GatewayConversation[]> {
      const rows: Array<Record<string, unknown>> = [];
      let offset = 0;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = asRecord(await transport.call('sessions.list', { limit: LIST_PAGE, ...(offset ? { offset } : {}) }));
        for (const row of Array.isArray(page.sessions) ? page.sessions : []) rows.push(asRecord(row));
        if (page.hasMore !== true || typeof page.nextOffset !== 'number' || page.nextOffset <= offset) break;
        offset = page.nextOffset;
      }
      const out: GatewayConversation[] = [];
      for (const row of rows) {
        const key = typeof row.key === 'string' ? row.key : '';
        if (!key) continue;
        const updated = typeof row.updatedAt === 'number' ? row.updatedAt : null;
        if (listOpts.sinceMs !== undefined && updated !== null && updated < listOpts.sinceMs) continue;
        const history = await readHistory(transport, key);
        if (history.messages.length === 0) continue;
        const sessionId = typeof row.sessionId === 'string' ? row.sessionId : history.sessionId ?? key;
        out.push({
          harness: 'openclaw',
          conversationKey: key,
          via: 'gateway',
          channel: gatewayChannel(row),
          session: {
            meta: {
              harness: 'openclaw',
              sessionId,
              startedAt: history.messages[0]!.timestamp,
              raw: { session_id: sessionId, conversation: conversationHash8('openclaw', key), agent_id: typeof row.agentId === 'string' ? row.agentId : null, chat_type: typeof row.chatType === 'string' ? row.chatType : null },
            },
            messages: history.messages,
          },
        });
      }
      return out;
    },
  };
}
