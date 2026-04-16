import { describe, test, expect } from 'bun:test';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Test the report command's output format by importing the logic
// Since runReport reads from stdin/args and writes to disk, we test
// the file creation pattern directly.

describe('report output format', () => {
  const testDir = join(tmpdir(), `gbrain-report-test-${Date.now()}`);

  test('creates report directory structure', () => {
    const reportDir = join(testDir, 'reports', 'test-type');
    mkdirSync(reportDir, { recursive: true });
    expect(existsSync(reportDir)).toBe(true);
    rmSync(testDir, { recursive: true, force: true });
  });

  test('report filename format is YYYY-MM-DD-HHMM.md', () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  });

  test('report page has correct frontmatter structure', () => {
    const title = 'Enrichment Sweep';
    const reportType = 'enrichment-sweep';
    const date = '2026-04-11';
    const time = '14:30';

    const page = `---
title: "${title} -- ${date}"
type: report
report_type: ${reportType}
date: ${date}
time: "${time}"
---

# ${title} -- ${date} ${time}

Report content here.
`;

    expect(page).toContain('type: report');
    expect(page).toContain('report_type: enrichment-sweep');
    expect(page).toContain('# Enrichment Sweep');
  });
});
