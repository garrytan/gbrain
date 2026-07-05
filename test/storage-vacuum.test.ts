import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { runStorage } from '../src/commands/storage.ts';

describe('storage vacuum maintenance command', () => {
  test('runs VACUUM ANALYZE followed by CHECKPOINT through the connected engine', async () => {
    const calls: string[] = [];
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as any;

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ''));
      };
      console.warn = () => {};

      await runStorage(engine, ['vacuum', '--json']);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(calls).toEqual(['VACUUM (ANALYZE)', 'CHECKPOINT']);
    expect(JSON.parse(logs.join('\n'))).toMatchObject({
      ok: true,
      vacuum: 'VACUUM (ANALYZE)',
      checkpoint: 'CHECKPOINT',
    });
  });

  test('writes and verifies a PGLite data-dir backup before reporting success', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-storage-backup-'));
    try {
      const backupDir = join(tmp, 'backups');
      const tarBytes = makeTarFixture(tmp, 'fixture.tar');
      const calls: string[] = [];
      let dumpCompression: string | undefined;
      const engine = {
        kind: 'pglite',
        executeRaw: async (sql: string) => {
          calls.push(sql);
          return [];
        },
        db: {
          dumpDataDir: async (compression?: string) => {
            dumpCompression = compression;
            return blobFromBuffer(tarBytes);
          },
        },
      } as any;

      const logs: string[] = [];
      const originalLog = console.log;
      try {
        console.log = (message?: unknown) => {
          logs.push(String(message ?? ''));
        };

        await runStorage(engine, ['backup', '--dir', backupDir, '--no-compress', '--json']);
      } finally {
        console.log = originalLog;
      }

      const result = JSON.parse(logs.join('\n'));
      expect(calls).toEqual(['CHECKPOINT']);
      expect(dumpCompression).toBe('none');
      expect(result).toMatchObject({
        ok: true,
        compression: 'none',
        verified_file_count: 3,
        retained_count: 1,
      });
      expect(result.output_path).toMatch(/brain-pglite-\d{8}T\d{6}Z\.tar$/);
      expect(readFileSync(result.output_path).byteLength).toBe(tarBytes.byteLength);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('prunes oldest backups after the new backup verifies', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-storage-backup-prune-'));
    try {
      const backupDir = join(tmp, 'backups');
      const tarBytes = makeTarFixture(tmp, 'fixture.tar');
      for (let i = 0; i < 7; i++) {
        const name = `brain-pglite-2026070${i + 1}T000000Z.tar`;
        const path = join(backupDir, name);
        writeTarFixture(path, tarBytes);
        const when = new Date(Date.UTC(2026, 6, i + 1));
        utimesSync(path, when, when);
      }

      const engine = {
        kind: 'pglite',
        executeRaw: async () => [],
        db: {
          dumpDataDir: async () => blobFromBuffer(tarBytes),
        },
      } as any;

      const logs: string[] = [];
      const originalLog = console.log;
      try {
        console.log = (message?: unknown) => {
          logs.push(String(message ?? ''));
        };
        await runStorage(engine, ['backup', '--dir', backupDir, '--no-compress', '--json', '--max-count', '7']);
      } finally {
        console.log = originalLog;
      }

      const result = JSON.parse(logs.join('\n'));
      expect(result.ok).toBe(true);
      expect(result.retained_count).toBe(7);
      expect(result.pruned).toHaveLength(1);
      expect(result.pruned[0].path).toContain('brain-pglite-20260701T000000Z.tar');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function makeTarFixture(root: string, name: string): Buffer {
  const srcDir = join(root, `${name}.src`);
  const tarPath = join(root, name);
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'PG_VERSION'), '16\n');
  writeFileSync(join(srcDir, 'postgresql.conf'), 'max_wal_size = 256MB\n');
  const result = spawnSync('tar', ['-cf', tarPath, '-C', srcDir, '.'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return readFileSync(tarPath);
}

function writeTarFixture(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function blobFromBuffer(bytes: Buffer): Blob {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  return new Blob([view]);
}
