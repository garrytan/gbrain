/**
 * google/gbrainio-gmail: read Gmail through a gbrain.io terminal.
 *
 * A Google source with 'g_access: gbrainio' never holds a Google token. It
 * runs the 'gbrainio' command line (a gbrain.io terminal the owner connected
 * for this machine) and reads its JSON answers: 'tool gmail message search',
 * 'thread show', 'label ls' and 'send-as ls'. The terminal's own credential
 * stays inside the gbrainio client; the source config stores only the
 * command path, the same trust class as '--access command'.
 *
 * gbrain.io answers carry no Gmail label ids, no header list and no history
 * id. The reader rebuilds what the renderer and the loop detector read:
 *  - SENT and DRAFT from each message's 'state';
 *  - bulk mail from gbrain.io's own 'automated' (strong or weak) flag;
 *  - CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_FORUMS, STARRED and
 *    IMPORTANT by one extra listing per tag over the range a window listing
 *    covered, each drained to its end. A tag listing that is cut short
 *    throws, so a window is never banked with promotions read as real mail.
 * There is no change feed, so supportsHistory is false and the sweep runs in
 * window mode (google-source.ts).
 */

import { promisify } from 'node:util';

import { CredentialError } from '../creds/errors.ts';
import { execFile } from '../spawn.ts';
import { truncateUtf8 } from '../text-safe.ts';
import { GoogleCursorExpiredError, type GmailListOptions } from './google-clients.ts';
import { trimQuotedReply } from './google-render.ts';
import {
  bareAddress,
  splitAddressList,
  type GmailAttachmentInspection,
  type GmailAttachmentReceipt,
  type GmailMessageMeta,
  type GmailThreadData,
} from './types.ts';

const execFileAsync = promisify(execFile);

/** Gmail message and thread ids are hex; anything else never reaches a hold key, slug or path. */
const GMAIL_ID = /^[A-Za-z0-9]{1,128}$/;
const PAGE_LIMIT = 25;
const COMMAND_TIMEOUT_MS = 120_000;
/** A tag listing that would need more pages than this is treated as cut short. */
const TAG_MAX_PAGES = 400;
const BODY_CAP = 8_000;

/** Each tag listing, and the label it stands for on the messages it lists. */
export const GBRAINIO_TAG_QUERIES: ReadonlyArray<{ query: string; label: string }> = [
  { query: 'category:promotions', label: 'CATEGORY_PROMOTIONS' },
  { query: 'category:social', label: 'CATEGORY_SOCIAL' },
  { query: 'category:forums', label: 'CATEGORY_FORUMS' },
  { query: 'is:starred', label: 'STARRED' },
  { query: 'is:important', label: 'IMPORTANT' },
];

export interface GbrainioRunResult { exitCode: number; stdout: string; stderr: string }
export type GbrainioRun = (command: string, args: string[], signal?: AbortSignal) => Promise<GbrainioRunResult>;

async function defaultRun(command: string, args: string[], signal?: AbortSignal): Promise<GbrainioRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown; name?: string };
    if (err.name === 'AbortError') throw e;
    if (err.code === 'ENOENT') throw new CredentialError('gbrainio_command_missing', ' (' + command + ')');
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(e),
    };
  }
}

/** Test seam: fixtures replace the runner instead of spawning the real command line. */
export const gbrainioRunner: { run: GbrainioRun } = { run: defaultRun };

interface MessageTags { labels: Set<string>; automated: 'strong' | 'weak' | null; state: string | null }
interface ListedMessage { id: string; threadId: string; receivedMs: number; automated: 'strong' | 'weak' | null; state: string | null }

/** The first line of a failure, capped, with anything shaped like a gbrain.io key removed. */
function oneLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').replace(/\bgb[a-z]_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 300);
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

function automatedFlag(v: unknown): 'strong' | 'weak' | null {
  return v === 'strong' || v === 'weak' ? v : null;
}

export class GbrainioGmailReader {
  readonly supportsHistory = false;
  private readonly tags = new Map<string, MessageTags>();
  private readonly account: string;

  constructor(
    private readonly command: string,
    account: string,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.account = account.trim().toLowerCase();
  }

  private async call(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const argv = ['tool', 'gmail', ...args, '-a', this.account, '-f', 'json'];
    const res = await gbrainioRunner.run(this.command, argv, signal);
    const text = res.stderr || res.stdout;
    if (res.exitCode === 4) throw new CredentialError('gbrainio_not_connected', ' (' + oneLine(text) + ')');
    if (res.exitCode === 3) throw new GoogleCursorExpiredError(404, 'gbrainio:' + args.slice(0, 2).join(' '));
    if (res.exitCode !== 0) {
      if (res.exitCode !== 2 && /\blimit\b|\ballowance\b|\bpaused\b/i.test(text)) {
        throw new CredentialError('gbrainio_limit_reached', ' (' + oneLine(text) + ')');
      }
      throw new CredentialError('gbrainio_command_failed', ' (exit ' + res.exitCode + ': ' + oneLine(text) + ')');
    }
    let body: unknown;
    try { body = JSON.parse(res.stdout); } catch {
      throw new CredentialError('gbrainio_command_failed', ' (the answer was not JSON)');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CredentialError('gbrainio_command_failed', ' (unexpected answer shape)');
    }
    const answer = body as Record<string, unknown>;
    this.assertAccount(answer.account);
    return answer;
  }

  private assertAccount(value: unknown): void {
    if (typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== this.account) {
      throw new CredentialError('gbrainio_account_mismatch', ' (asked for ' + this.account + ', the answer named another account)');
    }
  }

  /** Mail is read only from an answer that names the pinned account. */
  private requireAccount(value: unknown): void {
    if (typeof value !== 'string' || !value.trim()) {
      throw new CredentialError('gbrainio_account_mismatch', ' (asked for ' + this.account + ', the answer named no account)');
    }
    this.assertAccount(value);
  }

  /** Account check: gbrain.io has no history id, so historyId is always ''. */
  async getProfile(opts: { signal?: AbortSignal } = {}): Promise<{ emailAddress: string; historyId: string }> {
    await this.call(['label', 'ls'], opts.signal);
    return { emailAddress: this.account, historyId: '' };
  }

  async getLabels(opts: { signal?: AbortSignal } = {}): Promise<Array<{ id: string; name: string; type: string }>> {
    const answer = await this.call(['label', 'ls'], opts.signal);
    const rows = Array.isArray(answer.labels) ? answer.labels : [];
    return rows.flatMap((l) => {
      const row = (l ?? {}) as Record<string, unknown>;
      const name = str(row.name);
      const id = str(row.id) || name;
      return name ? [{ id, name, type: str(row.type) || (id === name ? 'system' : 'user') }] : [];
    });
  }

  /** The other addresses this mailbox sends as, best effort; an answer we cannot read gives none. */
  async sendAsAliases(opts: { signal?: AbortSignal } = {}): Promise<string[]> {
    let answer: Record<string, unknown>;
    try {
      answer = await this.call(['send-as', 'ls'], opts.signal);
    } catch (e) {
      if (e instanceof CredentialError && e.code !== 'gbrainio_command_failed') throw e;
      this.log('[google] gbrain.io send-as list unavailable; owner detection uses the account address only');
      return [];
    }
    const found = new Set<string>();
    const visit = (v: unknown, key: string): void => {
      if (typeof v === 'string') {
        if (!/address|email|send_?as/i.test(key)) return;
        const a = bareAddress(v);
        if (/^[^@\s]+@[^@\s]+$/.test(a)) found.add(a);
      } else if (Array.isArray(v)) {
        for (const x of v) visit(x, key);
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) visit(x, k);
      }
    };
    visit(answer, '');
    found.delete(this.account);
    return [...found];
  }

  /** Every page of one search. maxPages bounds it; past the bound, partialOk keeps what was listed. */
  private async search(query: string, opts: { signal?: AbortSignal; maxPages: number; partialOk: boolean; onCutShort?: () => void }): Promise<ListedMessage[]> {
    const out: ListedMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= opts.maxPages) {
        if (opts.partialOk) {
          opts.onCutShort?.();
          return out;
        }
        throw new CredentialError('gbrainio_command_failed', ' (a listing needed more than ' + opts.maxPages + ' pages; it is treated as cut short)');
      }
      const args = ['message', 'search', query, '--limit', String(PAGE_LIMIT), ...(cursor ? ['--cursor', cursor] : [])];
      const answer = await this.call(args, opts.signal);
      const rows = Array.isArray(answer.messages) ? answer.messages : [];
      for (const r of rows) {
        const row = (r ?? {}) as Record<string, unknown>;
        this.requireAccount(row.account ?? answer.account);
        const id = str(row.id);
        const threadId = str(row.thread_id);
        if (!GMAIL_ID.test(id) || !GMAIL_ID.test(threadId)) {
          throw new CredentialError('gbrainio_command_failed', ' (a search answer carried a malformed message or thread id)');
        }
        out.push({
          id,
          threadId,
          receivedMs: Date.parse(str(row.received_at) || str(row.date)) || 0,
          automated: automatedFlag(row.automated),
          state: str(row.state) || null,
        });
      }
      const next = str(answer.next_cursor);
      if (!next || answer.more === false || rows.length === 0) return out;
      cursor = next;
    }
  }

  private tagsFor(id: string): MessageTags {
    let t = this.tags.get(id);
    if (!t) { t = { labels: new Set(), automated: null, state: null }; this.tags.set(id, t); }
    return t;
  }

  /**
   * Message ids for a Gmail query, newest first. For a window query
   * ('after:<epoch> before:<epoch>', what the floor walk sends) each tag
   * listing runs over the range the main listing reached, drained to its end.
   */
  async listMessageIds(q: string, opts: GmailListOptions = {}): Promise<Array<{ id: string; threadId: string }>> {
    const signal = opts.signal;
    const rows = await this.search(q, {
      ...(signal ? { signal } : {}),
      maxPages: Math.max(1, (opts.maxPages ?? 20) * 4),
      partialOk: opts.partialOk ?? false,
      ...(opts.onCutShort ? { onCutShort: opts.onCutShort } : {}),
    });
    for (const r of rows) {
      const t = this.tagsFor(r.id);
      t.automated = r.automated;
      t.state = r.state;
    }
    const before = /before:(\d+)/.exec(q)?.[1];
    const windowAfter = /after:(\d+)/.exec(q)?.[1];
    if (rows.length > 0 && before && windowAfter) {
      const dated = rows.map((r) => r.receivedMs).filter((ms) => ms > 0);
      const after = dated.length > 0 ? Math.max(Number(windowAfter), Math.floor(Math.min(...dated) / 1000) - 1) : Number(windowAfter);
      for (const tag of GBRAINIO_TAG_QUERIES) {
        const tagged = await this.search('after:' + after + ' before:' + before + ' ' + tag.query, {
          ...(signal ? { signal } : {}),
          maxPages: TAG_MAX_PAGES,
          partialOk: false,
        });
        for (const r of tagged) this.tagsFor(r.id).labels.add(tag.label);
      }
    }
    return rows.map((r) => ({ id: r.id, threadId: r.threadId }));
  }

  async listHistoryThreadIds(): Promise<never> {
    throw new CredentialError('gbrainio_unsupported', ' (gbrain.io has no change feed)');
  }

  async getThread(threadId: string, account: string, opts: { signal?: AbortSignal; bodyCapChars?: number } = {}): Promise<GmailThreadData> {
    if (!GMAIL_ID.test(threadId)) throw new CredentialError('gbrainio_command_failed', ' (malformed thread id)');
    const answer = await this.call(['thread', 'show', threadId], opts.signal);
    if (str(answer.thread_id) && str(answer.thread_id) !== threadId) {
      throw new CredentialError('gbrainio_command_failed', ' (the answer named another thread)');
    }
    const cap = opts.bodyCapChars ?? BODY_CAP;
    const raw = Array.isArray(answer.messages) ? answer.messages : [];
    const messages: GmailMessageMeta[] = raw.map((m, index) => {
      const row = (m ?? {}) as Record<string, unknown>;
      this.requireAccount(row.account ?? answer.account);
      const id = str(row.id);
      if (!GMAIL_ID.test(id)) throw new CredentialError('gbrainio_command_failed', ' (a thread answer carried a malformed message id)');
      const known = this.tags.get(id);
      const state = str(row.state) || known?.state || '';
      const automated = automatedFlag(row.automated) ?? known?.automated ?? null;
      const labelIds = [...(known?.labels ?? [])];
      if (state === 'sent') labelIds.push('SENT');
      if (state === 'draft') labelIds.push('DRAFT');
      const internalDateMs = Date.parse(str(row.received_at) || str(row.date)) || 0;
      const fromRaw = str(row.from);
      let bodyText = trimQuotedReply(truncateUtf8(str(row.body), cap * 4));
      if (bodyText.length > cap) bodyText = truncateUtf8(bodyText, cap) + '\n[truncated]';
      if (row.omitted === true && !bodyText) bodyText = '_message omitted by gbrain.io (conversation cut to fit)_';
      const attachments = Array.isArray(row.attachments) ? (row.attachments as Array<Record<string, unknown>>) : null;
      const calendar = str(row.body_mime_type).toLowerCase().startsWith('text/calendar')
        || (attachments ?? []).some((a) => str(a.mime_type ?? a.mimeType).toLowerCase().startsWith('text/calendar'));
      return {
        id,
        threadId,
        from: fromRaw,
        fromAddress: bareAddress(fromRaw),
        to: splitAddressList(str(row.to)),
        cc: splitAddressList(str(row.cc)),
        subject: str(row.subject),
        dateIso: new Date(internalDateMs).toISOString(),
        internalDateMs,
        labelIds,
        listUnsubscribe: automated === 'strong',
        ...(automated === 'strong' ? { precedence: 'bulk' } : {}),
        ...(automated === 'weak' ? { listId: true } : {}),
        replyTo: splitAddressList(str(row.reply_to)),
        calendarMethod: calendar ? '' : null,
        bodyText,
        attachmentInspection: inspectAttachments(attachments, account, id, index),
      };
    });
    messages.sort((a, b) => a.internalDateMs - b.internalDateMs);
    return { threadId, account, messages };
  }

  /** Whether gbrain.io named this message automated in a listing this run. */
  automatedOf(messageId: string): 'strong' | 'weak' | null {
    return this.tags.get(messageId)?.automated ?? null;
  }
}

function inspectAttachments(attachments: Array<Record<string, unknown>> | null, account: string, messageId: string, index: number): GmailAttachmentInspection {
  if (attachments === null) return { state: 'not_inspected', attachments: [] };
  if (attachments.length === 0) return { state: 'none', attachments: [] };
  const receipts: GmailAttachmentReceipt[] = attachments.map((a, i) => {
    const mimeType = str(a.mime_type ?? a.mimeType) || 'application/octet-stream';
    const size = typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : null;
    return {
      id: account + ':' + messageId + ':gbrainio-' + index + '-' + i,
      account,
      messageId,
      partId: 'gbrainio-' + i,
      filename: str(a.filename ?? a.name),
      mimeType,
      size,
      attachmentId: str(a.attachment_id ?? a.id) || null,
      kind: mimeType.toLowerCase().startsWith('text/calendar') ? 'calendar' : 'document',
      fetched: false,
      indexed: false,
    };
  });
  return { state: 'present', attachments: receipts };
}
