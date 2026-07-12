import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DesktopVersionHistory {
  current: string;
  previous?: string;
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

export function nextDesktopVersionHistory(
  existing: DesktopVersionHistory | null,
  current: string,
  fallbackPrevious?: string,
): DesktopVersionHistory {
  if (existing?.current === current) return existing;
  const previous = validVersion(existing?.current) && existing.current !== current
    ? existing.current
    : validVersion(fallbackPrevious) && fallbackPrevious !== current
      ? fallbackPrevious
      : validVersion(existing?.previous) && existing.previous !== current
        ? existing.previous
        : undefined;
  return { current, ...(previous ? { previous } : {}) };
}

export function updateDesktopVersionHistory(
  path: string,
  current: string,
  fallbackPrevious?: string,
): DesktopVersionHistory {
  let existing: DesktopVersionHistory | null = null;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as DesktopVersionHistory;
      if (validVersion(parsed.current)) existing = parsed;
    } catch {
      // A damaged optional history file must not prevent PMBrain from starting.
    }
  }
  const next = nextDesktopVersionHistory(existing, current, fallbackPrevious);
  if (!existing || existing.current !== next.current || existing.previous !== next.previous) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  return next;
}
