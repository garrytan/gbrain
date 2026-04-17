import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectWacliMessages,
  latestCheckpointSyncAt,
  readWacliCollectorCheckpoint,
  readWacliCollectorLastSyncAt,
  summarizeWacliHealth,
  type WacliListMessagesRunner,
  writeWacliCollectorCheckpoint,
} from '../../src/action-brain/collector.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('action-brain collector checkpoint storage', () => {
  test('writes and reads per-store checkpoint state', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');

    await writeWacliCollectorCheckpoint(checkpointPath, {
      version: 1,
      stores: {
        personal: {
          after: '2026-04-16T08:00:00.000Z',
          message_ids_at_after: ['m2', 'm3'],
          updated_at: '2026-04-16T08:05:00.000Z',
        },
        business: {
          after: null,
          message_ids_at_after: [],
          updated_at: null,
        },
      },
    });

    const loaded = await readWacliCollectorCheckpoint(checkpointPath);
    expect(loaded.version).toBe(1);
    expect(loaded.stores.personal?.after).toBe('2026-04-16T08:00:00.000Z');
    expect(loaded.stores.personal?.message_ids_at_after).toEqual(['m2', 'm3']);
    expect(loaded.stores.business?.after).toBeNull();
  });

  test('invalid checkpoint JSON falls back to an empty state', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await Bun.write(checkpointPath, '{not-valid-json');

    const loaded = await readWacliCollectorCheckpoint(checkpointPath);
    expect(loaded.version).toBe(1);
    expect(loaded.stores).toEqual({});
  });

  test('derives latest checkpoint sync timestamp across stores', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await writeWacliCollectorCheckpoint(checkpointPath, {
      version: 1,
      stores: {
        personal: {
          after: '2026-04-16T03:00:00.000Z',
          message_ids_at_after: ['p1'],
          updated_at: '2026-04-16T03:00:01.000Z',
        },
        business: {
          after: '2026-04-16T05:00:00.000Z',
          message_ids_at_after: ['b1'],
          updated_at: '2026-04-16T05:00:01.000Z',
        },
      },
    });

    const checkpoint = await readWacliCollectorCheckpoint(checkpointPath);
    expect(latestCheckpointSyncAt(checkpoint)).toBe('2026-04-16T05:00:00.000Z');
    expect(await readWacliCollectorLastSyncAt(checkpointPath)).toBe('2026-04-16T05:00:00.000Z');
  });
});

describe('collectWacliMessages', () => {
  test('collects from personal + business stores and advances checkpoint without replaying seen IDs', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');

    await writeWacliCollectorCheckpoint(checkpointPath, {
      version: 1,
      stores: {
        personal: {
          after: '2026-04-16T00:00:00.000Z',
          message_ids_at_after: ['old-same-second'],
          updated_at: '2026-04-16T00:01:00.000Z',
        },
      },
    });

    const calls: Array<{ storePath: string; after: string | null; limit: number }> = [];
    const runner: WacliListMessagesRunner = async (request) => {
      calls.push({ ...request });

      if (request.storePath === '/stores/personal') {
        return {
          success: true,
          data: {
            messages: [
              {
                MsgID: 'old-same-second',
                ChatName: 'Ops',
                SenderJID: 's1@jid',
                Timestamp: '2026-04-16T00:00:00.000Z',
                FromMe: false,
                Text: 'already processed',
              },
              {
                MsgID: 'p2',
                ChatName: 'Ops',
                SenderJID: 's2@jid',
                Timestamp: '2026-04-16T00:00:00.000Z',
                FromMe: false,
                Text: 'new same second',
              },
              {
                MsgID: 'p3',
                ChatName: 'Ops',
                SenderName: 'Sam',
                SenderJID: 's3@jid',
                Timestamp: '2026-04-16T00:10:00.000Z',
                FromMe: false,
                Text: 'new later',
              },
            ],
          },
          error: null,
        };
      }

      if (request.storePath === '/stores/business') {
        return {
          success: true,
          data: {
            messages: [
              {
                MsgID: 'b1',
                ChatName: 'Biz',
                SenderName: 'Nichol',
                SenderJID: 'b1@jid',
                Timestamp: '2026-04-16T00:05:00.000Z',
                FromMe: false,
                Text: 'new business',
              },
            ],
          },
          error: null,
        };
      }

      throw new Error(`unexpected store path: ${request.storePath}`);
    };

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [
        { key: 'personal', storePath: '/stores/personal' },
        { key: 'business', storePath: '/stores/business' },
      ],
      now: new Date('2026-04-16T00:30:00.000Z'),
      limit: 50,
      runner,
    });

    expect(calls).toEqual([
      { storePath: '/stores/personal', after: '2026-04-16T00:00:00.000Z', limit: 50 },
      { storePath: '/stores/business', after: null, limit: 50 },
    ]);

    expect(result.degraded).toBe(false);
    expect(result.messages.map((message) => message.MsgID)).toEqual(['p2', 'b1', 'p3']);
    expect(result.stores.find((store) => store.storeKey === 'personal')?.batchSize).toBe(2);
    expect(result.stores.find((store) => store.storeKey === 'business')?.batchSize).toBe(1);
    expect(result.stores.find((store) => store.storeKey === 'personal')?.checkpointAfter).toBe('2026-04-16T00:10:00.000Z');
    expect(result.stores.find((store) => store.storeKey === 'business')?.checkpointAfter).toBe('2026-04-16T00:05:00.000Z');

    const stored = await readWacliCollectorCheckpoint(checkpointPath);
    expect(stored.stores.personal?.after).toBe('2026-04-16T00:10:00.000Z');
    expect(stored.stores.personal?.message_ids_at_after).toEqual(['p3']);
    expect(stored.stores.business?.after).toBe('2026-04-16T00:05:00.000Z');
    expect(stored.stores.business?.message_ids_at_after).toEqual(['b1']);
  });

  test('merges same-timestamp checkpoint IDs instead of overwriting them', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await writeWacliCollectorCheckpoint(checkpointPath, {
      version: 1,
      stores: {
        personal: {
          after: '2026-04-16T00:00:00.000Z',
          message_ids_at_after: ['a', 'b'],
          updated_at: '2026-04-16T00:01:00.000Z',
        },
      },
    });

    const runner: WacliListMessagesRunner = async () => ({
      success: true,
      data: {
        messages: [
          {
            MsgID: 'a',
            ChatName: 'Ops',
            SenderJID: 'sender@jid',
            Timestamp: '2026-04-16T00:00:00.000Z',
            FromMe: false,
            Text: 'already processed a',
          },
          {
            MsgID: 'b',
            ChatName: 'Ops',
            SenderJID: 'sender@jid',
            Timestamp: '2026-04-16T00:00:00.000Z',
            FromMe: false,
            Text: 'already processed b',
          },
          {
            MsgID: 'c',
            ChatName: 'Ops',
            SenderJID: 'sender@jid',
            Timestamp: '2026-04-16T00:00:00.000Z',
            FromMe: false,
            Text: 'new same-second message',
          },
        ],
      },
      error: null,
    });

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      runner,
    });

    expect(result.messages.map((message) => message.MsgID)).toEqual(['c']);

    const stored = await readWacliCollectorCheckpoint(checkpointPath);
    expect(stored.stores.personal?.after).toBe('2026-04-16T00:00:00.000Z');
    expect(stored.stores.personal?.message_ids_at_after).toEqual(['a', 'b', 'c']);
  });

  test('fails closed with explicit degraded checkpoint_read_failed state when checkpoint is invalid', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await Bun.write(checkpointPath, '{not-valid-json');

    let calls = 0;
    const runner: WacliListMessagesRunner = async () => {
      calls += 1;
      return { success: true, data: { messages: [] }, error: null };
    };

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T12:00:00.000Z'),
      runner,
    });

    expect(calls).toBe(0);
    expect(result.degraded).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.stores[0]?.degraded).toBe(true);
    expect(result.stores[0]?.degradedReason).toBe('checkpoint_read_failed');
    expect(result.stores[0]?.error).toContain('Unable to read collector checkpoint');
    expect(result.stores[0]?.error).toContain('wacli-checkpoint.json');
  });

  test('marks store as degraded when latest sync is unknown', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const runner: WacliListMessagesRunner = async (_request) => ({
      success: true,
      data: { messages: null },
      error: null,
    });

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T12:00:00.000Z'),
      runner,
    });

    expect(result.degraded).toBe(true);
    expect(result.stores[0]?.degraded).toBe(true);
    expect(result.stores[0]?.degradedReason).toBe('last_sync_unknown');
    expect(result.stores[0]?.lastSyncAt).toBeNull();
    expect(result.stores[0]?.batchSize).toBe(0);
  });

  test('marks store as degraded when latest sync is stale', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');

    const runner: WacliListMessagesRunner = async (request) => {
      if (request.after) {
        throw new Error('unexpected --after call');
      }
      if (request.limit > 1) {
        return { success: true, data: { messages: [] }, error: null };
      }
      return {
        success: true,
        data: {
          messages: [
            {
              MsgID: 'latest',
              ChatName: 'Ops',
              SenderJID: 'sender@jid',
              Timestamp: '2026-04-15T09:00:00Z',
              FromMe: false,
              Text: 'old message',
            },
          ],
        },
        error: null,
      };
    };

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      staleAfterHours: 24,
      now: new Date('2026-04-16T12:00:00.000Z'),
      runner,
    });

    expect(result.degraded).toBe(true);
    expect(result.stores[0]?.degraded).toBe(true);
    expect(result.stores[0]?.degradedReason).toBe('last_sync_stale');
    expect(result.stores[0]?.lastSyncAt).toBe('2026-04-15T09:00:00.000Z');
  });

  test('does not persist checkpoint when persistCheckpoint=false', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await writeWacliCollectorCheckpoint(checkpointPath, {
      version: 1,
      stores: {
        personal: {
          after: '2026-04-15T12:00:00.000Z',
          message_ids_at_after: ['old-id'],
          updated_at: '2026-04-15T12:00:00.000Z',
        },
      },
    });

    const runner: WacliListMessagesRunner = async () => ({
      success: true,
      data: {
        messages: [
          {
            MsgID: 'new-id',
            ChatName: 'Ops',
            SenderJID: 'sender@jid',
            Timestamp: '2026-04-16T12:00:00.000Z',
            FromMe: false,
            Text: 'new message',
          },
        ],
      },
      error: null,
    });

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      persistCheckpoint: false,
      now: new Date('2026-04-16T12:30:00.000Z'),
      runner,
    });

    expect(result.stores[0]?.checkpointAfter).toBe('2026-04-16T12:00:00.000Z');

    const persisted = await readWacliCollectorCheckpoint(checkpointPath);
    expect(persisted.stores.personal?.after).toBe('2026-04-15T12:00:00.000Z');
  });

  test('summarizes failed health when any store is disconnected', async () => {
    const result = summarizeWacliHealth(
      [
        {
          storeKey: 'personal',
          storePath: '/stores/personal',
          checkpointBefore: null,
          checkpointAfter: null,
          batchSize: 0,
          lastSyncAt: null,
          degraded: true,
          degradedReason: 'command_failed',
          error: 'spawn wacli ENOENT',
          messages: [],
        },
      ],
      { now: new Date('2026-04-16T12:00:00.000Z') }
    );

    expect(result.status).toBe('failed');
    expect(result.disconnectedStoreKeys).toEqual(['personal']);
    expect(result.staleStoreKeys).toEqual([]);
    expect(result.alerts[0]).toContain('unhealthy');
  });

  test('summarizes degraded health when only stale stores are present', async () => {
    const result = summarizeWacliHealth(
      [
        {
          storeKey: 'personal',
          storePath: '/stores/personal',
          checkpointBefore: null,
          checkpointAfter: null,
          batchSize: 0,
          lastSyncAt: '2026-04-15T10:00:00.000Z',
          degraded: true,
          degradedReason: 'last_sync_stale',
          error: null,
          messages: [],
        },
      ],
      { now: new Date('2026-04-16T12:00:00.000Z') }
    );

    expect(result.status).toBe('degraded');
    expect(result.disconnectedStoreKeys).toEqual([]);
    expect(result.staleStoreKeys).toEqual(['personal']);
    expect(result.lastSyncAt).toBe('2026-04-15T10:00:00.000Z');
    expect(result.alerts[0]).toContain('stale');
  });

  test('collapses checkpoint_read_failed into a single global alert across stores', async () => {
    const result = summarizeWacliHealth(
      [
        {
          storeKey: 'personal',
          storePath: '/stores/personal',
          checkpointBefore: null,
          checkpointAfter: null,
          batchSize: 0,
          lastSyncAt: null,
          degraded: true,
          degradedReason: 'checkpoint_read_failed',
          error: 'Unable to read collector checkpoint (/x/wacli-checkpoint.json): bad json',
          messages: [],
        },
        {
          storeKey: 'business',
          storePath: '/stores/business',
          checkpointBefore: null,
          checkpointAfter: null,
          batchSize: 0,
          lastSyncAt: null,
          degraded: true,
          degradedReason: 'checkpoint_read_failed',
          error: 'Unable to read collector checkpoint (/x/wacli-checkpoint.json): bad json',
          messages: [],
        },
      ],
      { now: new Date('2026-04-16T12:00:00.000Z') }
    );

    expect(result.status).toBe('failed');
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('Unable to read collector checkpoint');
    expect(result.disconnectedStoreKeys).toEqual(['personal', 'business']);
    expect(result.staleStoreKeys).toEqual([]);
  });

  test('rejects checkpoints whose version is newer than supported', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await Bun.write(
      checkpointPath,
      JSON.stringify({ version: 9999, stores: {} })
    );

    const runner: WacliListMessagesRunner = async () => ({
      success: true,
      data: { messages: [] },
      error: null,
    });

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T12:00:00.000Z'),
      runner,
    });

    expect(result.degraded).toBe(true);
    expect(result.stores[0]?.degradedReason).toBe('checkpoint_read_failed');
    expect(result.stores[0]?.error).toContain('newer than supported');
  });

  test('caps merged same-timestamp ID set to prevent unbounded growth', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const sameTs = '2026-04-16T00:00:00.000Z';
    const existingIds = Array.from({ length: 5000 }, (_, i) => `existing-${String(i).padStart(5, '0')}`);
    await writeWacliCollectorCheckpoint(checkpointPath, {
      version: 1,
      stores: {
        personal: {
          after: sameTs,
          message_ids_at_after: existingIds,
          updated_at: '2026-04-16T00:01:00.000Z',
        },
      },
    });

    const newMessages = Array.from({ length: 100 }, (_, i) => ({
      MsgID: `new-${String(i).padStart(5, '0')}`,
      ChatName: 'Ops',
      SenderJID: 'sender@jid',
      Timestamp: sameTs,
      FromMe: false,
      Text: `new message ${i}`,
    }));

    const runner: WacliListMessagesRunner = async () => ({
      success: true,
      data: { messages: newMessages },
      error: null,
    });

    await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      runner,
    });

    const stored = await readWacliCollectorCheckpoint(checkpointPath);
    const storedIds = stored.stores.personal?.message_ids_at_after ?? [];
    expect(storedIds.length).toBe(5000);
    // FIFO: oldest existing IDs dropped from the front, newly-seen IDs preserved at the tail.
    // Without this, slice(-N) on a sort()'d list would keep lex-largest "existing-04999..." and
    // drop every "new-*" ID (they sort lower), causing repeated re-extraction on every poll.
    for (let i = 0; i < 100; i += 1) {
      expect(storedIds).toContain(`new-${String(i).padStart(5, '0')}`);
    }
    // First 100 of the original existing-* IDs must have rolled off the front.
    expect(storedIds).not.toContain('existing-00000');
    expect(storedIds).not.toContain('existing-00099');
    expect(storedIds).toContain('existing-00100');
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'action-brain-collector-test-'));
  tempDirs.push(dir);
  return dir;
}
