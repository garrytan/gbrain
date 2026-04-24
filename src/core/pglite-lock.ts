import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const LOCK_DIR_NAME = '.mbrain-lock';
const LOCK_FILE = 'lock';
export interface LockHandle {
  lockDir: string;
  acquired: boolean;
}

function getLockDir(dataDir: string | undefined): string {
  if (!dataDir) return '';
  return join(dataDir, LOCK_DIR_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(dataDir: string | undefined, opts?: { timeoutMs?: number }): Promise<LockHandle> {
  if (!dataDir) {
    return { lockDir: '', acquired: true };
  }

  const lockDir = getLockDir(dataDir);
  if (!lockDir) {
    throw new Error('PGLite lock path could not be resolved');
  }

  mkdirSync(dataDir, { recursive: true });

  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (existsSync(lockDir)) {
      const lockPath = join(lockDir, LOCK_FILE);
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const lockPid = lockData.pid as number;
        const lockTime = lockData.acquired_at as number;

        if (!isProcessAlive(lockPid)) {
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch {
            // Another process may have removed it first.
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      } catch {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Another process may have removed it first.
        }
      }
    }

    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(join(lockDir, LOCK_FILE), JSON.stringify({
        pid: process.pid,
        acquired_at: Date.now(),
        command: process.argv.slice(1).join(' '),
      }), { mode: 0o644 });
      return { lockDir, acquired: true };
    } catch {
      if (Date.now() - startTime >= timeoutMs) {
        const lockPath = join(lockDir, LOCK_FILE);
        try {
          const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
          throw new Error(
            `MBrain: Timed out waiting for PGLite lock. Process ${lockData.pid} has held it since ${new Date(lockData.acquired_at).toISOString()} (command: ${lockData.command}). If that process is dead, remove ${lockDir} and try again.`,
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('MBrain: Timed out')) throw error;
          throw new Error(`MBrain: Timed out waiting for PGLite lock. Remove ${lockDir} and try again.`);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error('MBrain: Timed out waiting for PGLite lock.');
}

export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.lockDir || !lock.acquired) return;

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // The lock may have already been cleaned up.
  }
}
