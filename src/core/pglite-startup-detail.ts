import { isPgliteProcessStartupFailure } from './pglite-errors.ts';

const MAX_STARTUP_LOG_LINES = 40;

function recordStartupLine(lines: string[], args: unknown[]): void {
  const line = args.map(item => typeof item === 'string' ? item : String(item)).join(' ');
  if (line.trim()) lines.push(line);
}

export async function createWithStartupDetail<T>(
  create: (debug: 0 | 1) => Promise<T>,
): Promise<T> {
  try {
    return await create(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isPgliteProcessStartupFailure(message) || message.includes('\n')) throw error;
    const lines: string[] = [];
    const previousDebug = console.debug;
    const previousError = console.error;
    console.debug = (...args: unknown[]) => recordStartupLine(lines, args);
    console.error = (...args: unknown[]) => recordStartupLine(lines, args);
    try {
      return await create(1);
    } catch (retryError) {
      const base = retryError instanceof Error ? retryError.message : String(retryError);
      const detail = lines.slice(-MAX_STARTUP_LOG_LINES).join('\n');
      throw new Error(detail ? `${base}\n${detail}` : base, { cause: retryError });
    } finally {
      console.debug = previousDebug;
      console.error = previousError;
    }
  }
}
