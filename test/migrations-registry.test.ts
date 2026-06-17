/**
 * Tests for the TS migration registry (src/commands/migrations/index.ts).
 *
 * The registry replaces filesystem discovery of skills/migrations/*.md so
 * the compiled `gbrain` binary can enumerate migrations without a readdir.
 */

import { describe, test, expect } from 'bun:test';
import { migrations, getMigration, compareVersions } from '../src/commands/migrations/index.ts';

describe('migration registry', () => {
  test('exports a non-empty migrations array', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  test('every migration has version + featurePitch.headline + orchestrator', () => {
    for (const m of migrations) {
      expect(typeof m.version).toBe('string');
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof m.featurePitch.headline).toBe('string');
      expect(m.featurePitch.headline.length).toBeGreaterThan(0);
      expect(typeof m.orchestrator).toBe('function');
    }
  });

  test('migrations are in ascending semver order', () => {
    for (let i = 1; i < migrations.length; i++) {
      expect(compareVersions(migrations[i].version, migrations[i - 1].version)).toBe(1);
    }
  });

  test('v0.11.0 is present', () => {
    const m = getMigration('0.11.0');
    expect(m).not.toBeNull();
    expect(m!.featurePitch.headline).toContain('Minions');
  });

  test('getMigration returns null for unknown versions', () => {
    expect(getMigration('99.99.99')).toBeNull();
    expect(getMigration('')).toBeNull();
  });
});

describe('compareVersions', () => {
  test('equal versions return 0', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('newer returns 1', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });

  test('older returns -1', () => {
    expect(compareVersions('1.2.2', '1.2.3')).toBe(-1);
    expect(compareVersions('0.11.0', '0.11.1')).toBe(-1);
    expect(compareVersions('0.11.0', '0.12.0')).toBe(-1);
  });

  test('handles single-digit versions', () => {
    expect(compareVersions('9.0.0', '10.0.0')).toBe(-1);
  });
});
