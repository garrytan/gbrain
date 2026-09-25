import { constants } from 'node:os';

/** Interrupted OS observations can be retried; missing metrics never become zero or a skipped gate. */
export function readResidentBytes(read: () => number = () => process.memoryUsage().rss): number {
  for (let attempt = 0; ; attempt++) {
    try {
      const bytes = read();
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('RSS sampling requires a positive integer byte measurement.');
      return bytes;
    } catch (error) {
      const interrupted = error instanceof Error && 'syscall' in error && error.syscall === 'memoryUsage' &&
        (('errno' in error && error.errno === constants.errno.EINTR) || ('code' in error && error.code === 'EINTR'));
      if (!interrupted || attempt >= 2) throw error;
    }
  }
}
