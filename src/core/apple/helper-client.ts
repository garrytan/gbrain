/**
 * The GBrain Helper's iMessage routes, read over 127.0.0.1 only: `GET /v1/imessage/threads` (recent chats) and
 * `GET /v1/imessage/thread` (one chat's messages after a cursor). The token travels as a bearer header, never in a
 * query string. Failures map to the helper's own codes: nothing listening (`apple_helper_not_running`), a token the
 * helper refuses (`apple_helper_unauthorized`), Full Disk Access off (`apple_full_disk_access_pending`) and a Messages
 * database macOS changed (`apple_schema_mismatch`); each stops the whole run. Any other refusal is an item error.
 */
import { OperationError } from '../ops/contract.ts';
import { ConnectorHttpError, ConnectorResponseTooLargeError, type ConnectorFetch } from '../connectors/client.ts';
import type { IMessageMessage, IMessageThread } from '../imessage/types.ts';

/** Chats listed per run, most recent first (the helper's own maximum). */
export const IMESSAGE_THREADS_LIMIT = 200;
const MESSAGES_PAGE = 500;
/** Cursor pages one chat may walk in a run before the run stops partial. */
const MAX_PAGES = 200;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** A helper response missing a field it must carry: the chat is held, never published partially. */
export class IMessageShapeDriftError extends Error {
  readonly code = 'connector_shape_drift';
  constructor(what: string) {
    super(`imessage: the helper response is missing ${what}; the helper and gbrain may be out of step`);
    this.name = 'IMessageShapeDriftError';
  }
}

const DOCS = 'docs/guides/apple-setup.md';

export function helperNotRunning(sourceId: string, port: number | null, detail: string): OperationError {
  return new OperationError('apple_helper_not_running',
    port === null ? `iMessage source ${sourceId} has no helper port configured (${detail}). Nothing was imported.`
      : `Nothing answered on 127.0.0.1:${port} for iMessage source ${sourceId} (${detail}). The helper is stopped or the Mac is asleep. Nothing was imported.`,
    `Start GBrain Helper on this Mac and check that gbrain config get apple.helper.port names its port, then run: gbrain sync --source ${sourceId}`,
    `${DOCS}#apple_helper_not_running`);
}

function helperUnauthorized(sourceId: string): OperationError {
  return new OperationError('apple_helper_unauthorized', `GBrain Helper refused the token for iMessage source ${sourceId}. Nothing was imported.`,
    `Save the helper's current token for gbrain (the 0600 file ~/.gbrain/connectors/imessage.json, or the source's token variable), then run: gbrain sync --source ${sourceId}`,
    `${DOCS}#apple_helper_unauthorized`);
}

function fullDiskAccessPending(sourceId: string): OperationError {
  return new OperationError('apple_full_disk_access_pending', `GBrain Helper cannot read Messages for iMessage source ${sourceId}: Full Disk Access is off. Nothing was imported.`,
    `Ask the user to open System Settings > Privacy & Security > Full Disk Access and switch on GBrain Helper, then run: gbrain sync --source ${sourceId}`,
    `${DOCS}#apple_full_disk_access_pending`);
}

function schemaMismatch(sourceId: string): OperationError {
  return new OperationError('apple_schema_mismatch', `GBrain Helper does not recognise the Messages database for iMessage source ${sourceId}; macOS may have changed it. Nothing was imported.`,
    `Update GBrain and the GBrain Helper to their newest versions, then run: gbrain sync --source ${sourceId}`,
    `${DOCS}#apple_schema_mismatch`);
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export interface IMessageHelperOpts {
  sourceId: string;
  port: number;
  token: string;
  fetchImpl?: ConnectorFetch;
}

export interface IMessageHelper {
  threads(signal?: AbortSignal): Promise<IMessageThread[]>;
  /** Every message of one chat at or after `sinceIso`, oldest first. */
  messages(threadId: string, sinceIso: string, signal?: AbortSignal): Promise<IMessageMessage[]>;
}

export function imessageHelper(opts: IMessageHelperOpts): IMessageHelper {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as ConnectorFetch);
  const base = `http://127.0.0.1:${opts.port}`;
  async function get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${opts.token}`, accept: 'application/json' },
        redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw helperNotRunning(opts.sourceId, opts.port, error instanceof Error ? error.message : String(error));
    }
    const text = await readBounded(res, path);
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = {}; }
    if (res.ok) return body;
    const code = str(body.code) ?? str((body.type as string | undefined)?.split('/').pop());
    if (res.status === 401 || code === 'unauthorized' || code === 'insufficient_scope') throw helperUnauthorized(opts.sourceId);
    if (code === 'source_disabled') throw helperNotRunning(opts.sourceId, opts.port, 'the helper has its iMessage source turned off');
    if (code === 'no_access') throw fullDiskAccessPending(opts.sourceId);
    if (code === 'schema_mismatch') throw schemaMismatch(opts.sourceId);
    throw new ConnectorHttpError(`imessage: the helper answered ${res.status}${code ? ` (${code})` : ''} for ${path}`, res.status);
  }
  return {
    async threads(signal) {
      const body = await get('/v1/imessage/threads', { limit: String(IMESSAGE_THREADS_LIMIT) }, signal);
      if (!Array.isArray(body.data)) throw new IMessageShapeDriftError('threads.data');
      return body.data.map((raw: Record<string, unknown>) => {
        const threadId = str(raw?.thread_id);
        if (!threadId) throw new IMessageShapeDriftError('threads.data[].thread_id');
        const lastMessageAt = raw.last_message_at ?? null;
        if (lastMessageAt !== null && !(typeof lastMessageAt === 'string' && Number.isFinite(Date.parse(lastMessageAt)))) {
          throw new IMessageShapeDriftError('threads.data[].last_message_at');
        }
        return { threadId, displayName: str(raw.display_name), participants: Array.isArray(raw.participants) ? raw.participants.filter((p): p is string => typeof p === 'string') : [],
          isGroup: raw.is_group === true, lastMessageAt };
      });
    },
    async messages(threadId, sinceIso, signal) {
      const out: IMessageMessage[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await get('/v1/imessage/thread', { thread_id: threadId, limit: String(MESSAGES_PAGE),
          ...(cursor ? { since_rowid: cursor } : { since_iso: sinceIso }) }, signal);
        const data = body.data as Record<string, unknown> | undefined;
        if (!data || !Array.isArray(data.messages)) throw new IMessageShapeDriftError('thread.data.messages');
        for (const raw of data.messages as Record<string, unknown>[]) out.push(parseMessage(raw));
        const meta = (body.meta ?? {}) as Record<string, unknown>;
        const more = data.has_more ?? meta.has_more;
        const next = data.next_since_rowid ?? meta.next_since_rowid;
        if (more !== true) return out.filter(m => m.timestamp >= sinceIso).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.rowid - b.rowid);
        if (typeof next !== 'number' && typeof next !== 'string') throw new IMessageShapeDriftError('thread.next_since_rowid');
        cursor = String(next);
      }
      throw new ConnectorHttpError(`imessage: one chat returned more than ${MAX_PAGES} pages`, 500);
    },
  };
}

function parseMessage(raw: Record<string, unknown>): IMessageMessage {
  const id = str(raw?.id);
  const timestamp = str(raw?.timestamp);
  const rowid = Number(raw?.rowid);
  if (!id || !timestamp || !Number.isFinite(Date.parse(timestamp)) || !Number.isSafeInteger(rowid)) throw new IMessageShapeDriftError('thread.data.messages[] id, rowid or timestamp');
  const status = raw.text_status === 'empty' || raw.text_status === 'undecodable' ? raw.text_status : 'ok';
  return { id, rowid, timestamp: new Date(timestamp).toISOString(), isFromMe: raw.is_from_me === true, text: typeof raw.text === 'string' ? raw.text : null,
    textStatus: status, from: str(raw.from), hasAttachments: raw.has_attachments === true, editedAt: str(raw.edited_at), retracted: raw.retracted === true };
}

async function readBounded(res: Response, path: string): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ConnectorResponseTooLargeError(path, MAX_RESPONSE_BYTES);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
