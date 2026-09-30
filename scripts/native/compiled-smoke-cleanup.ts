import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

interface CleanupOptions {
  platform?: NodeJS.Platform;
  remove?: (path: string) => void;
  wait?: (milliseconds: number) => Promise<unknown>;
}

/** Remove a compiled fixture only after its child processes have exited. */
export async function removeCompiledSmokeDirectory(path: string, {
  platform = process.platform,
  remove = path => rmSync(path, { recursive: true, force: true }),
  wait = delay,
}: CleanupOptions = {}): Promise<void> {
  // Windows may briefly retain an executable handle after process exit.
  // Bun 1.3.11/1.3.13 ignore rm's maxRetries, so bound this EBUSY-only wait here.
  for (let retry = 0; ; retry++) {
    try {
      remove(path);
      return;
    } catch (error) {
      if (platform !== 'win32' || (error as NodeJS.ErrnoException)?.code !== 'EBUSY' || retry === 5) throw error;
      await wait(100 * (retry + 1));
    }
  }
}
