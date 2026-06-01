import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseImportIphoneFlags } from '../../src/commands/import-iphone.ts';
import { operations } from '../../src/core/operations.ts';

describe('import-iphone command surface', () => {
  test('parses local CLI flags without requiring an engine', () => {
    const flags = parseImportIphoneFlags([
      '--backup', '/tmp/decrypted-backup',
      '--source-id', 'default',
      '--self-name', 'Me Example',
      '--limit', '25',
      '--max-messages', '100',
      '--dry-run',
      '--json',
    ]);

    expect(flags.backupDir).toBe('/tmp/decrypted-backup');
    expect(flags.sourceId).toBe('default');
    expect(flags.selfName).toBe('Me Example');
    expect(flags.limit).toBe(25);
    expect(flags.maxMessages).toBe(100);
    expect(flags.dryRun).toBe(true);
    expect(flags.json).toBe(true);
  });

  test('rejects invalid limits before any import starts', () => {
    expect(() => parseImportIphoneFlags(['--backup', '/tmp/backup', '--limit', '0']))
      .toThrow('--limit must be a positive integer');
    expect(() => parseImportIphoneFlags(['--backup', '/tmp/backup', '--limit', '1.5']))
      .toThrow('--limit must be a positive integer');
    expect(() => parseImportIphoneFlags(['--backup', '/tmp/backup', '--max-messages', '0']))
      .toThrow('--max-messages must be a positive integer');
  });

  test('is intentionally not exposed as an MCP operation', () => {
    const opNames = new Set(operations.map((op) => op.name));
    const cliNames = new Set(operations.map((op) => op.cliHints?.name).filter(Boolean));

    expect(opNames.has('import_iphone')).toBe(false);
    expect(opNames.has('import-iphone')).toBe(false);
    expect(cliNames.has('import-iphone')).toBe(false);
  });

  test('is refused on thin-client installs before local engine routing', () => {
    const cliSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli.ts'), 'utf8');
    expect(cliSource).toContain("'extract-conversation-facts', 'import-iphone', 'migrate'");
    expect(cliSource).toContain("'import-iphone': 'import-iphone reads decrypted local iPhone backup files");
  });
});
