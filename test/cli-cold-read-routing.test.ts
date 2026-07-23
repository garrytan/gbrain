import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cli = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8');

describe('CLI cold-read routing regression contracts', () => {
  test('shared read operations skip the migration/schema startup path', () => {
    expect(cli).toContain(
      "connectEngine(op.scope === 'read' ? { probeOnly: true } : undefined)",
    );
  });

  test('sources list uses a probe-only connection inside its 10-second budget', () => {
    const start = cli.indexOf('const readOnlyDefaultTimeoutMs');
    const end = cli.indexOf('// #1633:', start);
    const block = cli.slice(start, end);

    expect(block).toContain('connectEngine({ probeOnly: true })');
    expect(block).toContain("command === 'sources'");
  });

  test('free-text search is not misrouted to the dashboard subcommand dispatcher', () => {
    const start = cli.indexOf('const readOnlyDefaultTimeoutMs');
    const end = cli.indexOf('const cliOptsResolved', start);
    const routingExpression = cli.slice(start, end);

    expect(routingExpression).not.toContain("command === 'search'");
  });
});
