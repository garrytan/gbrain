import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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

  test('uses unique temp files for concurrent checkpoint writes in the same millisecond', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const originalNow = Date.now;

    Date.now = () => 1_760_000_000_000;
    try {
      await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          writeWacliCollectorCheckpoint(checkpointPath, {
            version: 1,
            stores: {
              personal: {
                after: `2026-04-16T05:00:${String(i).padStart(2, '0')}.000Z`,
                message_ids_at_after: [`m-${i}`],
                updated_at: `2026-04-16T05:01:${String(i).padStart(2, '0')}.000Z`,
              },
            },
          })
        )
      );
    } finally {
      Date.now = originalNow;
    }

    const checkpoint = await readWacliCollectorCheckpoint(checkpointPath);
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.stores.personal?.after).toMatch(/^2026-04-16T05:00:/);
    expect(checkpoint.stores.personal?.message_ids_at_after.length).toBe(1);
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

  test('serializes overlapping collection runs to prevent checkpoint rewind', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const firstMessageTs = '2026-04-16T00:00:00.000Z';

    let releaseFirstIncremental: (() => void) | null = null;
    const firstIncrementalBlocked = new Promise<void>((resolve) => {
      releaseFirstIncremental = resolve;
    });
    let markFirstIncrementalStarted: (() => void) | null = null;
    const firstIncrementalStarted = new Promise<void>((resolve) => {
      markFirstIncrementalStarted = resolve;
    });

    const incrementalAfters: Array<string | null> = [];
    const runner: WacliListMessagesRunner = async (request) => {
      if (request.storePath !== '/stores/personal') {
        throw new Error(`unexpected store path: ${request.storePath}`);
      }

      if (request.limit === 50) {
        incrementalAfters.push(request.after);

        if (request.after === null) {
          if (incrementalAfters.length === 1) {
            markFirstIncrementalStarted?.();
            await firstIncrementalBlocked;
          }
          return {
            success: true,
            data: {
              messages: [
                {
                  MsgID: 'msg-1',
                  ChatName: 'Ops',
                  SenderJID: 'sender@jid',
                  Timestamp: firstMessageTs,
                  FromMe: false,
                  Text: 'hello',
                },
              ],
            },
            error: null,
          };
        }

        if (request.after === firstMessageTs) {
          return { success: true, data: { messages: [] }, error: null };
        }

        throw new Error(`unexpected checkpoint cursor: ${request.after}`);
      }

      if (request.limit === 1) {
        return {
          success: true,
          data: {
            messages: [
              {
                MsgID: 'msg-1',
                ChatName: 'Ops',
                SenderJID: 'sender@jid',
                Timestamp: firstMessageTs,
                FromMe: false,
                Text: 'hello',
              },
            ],
          },
          error: null,
        };
      }

      throw new Error(`unexpected limit: ${request.limit}`);
    };

    const firstCollect = collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      limit: 50,
      runner,
    });

    await firstIncrementalStarted;

    const secondCollect = collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      limit: 50,
      runner,
    });

    releaseFirstIncremental?.();

    const [firstResult, secondResult] = await Promise.all([firstCollect, secondCollect]);

    expect(incrementalAfters).toEqual([null, firstMessageTs]);
    expect(firstResult.messages.map((message) => message.MsgID)).toEqual(['msg-1']);
    expect(secondResult.messages).toEqual([]);
    expect(secondResult.stores[0]?.checkpointBefore).toBe(firstMessageTs);

    const persisted = await readWacliCollectorCheckpoint(checkpointPath);
    expect(persisted.stores.personal?.after).toBe(firstMessageTs);
    expect(persisted.stores.personal?.message_ids_at_after).toEqual(['msg-1']);
  });

  test('reclaims stale orphaned lock directory and continues collection', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const lockPath = `${checkpointPath}.lock`;
    const lockOwnerPath = join(lockPath, 'owner.json');

    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      lockOwnerPath,
      JSON.stringify({
        owner_id: 'stale-owner',
        pid: 999999,
        acquired_at: '2020-01-01T00:00:00.000Z',
      }),
      'utf-8'
    );

    let calls = 0;
    const runner: WacliListMessagesRunner = async () => {
      calls += 1;
      return {
        success: true,
        data: {
          messages: [
            {
              MsgID: 'fresh-msg',
              ChatName: 'Ops',
              SenderJID: 'sender@jid',
              Timestamp: '2026-04-16T00:29:00.000Z',
              FromMe: false,
              Text: 'fresh',
            },
          ],
        },
        error: null,
      };
    };

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      limit: 50,
      lockAcquireTimeoutMs: 1_000,
      lockStaleAfterMs: 100,
      runner,
    });

    expect(calls).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.messages.map((message) => message.MsgID)).toEqual(['fresh-msg']);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('reclaims stale lock directory without owner metadata and continues collection', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const lockPath = `${checkpointPath}.lock`;

    mkdirSync(lockPath, { recursive: true });
    utimesSync(lockPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

    let calls = 0;
    const runner: WacliListMessagesRunner = async () => {
      calls += 1;
      return {
        success: true,
        data: {
          messages: [
            {
              MsgID: 'fresh-msg',
              ChatName: 'Ops',
              SenderJID: 'sender@jid',
              Timestamp: '2026-04-16T00:29:00.000Z',
              FromMe: false,
              Text: 'fresh',
            },
          ],
        },
        error: null,
      };
    };

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      limit: 50,
      lockAcquireTimeoutMs: 1_000,
      lockStaleAfterMs: 100,
      runner,
    });

    expect(calls).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.messages.map((message) => message.MsgID)).toEqual(['fresh-msg']);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('reclaims stale lock without owner metadata in wacli command mode', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const lockPath = `${checkpointPath}.lock`;
    const binDir = join(root, 'bin');
    const wacliPath = join(binDir, 'wacli');
    const previousPath = process.env.PATH;

    mkdirSync(lockPath, { recursive: true });
    utimesSync(lockPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      wacliPath,
      `#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
{"success":true,"data":{"messages":[{"MsgID":"fresh-msg","ChatName":"Ops","SenderJID":"sender@jid","Timestamp":"2026-04-16T00:29:00.000Z","FromMe":false,"Text":"fresh"}]},"error":null}
JSON
`,
      'utf-8'
    );
    chmodSync(wacliPath, 0o755);

    try {
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;

      const result = await collectWacliMessages({
        checkpointPath,
        stores: [{ key: 'personal', storePath: '/stores/personal' }],
        now: new Date('2026-04-16T00:30:00.000Z'),
        limit: 50,
        lockAcquireTimeoutMs: 1_000,
        lockStaleAfterMs: 100,
        staleAfterHours: 24,
      });

      expect(result.degraded).toBe(false);
      expect(result.messages.map((message) => message.MsgID)).toEqual(['fresh-msg']);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  test('lock is released even when wacli fails after stale lock reclaim', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const lockPath = `${checkpointPath}.lock`;
    const binDir = join(root, 'bin-fail');
    const wacliPath = join(binDir, 'wacli');
    const previousPath = process.env.PATH;

    mkdirSync(lockPath, { recursive: true });
    utimesSync(lockPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    mkdirSync(binDir, { recursive: true });
    writeFileSync(wacliPath, `#!/usr/bin/env bash\nexit 1\n`, 'utf-8');
    chmodSync(wacliPath, 0o755);

    try {
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;

      const result = await collectWacliMessages({
        checkpointPath,
        stores: [{ key: 'personal', storePath: '/stores/personal' }],
        now: new Date('2026-04-16T00:30:00.000Z'),
        limit: 50,
        lockAcquireTimeoutMs: 1_000,
        lockStaleAfterMs: 100,
        staleAfterHours: 24,
      });

      expect(result.degraded).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  test('fails closed when lock cannot be safely reclaimed before timeout', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const lockPath = `${checkpointPath}.lock`;
    const lockOwnerPath = join(lockPath, 'owner.json');

    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      lockOwnerPath,
      JSON.stringify({
        owner_id: 'active-owner',
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
      'utf-8'
    );

    let calls = 0;
    const runner: WacliListMessagesRunner = async () => {
      calls += 1;
      return { success: true, data: { messages: [] }, error: null };
    };

    const result = await collectWacliMessages({
      checkpointPath,
      stores: [{ key: 'personal', storePath: '/stores/personal' }],
      now: new Date('2026-04-16T00:30:00.000Z'),
      lockAcquireTimeoutMs: 150,
      lockStaleAfterMs: 60_000,
      runner,
    });

    expect(calls).toBe(0);
    expect(result.degraded).toBe(true);
    expect(result.stores[0]?.degraded).toBe(true);
    expect(result.stores[0]?.degradedReason).toBe('checkpoint_read_failed');
    expect(result.stores[0]?.error).toContain('Unable to acquire collector checkpoint lock');
    expect(existsSync(lockPath)).toBe(true);
  });

  test('does not delete a competing fresh lock when stale reclaim loses the race', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const lockPath = `${checkpointPath}.lock`;
    const lockOwnerPath = join(lockPath, 'owner.json');
    const previousDelay = process.env.ACTION_BRAIN_CHECKPOINT_LOCK_RECLAIM_DELAY_MS;

    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      lockOwnerPath,
      JSON.stringify({
        owner_id: 'stale-owner',
        pid: 999999,
        acquired_at: '2020-01-01T00:00:00.000Z',
      }),
      'utf-8'
    );

    process.env.ACTION_BRAIN_CHECKPOINT_LOCK_RECLAIM_DELAY_MS = '150';
    try {
      let calls = 0;
      const runner: WacliListMessagesRunner = async () => {
        calls += 1;
        return { success: true, data: { messages: [] }, error: null };
      };

      const collectPromise = collectWacliMessages({
        checkpointPath,
        stores: [{ key: 'personal', storePath: '/stores/personal' }],
        now: new Date('2026-04-16T00:30:00.000Z'),
        lockAcquireTimeoutMs: 220,
        lockStaleAfterMs: 50,
        runner,
      });

      await Bun.sleep(40);
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(
        lockOwnerPath,
        JSON.stringify({
          owner_id: 'fresh-owner',
          pid: process.pid,
          acquired_at: new Date().toISOString(),
        }),
        'utf-8'
      );

      const result = await collectPromise;

      expect(calls).toBe(0);
      expect(result.degraded).toBe(true);
      expect(result.stores[0]?.degradedReason).toBe('checkpoint_read_failed');
      expect(result.stores[0]?.error).toContain('Unable to acquire collector checkpoint lock');
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockOwnerPath, 'utf-8')).toContain('fresh-owner');
    } finally {
      if (previousDelay === undefined) {
        delete process.env.ACTION_BRAIN_CHECKPOINT_LOCK_RECLAIM_DELAY_MS;
      } else {
        process.env.ACTION_BRAIN_CHECKPOINT_LOCK_RECLAIM_DELAY_MS = previousDelay;
      }
    }
  });

  test('serializes overlapping collection runs across separate processes', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    const firstMessageTs = '2026-04-16T00:00:00.000Z';
    const storePath = '/stores/personal';
    const binDir = join(root, 'bin');
    const wacliPath = join(binDir, 'wacli');
    const callsLogPath = join(root, 'wacli-calls.log');
    const blockFlagPath = join(root, 'block-first');
    const firstStartedPath = join(root, 'first-started');
    const releasePath = join(root, 'release-first');
    const workerPath = join(root, 'collect-worker.ts');
    const collectorModulePath = resolve(process.cwd(), 'src/action-brain/collector.ts');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(blockFlagPath, '1\n', 'utf-8');
    writeFileSync(
      wacliPath,
      `#!/usr/bin/env bash
set -euo pipefail
after=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --after)
      after="$2"
      shift 2
      ;;
    --store|--limit)
      shift 2
      ;;
    --json|messages|list)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

printf '%s\\t%s\\n' "$$" "\${after:-<null>}" >> "\${WACLI_CALLS_LOG}"

if [[ "\${ROLE:-}" == "first" && -z "\${after}" && -f "\${WACLI_BLOCK_FLAG_FILE}" ]]; then
  : > "\${WACLI_FIRST_STARTED_FILE}"
  while [[ ! -f "\${WACLI_RELEASE_FILE}" ]]; do
    sleep 0.02
  done
fi

if [[ -z "\${after}" ]]; then
  cat <<'JSON'
{"success":true,"data":{"messages":[{"MsgID":"msg-1","ChatName":"Ops","SenderJID":"sender@jid","Timestamp":"${firstMessageTs}","FromMe":false,"Text":"hello"}]},"error":null}
JSON
elif [[ "\${after}" == "${firstMessageTs}" ]]; then
  cat <<'JSON'
{"success":true,"data":{"messages":[{"MsgID":"msg-1","ChatName":"Ops","SenderJID":"sender@jid","Timestamp":"${firstMessageTs}","FromMe":false,"Text":"hello"}]},"error":null}
JSON
else
  cat <<'JSON'
{"success":true,"data":{"messages":[]},"error":null}
JSON
fi
`,
      'utf-8'
    );
    chmodSync(wacliPath, 0o755);

    writeFileSync(
      workerPath,
      `import { collectWacliMessages } from '${collectorModulePath}';

const checkpointPath = process.env.CHECKPOINT_PATH;
const storePath = process.env.STORE_PATH;
if (!checkpointPath || !storePath) {
  throw new Error('missing CHECKPOINT_PATH or STORE_PATH');
}

const result = await collectWacliMessages({
  checkpointPath,
  stores: [{ key: 'personal', storePath }],
  now: new Date('2026-04-16T00:30:00.000Z'),
  limit: 50,
});

console.log(JSON.stringify({
  messages: result.messages.map((message) => message.MsgID),
  checkpointBefore: result.stores[0]?.checkpointBefore ?? null,
}));
`,
      'utf-8'
    );

    const sharedEnv = {
      CHECKPOINT_PATH: checkpointPath,
      STORE_PATH: storePath,
      WACLI_CALLS_LOG: callsLogPath,
      WACLI_BLOCK_FLAG_FILE: blockFlagPath,
      WACLI_FIRST_STARTED_FILE: firstStartedPath,
      WACLI_RELEASE_FILE: releasePath,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    const firstCollect = spawnCollectorWorker(workerPath, { ...sharedEnv, ROLE: 'first' });
    await waitForFile(firstStartedPath, 5_000);

    const secondCollect = spawnCollectorWorker(workerPath, { ...sharedEnv, ROLE: 'second' });
    await Bun.sleep(150);

    const inFlightCalls = readNonEmptyLines(callsLogPath);
    expect(inFlightCalls).toHaveLength(1);
    expect(inFlightCalls[0]?.split('\t')[1]).toBe('<null>');

    writeFileSync(releasePath, '1\n', 'utf-8');

    const [firstResult, secondResult] = await Promise.all([firstCollect, secondCollect]);
    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(0);

    const callAfters = readNonEmptyLines(callsLogPath).map((line) => line.split('\t')[1]);
    expect(callAfters).toEqual(['<null>', firstMessageTs]);

    expect(JSON.parse(firstResult.stdout)).toEqual({
      messages: ['msg-1'],
      checkpointBefore: null,
    });
    expect(JSON.parse(secondResult.stdout)).toEqual({
      messages: [],
      checkpointBefore: firstMessageTs,
    });

    const persisted = await readWacliCollectorCheckpoint(checkpointPath);
    expect(persisted.stores.personal?.after).toBe(firstMessageTs);
    expect(persisted.stores.personal?.message_ids_at_after).toEqual(['msg-1']);
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

  test('rejects checkpoints whose per-store "after" cursor is malformed', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await Bun.write(
      checkpointPath,
      JSON.stringify({
        version: 1,
        stores: {
          personal: {
            after: 'not-a-timestamp',
            message_ids_at_after: ['m1'],
            updated_at: null,
          },
        },
      })
    );

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
    expect(result.stores[0]?.degradedReason).toBe('checkpoint_read_failed');
    expect(result.stores[0]?.error).toContain('invalid "after" cursor');
  });

  test('rejects checkpoints whose per-store message ID cursor set is malformed', async () => {
    const root = createTempDir();
    const checkpointPath = join(root, 'wacli-checkpoint.json');
    await Bun.write(
      checkpointPath,
      JSON.stringify({
        version: 1,
        stores: {
          personal: {
            after: '2026-04-16T00:00:00.000Z',
            message_ids_at_after: ['m1', 42],
            updated_at: null,
          },
        },
      })
    );

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
    expect(result.stores[0]?.degradedReason).toBe('checkpoint_read_failed');
    expect(result.stores[0]?.error).toContain('non-string message ID cursor');
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

interface WorkerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnCollectorWorker(
  workerPath: string,
  env: Record<string, string>
): Promise<WorkerRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['run', workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        exitCode: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (existsSync(path)) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

function readNonEmptyLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
