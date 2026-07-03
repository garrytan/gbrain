export function encodeJsonColumn(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        // Fall through and encode a plain string as JSON.
      }
    }
  }
  return JSON.stringify(value);
}

export function decodeJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fallback;
  }

  if (typeof parsed === 'string') {
    try {
      return JSON.parse(parsed) as T;
    } catch {
      return parsed as T;
    }
  }
  return parsed as T;
}
