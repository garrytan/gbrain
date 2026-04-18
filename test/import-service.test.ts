import { describe, expect, test } from 'bun:test';
import {
  collectImportSummary,
  resolveImportPlan,
} from '../src/core/services/import-service.ts';

describe('import service', () => {
  test('collectImportSummary tracks imported, skipped, errors, and unchanged files', () => {
    const summary = collectImportSummary({
      totalFiles: 3,
      events: [
        { type: 'imported', slug: 'notes/a', chunks: 2 },
        { type: 'skipped', reason: 'unchanged' },
        { type: 'error', message: 'bad frontmatter' },
      ],
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.chunksCreated).toBe(2);
    expect(summary.totalFiles).toBe(3);
  });

  test('resolveImportPlan resumes when checkpoint matches root and file count', () => {
    const allFiles = ['/brain/a.md', '/brain/b.md', '/brain/c.md'];
    const plan = resolveImportPlan({
      rootDir: '/brain',
      allFiles,
      fresh: false,
      checkpoint: {
        dir: '/brain',
        totalFiles: allFiles.length,
        processedIndex: 2,
        timestamp: new Date().toISOString(),
      },
    });

    expect(plan.resumeIndex).toBe(2);
    expect(plan.files).toEqual(['/brain/c.md']);
    expect(plan.resumed).toBe(true);
  });
});
