import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #4987: timeline extraction scans the WHOLE page (parseTimelineEntries +
// parseInlineCitationTimelineEntries — behavior pinned in test/extract.test.ts);
// the `<!-- timeline -->` sentinel only splits compiled_truth from timeline for
// storage. The docs must not tell operators the sentinel scopes extraction,
// because a `[Source: ..., YYYY-MM-DD]` citation under a compiled-truth bullet
// mints a permanent timeline row and no removal op exists.
const repoRoot = join(import.meta.dir, '..');

describe('#4987 timeline extraction docs describe the real trigger', () => {
  test('system-of-record.md Timeline row names dated markers anywhere in the page', () => {
    const doc = readFileSync(join(repoRoot, 'docs/architecture/system-of-record.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| **Timeline**'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/section after/);
    expect(row).toContain('[Source:');
  });

  test('compiled-truth.md warns that compiled-truth citations mint timeline rows', () => {
    const doc = readFileSync(join(repoRoot, 'docs/guides/compiled-truth.md'), 'utf8');
    expect(doc).toContain('auto_timeline');
    expect(doc).toMatch(/blank line above and\s+below/);
  });
});
