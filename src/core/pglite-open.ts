import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { stringifyPgliteInitError } from './pglite-engine.ts';
import { clearPgliteDataDirReadonly, clearStalePglitePostmasterPid } from './pglite-lock.ts';

const MAX_STARTUP_LOG_LINES = 40;

function recordStartupLine(lines: string[], args: unknown[]): void {
  const line = args.map(item => typeof item === 'string' ? item : String(item)).join(' ');
  if (line.trim()) lines.push(line);
}

function permissionError(detail: string): Error {
  return new Error([
    'PGlite failed to initialize properly',
    'FATAL: could not create lock file "postmaster.pid": Permission denied',
    detail,
  ].join('\n'));
}

export function assertPgliteDataDirLockWritable(dataDir: string): void {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(dataDir);
  } catch {
    return;
  }
  if (!info.isDirectory() || (info.mode & 0o222) !== 0) return;
  throw permissionError('数据目录仍没有写入属性，启动锁 postmaster.pid 无法创建。');
}

function assertDataDirWritable(dataDir: string): void {
  const probe = join(dataDir, `.pmbrain-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, '1');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EPERM';
    const detail = error instanceof Error ? error.message : String(error);
    throw permissionError(`${code}: ${detail}`);
  } finally {
    try { unlinkSync(probe); } catch { /* probe already absent */ }
  }
}

export async function createPgliteDatabase(options: PGliteOptions): Promise<PGlite> {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir : '';
  if (dataDir) {
    clearPgliteDataDirReadonly(dataDir);
    assertPgliteDataDirLockWritable(dataDir);
    const cleared = clearStalePglitePostmasterPid(dataDir);
    if (cleared.status === 'blocked') {
      throw permissionError(`${cleared.code}: ${cleared.detail}`);
    }
    assertDataDirWritable(dataDir);
  }

  const lines: string[] = [];
  const previousLog = console.log;
  const previousDebug = console.debug;
  const previousError = console.error;
  const previousWrite = process.stdout.write;
  console.log = (...args: unknown[]) => recordStartupLine(lines, args);
  console.debug = (...args: unknown[]) => recordStartupLine(lines, args);
  console.error = (...args: unknown[]) => recordStartupLine(lines, args);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    recordStartupLine(lines, [text]);
    const done = typeof encoding === 'function' ? encoding : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    const db = await PGlite.create({ ...options, debug: 1 });
    (db as { debug?: number }).debug = 0;
    return db;
  } catch (error) {
    const base = stringifyPgliteInitError(error);
    const detail = lines.slice(-MAX_STARTUP_LOG_LINES).join('\n').trim();
    if (!detail || base.includes(detail)) {
      if (error instanceof Error && error.message === base) throw error;
      throw new Error(base, { cause: error });
    }
    throw new Error(`${base}\n${detail}`, { cause: error });
  } finally {
    console.log = previousLog;
    console.debug = previousDebug;
    console.error = previousError;
    process.stdout.write = previousWrite;
  }
}
