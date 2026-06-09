import { describe, expect, test } from 'bun:test';

import { formatImportHeartbeat } from '../src/commands/import.ts';

describe('import heartbeat formatting', () => {
  test('renders progress, rate-derived eta, last success, and slow active files', () => {
    const line = formatImportHeartbeat({
      processed: 25,
      total: 100,
      imported: 20,
      skipped: 4,
      errors: 1,
      chunksCreated: 87,
      activeWorkers: 2,
      lastSuccessPath: 'docs/last.md',
      slowFiles: [
        { path: 'docs/slow-a.md', elapsedMs: 12_400 },
        { path: 'docs/slow-b.md', elapsedMs: 7_100 },
      ],
      elapsedMs: 10_000,
    });

    expect(line).toContain('[gbrain heartbeat] import.files 25/100 (25%)');
    expect(line).toContain('imported=20');
    expect(line).toContain('skipped=4');
    expect(line).toContain('errors=1');
    expect(line).toContain('chunks=87');
    expect(line).toContain('active=2');
    expect(line).toContain('elapsed=10s');
    expect(line).toContain('eta=30s');
    expect(line).toContain('last_success=docs/last.md');
    expect(line).toContain('slow=docs/slow-a.md:12s,docs/slow-b.md:7s');
  });
});
