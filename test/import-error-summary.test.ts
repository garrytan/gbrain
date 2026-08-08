import { describe, test, expect } from 'bun:test';
import { recordImportFailure } from '../src/commands/import.ts';

describe('recordImportFailure', () => {
  test('groups errors that differ only in a quoted per-file value', () => {
    const errorCounts: Record<string, number> = {};
    const errorSamples: Record<string, string> = {};

    const a = recordImportFailure(
      errorCounts, errorSamples,
      'insert or update on table "pages" violates foreign key constraint "pages_source_id_fkey"',
    );
    const b = recordImportFailure(
      errorCounts, errorSamples,
      'insert or update on table "pages" violates foreign key constraint "pages_source_id_fkey"',
    );

    expect(a.key).toBe(b.key);
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
  });

  test('the printed sample preserves table/constraint names — the #3837 regression', () => {
    const errorCounts: Record<string, number> = {};
    const errorSamples: Record<string, string> = {};

    let last;
    for (let i = 0; i < 7; i++) {
      last = recordImportFailure(
        errorCounts, errorSamples,
        'insert or update on table "pages" violates foreign key constraint "pages_source_id_fkey"',
      );
    }

    // Pre-fix, the grouping key itself was printed and had blanked every
    // quoted substring: `table "" violates foreign key constraint ""`.
    expect(last!.sample).toContain('table "pages"');
    expect(last!.sample).toContain('constraint "pages_source_id_fkey"');
    expect(last!.count).toBe(7);
  });

  test('the grouping key still blanks quoted content (unchanged dedup behavior)', () => {
    const errorCounts: Record<string, number> = {};
    const errorSamples: Record<string, string> = {};

    const a = recordImportFailure(errorCounts, errorSamples, 'Source "foo.md" not found');
    const b = recordImportFailure(errorCounts, errorSamples, 'Source "bar.md" not found');

    // Different per-file filenames still collapse into one group...
    expect(a.key).toBe(b.key);
    expect(b.count).toBe(2);
    // ...but the retained sample is a real, complete message (the first one seen).
    expect(errorSamples[a.key]).toBe('Source "foo.md" not found');
  });

  test('distinct error shapes get distinct groups', () => {
    const errorCounts: Record<string, number> = {};
    const errorSamples: Record<string, string> = {};

    const a = recordImportFailure(errorCounts, errorSamples, 'ENOENT: no such file or directory');
    const b = recordImportFailure(errorCounts, errorSamples, 'YAML parse error: bad indentation');

    expect(a.key).not.toBe(b.key);
    expect(errorCounts[a.key]).toBe(1);
    expect(errorCounts[b.key]).toBe(1);
  });
});
