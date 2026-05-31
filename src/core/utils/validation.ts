/**
 * Validate and normalize a slug. Slugs are lowercased repo-relative paths.
 * Rejects empty slugs, path traversal (..), and leading /.
 */
export function validateSlug(slug: string): string {
  if (!slug || /(^|\/)\.\.($|\/)/.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
  return slug.toLowerCase();
}

export function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function parseValidIsoTimestamp(value: string): Date | null {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return null;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, millisecondRaw = '', zoneRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (zoneRaw !== 'Z') {
    const offsetHour = Number(zoneRaw.slice(1, 3));
    const offsetMinute = Number(zoneRaw.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (zoneRaw === 'Z') {
    const milliseconds = millisecondRaw.padEnd(3, '0');
    const normalized = `${yearRaw}-${monthRaw}-${dayRaw}T${hourRaw}:${minuteRaw}:${secondRaw}.${milliseconds}Z`;
    if (parsed.toISOString() !== normalized) return null;
  }
  return parsed;
}
