/**
 * #6855: audit EVERY doctor golden. Any golden that renders the Google
 * `google_calendar_readable` check must also render `apple_permissions`
 * directly after it (the position `buildChecks` emits it). Catches a golden
 * that was missed when the Apple check was registered (e.g. the Postgres
 * fresh golden, which only runs under DATABASE_URL and so is invisible to the
 * PGLite suite). Pure file reads; no network, no DB.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, 'fixtures/goldens/doctor');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

/** Every array of `{name}` objects (a doctor `checks` list) anywhere in the value. */
function checkLists(v: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string')) {
      out.push(v.map((x) => (x as { name: string }).name));
    }
    for (const x of v) checkLists(x, out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) checkLists(x, out);
  }
  return out;
}

/** Human-format lines: `[OK] name: message`. */
function humanNames(v: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(v)) {
    const names = v.flatMap((x) => (typeof x === 'string' ? [/^\s*\[(?:OK|WARN|FAIL)\]\s+([A-Za-z0-9_]+):/.exec(x)?.[1]] : [])).filter((n): n is string => !!n);
    if (names.length) out.push(names);
    for (const x of v) humanNames(x, out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) humanNames(x, out);
  }
  return out;
}

describe('doctor goldens: apple_permissions follows google_calendar_readable', () => {
  test('audit finds the golden set', () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
    expect(files).toContain('json-postgres-fresh.json');
  });

  for (const f of files) {
    test(f, () => {
      const parsed = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      const lists = [...checkLists(parsed), ...humanNames(parsed)];
      for (const names of lists) {
        const g = names.indexOf('google_calendar_readable');
        if (g < 0) {
          expect(names).not.toContain('apple_permissions');
          continue;
        }
        expect(names.filter((n) => n === 'apple_permissions')).toHaveLength(1);
        expect(names[g + 1]).toBe('apple_permissions');
      }
    });
  }

  test('Postgres fresh golden carries the same apple_permissions entry as the PGLite fresh golden', () => {
    const entry = (f: string) =>
      (checkLists(JSON.parse(readFileSync(join(DIR, f), 'utf8'))), JSON.stringify(
        (function find(v: any): unknown {
          if (Array.isArray(v)) { for (const x of v) { const r = find(x); if (r) return r; } return undefined; }
          if (v && typeof v === 'object') { if (v.name === 'apple_permissions') return v; for (const x of Object.values(v)) { const r = find(x); if (r) return r; } }
          return undefined;
        })(JSON.parse(readFileSync(join(DIR, f), 'utf8'))),
      ));
    expect(entry('json-postgres-fresh.json')).toBe(entry('json-pglite-fresh.json'));
    expect(entry('json-postgres-fresh.json')).not.toBe(undefined);
  });
});
