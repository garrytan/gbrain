import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import type { WhatsAppMessage } from './extractor.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 200;
const DEFAULT_STALE_AFTER_HOURS = 24;
const CHECKPOINT_VERSION = 1;
const MAX_IDS_AT_AFTER = 5000;
const CHECKPOINT_LOCK_RETRY_MS = 25;
const checkpointLocks = new Map<string, Promise<void>>();

export type WacliStoreKey = 'personal' | 'business' | string;

export interface WacliStoreConfig {
  key: WacliStoreKey;
  storePath: string;
}

export interface WacliStoreCheckpoint {
  after: string | null;
  message_ids_at_after: string[];
  updated_at: string | null;
}

export interface WacliCollectorCheckpointState {
  version: number;
  stores: Record<string, WacliStoreCheckpoint>;
}

export interface CollectedWhatsAppMessage extends WhatsAppMessage {
  ChatJID: string | null;
  SenderJID: string | null;
  FromMe: boolean;
  store_key: string;
  store_path: string;
}

export type WacliDegradedReason =
  | 'command_failed'
  | 'invalid_payload'
  | 'checkpoint_read_failed'
  | 'last_sync_unknown'
  | 'last_sync_stale';

export type WacliHealthStatus = 'healthy' | 'degraded' | 'failed';

export interface WacliStoreCollectionResult {
  storeKey: string;
  storePath: string;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  batchSize: number;
  lastSyncAt: string | null;
  degraded: boolean;
  degradedReason: WacliDegradedReason | null;
  error: string | null;
  messages: CollectedWhatsAppMessage[];
}

export interface WacliCollectionResult {
  collectedAt: string;
  checkpointPath: string;
  limit: number;
  staleAfterHours: number;
  stores: WacliStoreCollectionResult[];
  messages: CollectedWhatsAppMessage[];
  degraded: boolean;
  checkpoint: WacliCollectorCheckpointState;
}

export interface WacliHealthSummary {
  status: WacliHealthStatus;
  lastSyncAt: string | null;
  staleStoreKeys: string[];
  disconnectedStoreKeys: string[];
  alerts: string[];
}

export interface WacliListRequest {
  storePath: string;
  after: string | null;
  limit: number;
}

export interface CollectWacliMessagesOptions {
  stores?: WacliStoreConfig[];
  limit?: number;
  staleAfterHours?: number;
  checkpointPath?: string;
  persistCheckpoint?: boolean;
  now?: Date;
  runner?: WacliListMessagesRunner;
}

export type WacliListMessagesRunner = (request: WacliListRequest) => Promise<unknown>;

interface ParseListResult {
  ok: boolean;
  messages: CollectedWhatsAppMessage[];
  error: string | null;
  degradedReason: WacliDegradedReason | null;
}

interface WacliPayloadLike {
  success?: unknown;
  data?: {
    messages?: unknown;
  };
  error?: unknown;
}

export async function collectWacliMessages(
  options: CollectWacliMessagesOptions = {}
): Promise<WacliCollectionResult> {
  const now = options.now ? ensureDate(options.now, 'now') : new Date();
  const stores = normalizeStores(options.stores ?? resolveWacliStoresFromEnv());
  const limit = normalizeLimit(options.limit);
  const staleAfterHours = normalizeStaleAfterHours(options.staleAfterHours);
  const checkpointPath = options.checkpointPath ?? defaultCollectorCheckpointPath();
  const persistCheckpoint = options.persistCheckpoint ?? true;
  const runner = options.runner ?? runWacliMessagesList;

  return withCheckpointLock(checkpointPath, async () => {
    const checkpointRead = await readWacliCollectorCheckpointForCollect(checkpointPath);
    const checkpoint = checkpointRead.checkpoint;
    const nextCheckpoint: WacliCollectorCheckpointState = {
      version: CHECKPOINT_VERSION,
      stores: { ...checkpoint.stores },
    };

    if (checkpointRead.error) {
      const failedStores = stores.map((store) => ({
        storeKey: store.key,
        storePath: store.storePath,
        checkpointBefore: null,
        checkpointAfter: null,
        batchSize: 0,
        lastSyncAt: null,
        degraded: true,
        degradedReason: 'checkpoint_read_failed' as const,
        error: checkpointRead.error,
        messages: [],
      }));
      return {
        collectedAt: now.toISOString(),
        checkpointPath,
        limit,
        staleAfterHours,
        stores: failedStores,
        messages: [],
        degraded: true,
        checkpoint: nextCheckpoint,
      };
    }

    const storeResults: WacliStoreCollectionResult[] = [];
    const allMessages: CollectedWhatsAppMessage[] = [];
    let checkpointDirty = false;

    for (const store of stores) {
      const existingCheckpoint = normalizeStoreCheckpoint(nextCheckpoint.stores[store.key]);
      const checkpointBefore = existingCheckpoint.after;
      let degradedReason: WacliDegradedReason | null = null;
      let error: string | null = null;
      let lastSyncAt: string | null = null;
      let newMessages: CollectedWhatsAppMessage[] = [];

      let incrementalPayload: unknown;
      try {
        incrementalPayload = await runner({
          storePath: store.storePath,
          after: existingCheckpoint.after,
          limit,
        });
      } catch (err) {
        degradedReason = 'command_failed';
        error = errorMessage(err);
      }

      if (!degradedReason) {
        const parsed = parseWacliListPayload(incrementalPayload, store);
        if (!parsed.ok) {
          degradedReason = parsed.degradedReason ?? 'invalid_payload';
          error = parsed.error;
        } else {
          lastSyncAt = latestTimestamp(parsed.messages);
          newMessages = filterMessagesAfterCheckpoint(parsed.messages, existingCheckpoint);
        }
      }

      if (!degradedReason && !lastSyncAt) {
        let latestPayload: unknown;
        try {
          latestPayload = await runner({
            storePath: store.storePath,
            after: null,
            limit: 1,
          });
        } catch (err) {
          degradedReason = 'command_failed';
          error = errorMessage(err);
        }

        if (!degradedReason) {
          const latestParsed = parseWacliListPayload(latestPayload, store);
          if (!latestParsed.ok) {
            degradedReason = latestParsed.degradedReason ?? 'invalid_payload';
            error = latestParsed.error;
          } else {
            lastSyncAt = latestTimestamp(latestParsed.messages);
          }
        }
      }

      if (!degradedReason) {
        if (!lastSyncAt) {
          degradedReason = 'last_sync_unknown';
        } else if (isTimestampStale(lastSyncAt, now, staleAfterHours)) {
          degradedReason = 'last_sync_stale';
        }
      }

      const nextStoreCheckpoint = advanceCheckpoint(existingCheckpoint, newMessages, now);
      if (!areStoreCheckpointsEqual(existingCheckpoint, nextStoreCheckpoint)) {
        nextCheckpoint.stores[store.key] = nextStoreCheckpoint;
        checkpointDirty = true;
      } else if (!nextCheckpoint.stores[store.key]) {
        nextCheckpoint.stores[store.key] = existingCheckpoint;
      }

      allMessages.push(...newMessages);
      storeResults.push({
        storeKey: store.key,
        storePath: store.storePath,
        checkpointBefore,
        checkpointAfter: nextStoreCheckpoint.after,
        batchSize: newMessages.length,
        lastSyncAt,
        degraded: degradedReason !== null,
        degradedReason,
        error,
        messages: newMessages,
      });
    }

    allMessages.sort(sortMessagesByTimestampThenIdThenStore);

    if (checkpointDirty && persistCheckpoint) {
      await writeWacliCollectorCheckpoint(checkpointPath, nextCheckpoint);
    }

    return {
      collectedAt: now.toISOString(),
      checkpointPath,
      limit,
      staleAfterHours,
      stores: storeResults,
      messages: allMessages,
      degraded: storeResults.some((store) => store.degraded),
      checkpoint: nextCheckpoint,
    };
  });
}

export function summarizeWacliHealth(
  stores: WacliStoreCollectionResult[],
  options: { now?: Date } = {}
): WacliHealthSummary {
  if (stores.length === 0) {
    return {
      status: 'failed',
      lastSyncAt: null,
      staleStoreKeys: [],
      disconnectedStoreKeys: [],
      alerts: ['No wacli stores configured.'],
    };
  }

  const now = options.now ? ensureDate(options.now, 'now') : new Date();
  const staleStoreKeys: string[] = [];
  const disconnectedStoreKeys: string[] = [];
  const alerts: string[] = [];

  // The collector checkpoint is global, not per-store. When it fails to read,
  // every store gets stamped with checkpoint_read_failed. Collapse those into a
  // single top-level alert instead of N identical per-store alerts.
  const checkpointFailedStore = stores.find(
    (store) => store.degradedReason === 'checkpoint_read_failed'
  );
  if (checkpointFailedStore) {
    const detail = checkpointFailedStore.error
      ? checkpointFailedStore.error
      : 'collector checkpoint unreadable';
    return {
      status: 'failed',
      lastSyncAt: latestWacliSyncAt(stores),
      staleStoreKeys: [],
      disconnectedStoreKeys: stores.map((store) => store.storeKey),
      alerts: [detail],
    };
  }

  for (const store of stores) {
    if (!store.degraded || !store.degradedReason) {
      continue;
    }

    if (store.degradedReason === 'last_sync_stale') {
      staleStoreKeys.push(store.storeKey);
      const lastSyncAt = store.lastSyncAt ?? 'unknown';
      const ageHours = store.lastSyncAt
        ? ((now.getTime() - Date.parse(store.lastSyncAt)) / (60 * 60 * 1000)).toFixed(1)
        : 'unknown';
      alerts.push(`Store "${store.storeKey}" stale: last sync ${lastSyncAt} (${ageHours}h ago).`);
      continue;
    }

    disconnectedStoreKeys.push(store.storeKey);
    const suffix = store.error ? ` ${store.error}` : '';
    alerts.push(`Store "${store.storeKey}" unhealthy (${store.degradedReason}).${suffix}`.trim());
  }

  const status: WacliHealthStatus =
    disconnectedStoreKeys.length > 0 ? 'failed' : staleStoreKeys.length > 0 ? 'degraded' : 'healthy';

  return {
    status,
    lastSyncAt: latestWacliSyncAt(stores),
    staleStoreKeys,
    disconnectedStoreKeys,
    alerts,
  };
}

export function resolveWacliStoresFromEnv(): WacliStoreConfig[] {
  const personalStorePath =
    asNonEmpty(process.env.ACTION_BRAIN_WACLI_PERSONAL_STORE)
    ?? asNonEmpty(process.env.WACLI_STORE_DIR)
    ?? join(homedir(), '.wacli');
  const businessStorePath = asNonEmpty(process.env.ACTION_BRAIN_WACLI_BUSINESS_STORE);

  const stores: WacliStoreConfig[] = [{ key: 'personal', storePath: personalStorePath }];
  if (businessStorePath && businessStorePath !== personalStorePath) {
    stores.push({ key: 'business', storePath: businessStorePath });
  }
  return stores;
}

export async function readWacliCollectorCheckpoint(
  checkpointPath = defaultCollectorCheckpointPath()
): Promise<WacliCollectorCheckpointState> {
  try {
    const raw = await readFile(checkpointPath, 'utf-8');
    return parseCheckpointState(raw);
  } catch {
    return emptyCheckpointState();
  }
}

export async function readWacliCollectorLastSyncAt(
  checkpointPath = defaultCollectorCheckpointPath()
): Promise<string | null> {
  const checkpoint = await readWacliCollectorCheckpoint(checkpointPath);
  return latestCheckpointSyncAt(checkpoint);
}

export async function writeWacliCollectorCheckpoint(
  checkpointPath: string,
  checkpoint: WacliCollectorCheckpointState
): Promise<void> {
  const normalized = {
    version: CHECKPOINT_VERSION,
    stores: normalizeCheckpointStores(checkpoint.stores),
  } satisfies WacliCollectorCheckpointState;

  await mkdir(dirname(checkpointPath), { recursive: true });
  const tmpPath = `${checkpointPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  try {
    await rename(tmpPath, checkpointPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // no-op cleanup best effort
    }
    throw err;
  }
}

export function latestCheckpointSyncAt(checkpoint: WacliCollectorCheckpointState): string | null {
  const entries = Object.values(checkpoint.stores ?? {});
  const timestamps = entries
    .map((entry) => normalizeTimestamp(entry.after))
    .filter((value): value is string => Boolean(value));

  if (timestamps.length === 0) {
    return null;
  }

  timestamps.sort();
  return timestamps[timestamps.length - 1] ?? null;
}

export function defaultCollectorCheckpointPath(): string {
  return join(homedir(), '.gbrain', 'action-brain', 'wacli-checkpoint.json');
}

async function withCheckpointLock<T>(
  checkpointPath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withInProcessCheckpointLock(checkpointPath, async () => {
    const releaseCrossProcessLock = await acquireCheckpointFileLock(checkpointPath);
    try {
      return await operation();
    } finally {
      await releaseCrossProcessLock();
    }
  });
}

async function withInProcessCheckpointLock<T>(
  checkpointPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const pendingLock = checkpointLocks.get(checkpointPath) ?? Promise.resolve();
  let releaseCurrentLock: (() => void) | null = null;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });
  const nextLock = pendingLock.then(() => currentLock);
  checkpointLocks.set(checkpointPath, nextLock);

  await pendingLock;
  try {
    return await operation();
  } finally {
    releaseCurrentLock?.();
    if (checkpointLocks.get(checkpointPath) === nextLock) {
      checkpointLocks.delete(checkpointPath);
    }
  }
}

async function acquireCheckpointFileLock(
  checkpointPath: string
): Promise<() => Promise<void>> {
  const lockPath = `${checkpointPath}.lock`;
  await mkdir(dirname(checkpointPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw err;
      }
      await sleep(CHECKPOINT_LOCK_RETRY_MS);
    }
  }
}

async function runWacliMessagesList(request: WacliListRequest): Promise<unknown> {
  const args: string[] = [];
  args.push('--store', request.storePath);
  args.push('messages', 'list');
  if (request.after) {
    args.push('--after', request.after);
  }
  args.push('--json', '--limit', String(request.limit));

  try {
    const result = await execFileAsync('wacli', args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (err) {
    if (isRecord(err) && typeof err.stdout === 'string' && err.stdout.trim().length > 0) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // fall through
      }
    }
    throw new Error(`wacli messages list failed for store ${request.storePath}: ${errorMessage(err)}`);
  }
}

function parseWacliListPayload(payload: unknown, store: WacliStoreConfig): ParseListResult {
  if (!isRecord(payload)) {
    return { ok: false, messages: [], error: 'wacli payload must be an object', degradedReason: 'invalid_payload' };
  }

  const record = payload as WacliPayloadLike;
  if (record.success !== true) {
    const message = asNonEmpty(record.error) ?? 'wacli reported success=false';
    return { ok: false, messages: [], error: message, degradedReason: 'command_failed' };
  }

  const rawMessages = record.data?.messages;
  if (rawMessages === null || rawMessages === undefined) {
    return { ok: true, messages: [], error: null, degradedReason: null };
  }
  if (!Array.isArray(rawMessages)) {
    return {
      ok: false,
      messages: [],
      error: 'wacli payload data.messages must be an array when present',
      degradedReason: 'invalid_payload',
    };
  }

  const normalized = normalizeRawMessages(rawMessages, store);
  return { ok: true, messages: normalized, error: null, degradedReason: null };
}

function normalizeRawMessages(rawMessages: unknown[], store: WacliStoreConfig): CollectedWhatsAppMessage[] {
  const uniqueById = new Map<string, CollectedWhatsAppMessage>();

  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue;
    const msgId = asNonEmpty(raw.MsgID);
    const timestamp = normalizeTimestamp(raw.Timestamp);
    if (!msgId || !timestamp) continue;

    const fromMe = asBoolean(raw.FromMe) ?? false;
    const senderJid = asNonEmpty(raw.SenderJID);
    const senderName =
      asNonEmpty(raw.SenderName)
      ?? asNonEmpty(raw.Sender)
      ?? asNonEmpty(raw.PushName)
      ?? asNonEmpty(raw.ContactName)
      ?? (fromMe ? 'me' : null)
      ?? senderJid
      ?? asNonEmpty(raw.ChatName)
      ?? '';
    const text = asString(raw.Text) ?? asString(raw.DisplayText) ?? asString(raw.Snippet) ?? '';

    const normalizedMessage: CollectedWhatsAppMessage = {
      MsgID: msgId,
      Timestamp: timestamp,
      ChatName: asNonEmpty(raw.ChatName) ?? asNonEmpty(raw.ChatJID) ?? '',
      SenderName: senderName,
      Text: text,
      ChatJID: asNonEmpty(raw.ChatJID),
      SenderJID: senderJid,
      FromMe: fromMe,
      store_key: store.key,
      store_path: store.storePath,
    };

    const existing = uniqueById.get(msgId);
    if (!existing) {
      uniqueById.set(msgId, normalizedMessage);
      continue;
    }

    // Keep the latest timestamp deterministically when wacli returns duplicate MsgIDs.
    if (normalizedMessage.Timestamp > existing.Timestamp) {
      uniqueById.set(msgId, normalizedMessage);
    }
  }

  return [...uniqueById.values()].sort(sortMessagesByTimestampThenIdThenStore);
}

function normalizeStores(stores: WacliStoreConfig[]): WacliStoreConfig[] {
  const normalized: WacliStoreConfig[] = [];
  const seenKeys = new Set<string>();

  for (const store of stores) {
    if (!store || typeof store !== 'object') continue;
    const key = asNonEmpty(store.key) ?? '';
    const storePath = asNonEmpty(store.storePath);
    if (!key || !storePath || seenKeys.has(key)) continue;
    seenKeys.add(key);
    normalized.push({ key, storePath });
  }

  return normalized;
}

function normalizeCheckpointStores(stores: Record<string, WacliStoreCheckpoint> | undefined): Record<string, WacliStoreCheckpoint> {
  const normalized: Record<string, WacliStoreCheckpoint> = {};
  if (!stores || typeof stores !== 'object') {
    return normalized;
  }

  for (const [storeKey, checkpoint] of Object.entries(stores)) {
    const key = asNonEmpty(storeKey);
    if (!key) continue;
    normalized[key] = normalizeStoreCheckpoint(checkpoint);
  }

  return normalized;
}

function normalizeStoreCheckpoint(checkpoint: unknown): WacliStoreCheckpoint {
  const record = isRecord(checkpoint) ? checkpoint : {};
  const after = normalizeTimestamp(record.after);
  const updatedAt = normalizeTimestamp(record.updated_at);
  const idsRaw = Array.isArray(record.message_ids_at_after)
    ? record.message_ids_at_after
    : Array.isArray(record.ids)
      ? record.ids
      : [];

  // Preserve insertion order — the FIFO cap in advanceCheckpoint relies on it
  // to drop the oldest-seen IDs first, not the lexicographically-smallest ones.
  const ids = Array.from(
    new Set(
      idsRaw
        .map((value) => asNonEmpty(value))
        .filter((value): value is string => Boolean(value))
    )
  );

  return {
    after,
    message_ids_at_after: ids,
    updated_at: updatedAt,
  };
}

function parseCheckpointState(raw: string): WacliCollectorCheckpointState {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return emptyCheckpointState();
    }

    const version = Number.isInteger(parsed.version) ? Number(parsed.version) : CHECKPOINT_VERSION;
    const stores = normalizeCheckpointStores(isRecord(parsed.stores) ? (parsed.stores as Record<string, WacliStoreCheckpoint>) : {});
    return {
      version,
      stores,
    };
  } catch {
    return emptyCheckpointState();
  }
}

async function readWacliCollectorCheckpointForCollect(
  checkpointPath: string
): Promise<{ checkpoint: WacliCollectorCheckpointState; error: string | null }> {
  try {
    const raw = await readFile(checkpointPath, 'utf-8');
    return {
      checkpoint: parseCheckpointStateStrict(raw),
      error: null,
    };
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { checkpoint: emptyCheckpointState(), error: null };
    }
    return {
      checkpoint: emptyCheckpointState(),
      error: `Unable to read collector checkpoint (${checkpointPath}): ${errorMessage(err)}`,
    };
  }
}

function parseCheckpointStateStrict(raw: string): WacliCollectorCheckpointState {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('checkpoint payload must be a JSON object');
  }
  if (!Number.isInteger(parsed.version)) {
    throw new Error('checkpoint payload missing or invalid version field');
  }
  const version = Number(parsed.version);
  if (version > CHECKPOINT_VERSION) {
    throw new Error(
      `checkpoint version ${version} is newer than supported version ${CHECKPOINT_VERSION}`
    );
  }
  const storesRecord = isRecord(parsed.stores)
    ? (parsed.stores as Record<string, unknown>)
    : {};
  for (const [storeKey, checkpoint] of Object.entries(storesRecord)) {
    validateStoreCheckpointStrict(storeKey, checkpoint);
  }
  const stores = normalizeCheckpointStores(
    storesRecord as Record<string, WacliStoreCheckpoint>
  );
  return {
    version,
    stores,
  };
}

function validateStoreCheckpointStrict(storeKey: string, checkpoint: unknown): void {
  if (!isRecord(checkpoint)) {
    throw new Error(`checkpoint store "${storeKey}" must be an object`);
  }

  if ('after' in checkpoint && checkpoint.after !== null && checkpoint.after !== undefined) {
    if (normalizeTimestamp(checkpoint.after) === null) {
      throw new Error(`checkpoint store "${storeKey}" has invalid "after" cursor`);
    }
  }

  if ('message_ids_at_after' in checkpoint || 'ids' in checkpoint) {
    const idsRaw = checkpoint.message_ids_at_after ?? checkpoint.ids;
    if (!Array.isArray(idsRaw)) {
      throw new Error(`checkpoint store "${storeKey}" has invalid "message_ids_at_after" cursor set`);
    }

    for (const id of idsRaw) {
      if (asNonEmpty(id) === null) {
        throw new Error(`checkpoint store "${storeKey}" has non-string message ID cursor`);
      }
    }
  }
}

function emptyCheckpointState(): WacliCollectorCheckpointState {
  return {
    version: CHECKPOINT_VERSION,
    stores: {},
  };
}

function filterMessagesAfterCheckpoint(
  messages: CollectedWhatsAppMessage[],
  checkpoint: WacliStoreCheckpoint
): CollectedWhatsAppMessage[] {
  const checkpointAfter = checkpoint.after;
  if (!checkpointAfter) {
    return messages;
  }

  const checkpointMs = Date.parse(checkpointAfter);
  if (Number.isNaN(checkpointMs)) {
    return messages;
  }
  const seenAtCheckpoint = new Set(checkpoint.message_ids_at_after);

  return messages.filter((message) => {
    const messageMs = Date.parse(message.Timestamp);
    if (Number.isNaN(messageMs)) {
      return false;
    }
    if (messageMs > checkpointMs) {
      return true;
    }
    if (messageMs < checkpointMs) {
      return false;
    }
    return !seenAtCheckpoint.has(message.MsgID);
  });
}

function advanceCheckpoint(
  existing: WacliStoreCheckpoint,
  newMessages: CollectedWhatsAppMessage[],
  now: Date
): WacliStoreCheckpoint {
  if (newMessages.length === 0) {
    return existing;
  }

  const sorted = [...newMessages].sort(sortMessagesByTimestampThenIdThenStore);
  const after = sorted[sorted.length - 1]?.Timestamp ?? existing.after;
  if (!after) {
    return existing;
  }

  const nextIdsAtAfter = sorted
    .filter((message) => message.Timestamp === after)
    .map((message) => message.MsgID);
  // Preserve insertion order so the FIFO cap below drops the *oldest* IDs we've seen
  // rather than the lexicographically-smallest ones — MsgIDs are not chronological.
  const existingIds = after === existing.after ? existing.message_ids_at_after : [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [...existingIds, ...nextIdsAtAfter]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  // Cap the per-timestamp ID set so a chat burst pinned to one second cannot grow
  // the checkpoint without bound. We drop oldest-first; if wacli re-returns a dropped
  // ID on the next poll the action engine dedupes by source_id, but extraction LLM
  // cost is paid again, so the cap should be high enough to never trigger in practice.
  const idsAtAfter = ordered.length > MAX_IDS_AT_AFTER
    ? ordered.slice(ordered.length - MAX_IDS_AT_AFTER)
    : ordered;

  return {
    after,
    message_ids_at_after: idsAtAfter,
    updated_at: now.toISOString(),
  };
}

function areStoreCheckpointsEqual(a: WacliStoreCheckpoint, b: WacliStoreCheckpoint): boolean {
  if (a.after !== b.after || a.updated_at !== b.updated_at) {
    return false;
  }
  if (a.message_ids_at_after.length !== b.message_ids_at_after.length) {
    return false;
  }
  for (let i = 0; i < a.message_ids_at_after.length; i += 1) {
    if (a.message_ids_at_after[i] !== b.message_ids_at_after[i]) {
      return false;
    }
  }
  return true;
}

function latestTimestamp(messages: CollectedWhatsAppMessage[]): string | null {
  if (messages.length === 0) {
    return null;
  }
  return messages[messages.length - 1]?.Timestamp ?? null;
}

function latestWacliSyncAt(stores: WacliStoreCollectionResult[]): string | null {
  const syncTimestamps = stores
    .map((store) => normalizeTimestamp(store.lastSyncAt))
    .filter((value): value is string => Boolean(value));

  if (syncTimestamps.length === 0) {
    return null;
  }

  syncTimestamps.sort();
  return syncTimestamps[syncTimestamps.length - 1] ?? null;
}

function isTimestampStale(timestamp: string, now: Date, staleAfterHours: number): boolean {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return true;
  }
  const ageMs = now.getTime() - parsed;
  return ageMs > staleAfterHours * 60 * 60 * 1000;
}

function sortMessagesByTimestampThenIdThenStore(
  a: CollectedWhatsAppMessage,
  b: CollectedWhatsAppMessage
): number {
  const timestampDiff = a.Timestamp.localeCompare(b.Timestamp);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  const idDiff = a.MsgID.localeCompare(b.MsgID);
  if (idDiff !== 0) {
    return idDiff;
  }
  return a.store_key.localeCompare(b.store_key);
}

function normalizeTimestamp(value: unknown): string | null {
  const text = asNonEmpty(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_LIMIT;
  }
  return value;
}

function isFileNotFoundError(err: unknown): boolean {
  return isRecord(err) && err.code === 'ENOENT';
}

function isAlreadyExistsError(err: unknown): boolean {
  return isRecord(err) && err.code === 'EEXIST';
}

function normalizeStaleAfterHours(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_STALE_AFTER_HOURS;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensureDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${field}: expected Date`);
  }
  return value;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

function asNonEmpty(value: unknown): string | null {
  const text = asString(value);
  if (text === null) {
    return null;
  }
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}
