import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';

describe('wave hardening release metadata', () => {
  test('ships the schema-affecting wave as 0.15.0 with migration instructions', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf-8').trim();
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf-8');
    const migrationUrl = new URL('../skills/migrations/v0.15.0.md', import.meta.url);

    expect(version).toBe('0.15.0');
    expect(pkg.version).toBe('0.15.0');
    expect(changelog).toContain('## [0.15.0] - 2026-07-04');
    expect(existsSync(migrationUrl)).toBe(true);

    const migration = readFileSync(migrationUrl, 'utf-8');
    expect(migration).toContain('mbrain init');
    expect(migration).toContain('mbrain setup-agent --apply');
    expect(migration).toContain('retrieval.governed_probe_hybrid');
    expect(migration).toContain('schema v64');
  });
});
