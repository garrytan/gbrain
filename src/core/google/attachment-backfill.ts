import type { BrainEngine } from '../engine.ts';
import { withConnectorSync, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { OperationError } from '../ops/contract.ts';
import { GmailClient, GoogleCursorExpiredError, type FetchImpl } from './google-clients.ts';
import type { GmailThreadAttachmentReceipts, GoogleSourceConfig, GoogleSourceState } from './types.ts';
import { threadAttachmentReceipts } from './attachment-receipts.ts';
import { CommandAccessProvider, EnvAccessProvider, type GoogleAccessProvider } from './access.ts';
import { credentialId, openVault, type CredentialVault } from '../creds/vault.ts';
import { GOOGLE_PROVIDER, GoogleTokenProvider } from '../creds/providers/google.ts';
import { CredentialError } from '../creds/errors.ts';

export const GMAIL_ATTACHMENT_BACKFILL_LIMIT = 25;

export async function runGoogleAttachmentBackfill(engine: BrainEngine, sourceId: string, cfg: GoogleSourceConfig,
  opts: { limit?: number; signal?: AbortSignal; retryFailed?: boolean } = {}, fetchImpl: FetchImpl = fetch, vaultOverride?: CredentialVault) {
  return withConnectorSync(engine, sourceId, 'google', cfg, {
    sourceId, noEmbed: true, noExtract: true, noSchemaPack: true, signal: opts.signal, retryFailed: opts.retryFailed,
  }, async (managed, options) => {
    if (!managed) throw new OperationError('writer_coordinator_required', 'Historical attachment repair requires managed persistence. No metadata was changed.');
    if (!cfg.account || !cfg.services.includes('gmail')) throw new OperationError('invalid_params', 'Select a Gmail source for attachment repair.');
    let tokens: GoogleAccessProvider;
    if (cfg.access === 'command') tokens = new CommandAccessProvider(cfg.tokenCommand ?? '');
    else if (cfg.access === 'env') tokens = new EnvAccessProvider(cfg.tokenEnv ?? '');
    else {
      const vault = vaultOverride ?? openVault();
      const id = credentialId(GOOGLE_PROVIDER, cfg.account);
      const entry = await vault.get(id);
      if (!entry) throw new CredentialError('not_connected');
      if (entry.meta.scopes?.length && !entry.meta.scopes.includes('https://www.googleapis.com/auth/gmail.readonly')) throw new CredentialError('scope_missing');
      tokens = new GoogleTokenProvider(vault, id, fetchImpl);
    }
    const gmail = new GmailClient(tokens, fetchImpl);
    const profile = await gmail.getProfile({ signal: options.signal });
    if (profile.emailAddress?.toLowerCase() !== cfg.account) {
      throw new OperationError('source_changed', 'The Gmail credential belongs to a different account. No metadata was changed.');
    }
    await managed.assertAccount({ kind: 'google', email: cfg.account });
    const state = managed.state<GoogleSourceState>({ gmail_history_id: null, gmail_backfill_floor_ms: null,
      gmail_backfill_done: false, gmail_newest_ms: null, calendar_sync_token: null, contacts_sync_token: null, last_full_at: null });
    return backfillGmailAttachments(engine, managed, gmail, state, cfg.account, opts.limit, options.signal);
  });
}

export async function backfillGmailAttachments(engine: BrainEngine, managed: ManagedConnectorSync, gmail: GmailClient,
  state: GoogleSourceState, account: string, limit = GMAIL_ATTACHMENT_BACKFILL_LIMIT, signal?: AbortSignal) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GMAIL_ATTACHMENT_BACKFILL_LIMIT) {
    throw new OperationError('invalid_params', `Attachment backfill limit must be 1-${GMAIL_ATTACHMENT_BACKFILL_LIMIT}.`);
  }
  let cursor = state.gmail_attachment_backfill;
  if (cursor && (cursor.version !== 1 || cursor.account !== account || !Number.isSafeInteger(cursor.afterPageId) ||
    !Number.isSafeInteger(cursor.throughPageId) || !Number.isSafeInteger(cursor.inspected) || cursor.inspected < 0 || typeof cursor.complete !== 'boolean' ||
    !Number.isSafeInteger(cursor.unavailable ?? 0) || (cursor.unavailable ?? 0) < 0 ||
    !Number.isSafeInteger(cursor.unavailableMessages ?? 0) || (cursor.unavailableMessages ?? 0) < 0 ||
    cursor.afterPageId < 0 || cursor.throughPageId < cursor.afterPageId)) {
    throw new OperationError('revision_conflict', 'Attachment backfill checkpoint does not match this account. No metadata was changed.');
  }
  if (!cursor) {
    const [row] = await engine.executeRaw<{ id: number | null }>(
      `SELECT MAX(id) AS id FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'thread_id' IS NOT NULL`, [managed.sourceId]);
    cursor = { version: 1, account, afterPageId: 0, throughPageId: Number(row?.id ?? 0), inspected: 0, complete: false };
    state.gmail_attachment_backfill = cursor;
    await managed.saveState(state);
  }
  if (cursor.complete) return { status: 'complete' as const, processed: 0, inspected: cursor.inspected,
    unavailable: cursor.unavailable ?? 0, unavailableMessages: cursor.unavailableMessages ?? 0,
    inspection_complete: !cursor.unavailable, complete: true };
  const rows = await engine.executeRaw<{ id: number; slug: string; thread_id: string; account: string }>(
    `SELECT id,slug,frontmatter->>'thread_id' AS thread_id,frontmatter->>'account' AS account FROM pages
     WHERE source_id=$1 AND id>$2 AND id<=$3 AND deleted_at IS NULL AND frontmatter->>'thread_id' IS NOT NULL ORDER BY id LIMIT $4`,
    [managed.sourceId, cursor.afterPageId, cursor.throughPageId, limit]);
  let processed = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    if (row.account !== account || typeof row.thread_id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(row.thread_id)) {
      throw new OperationError('revision_conflict', 'Historical Gmail page ownership is unknown. Content and the current cursor were preserved.');
    }
    let fetched: GmailThreadAttachmentReceipts;
    try {
      const thread = await gmail.getThread(row.thread_id, account, { signal, metadataOnly: true });
      if (thread.threadId !== row.thread_id || !thread.messages.length) {
        throw new OperationError('revision_conflict', 'Gmail metadata does not match the historical page. Content and the current cursor were preserved.');
      }
      fetched = threadAttachmentReceipts(thread);
    } catch (error) {
      if (!(error instanceof GoogleCursorExpiredError) || error.status !== 404) throw error;
      fetched = { version: 1, account, threadId: row.thread_id, unavailable: 'thread_not_found', messages: [] };
    }
    const receipts = await managed.patchGoogleReceipts(row.slug, fetched, Number(row.id));
    if (receipts.messages.some(m => !m.unavailable && (m.inspection.state === 'incomplete' || m.inspection.state === 'not_inspected'))) {
      return { status: 'incomplete' as const, processed, inspected: cursor.inspected,
        unavailable: cursor.unavailable ?? 0, unavailableMessages: cursor.unavailableMessages ?? 0, inspection_complete: false, complete: false };
    }
    const unavailable = receipts.messages.filter(m => m.unavailable).length;
    processed++;
    cursor = { ...cursor, afterPageId: Number(row.id), inspected: cursor.inspected + (unavailable ? 0 : 1),
      unavailable: (cursor.unavailable ?? 0) + (unavailable ? 1 : 0), unavailableMessages: (cursor.unavailableMessages ?? 0) + unavailable };
    state.gmail_attachment_backfill = cursor;
    await managed.saveState(state);
  }
  if (rows.length < limit || cursor.afterPageId === cursor.throughPageId) {
    cursor = { ...cursor, complete: true };
    state.gmail_attachment_backfill = cursor;
    await managed.saveState(state);
  }
  return { status: cursor.complete ? 'complete' as const : 'paused' as const, processed, inspected: cursor.inspected,
    unavailable: cursor.unavailable ?? 0, unavailableMessages: cursor.unavailableMessages ?? 0,
    inspection_complete: cursor.complete && !cursor.unavailable, complete: cursor.complete };
}
