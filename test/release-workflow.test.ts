/**
 * Contract pin between .github/workflows/release.yml and
 * src/core/binary-self-update.ts (#3521).
 *
 * Binary installs download upgrade assets from `releases/latest` by the exact
 * names expectedAssetName() returns. If the workflow's build matrix or the
 * release `files:` list drifts from those names, self-update silently degrades
 * to notify-only (`no_asset`) for everyone — this test is the guard.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedAssetName } from '../src/core/binary-self-update.ts';

const ROOT = join(import.meta.dir, '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');

/** Every platform/arch the self-updater can request an asset for. */
const EXPECTED_ASSETS = (
  [
    ['darwin', 'arm64'],
    ['linux', 'x64'],
  ] as const
).map(([p, a]) => expectedAssetName(p, a) as string);

describe('release.yml ↔ binary-self-update asset contract', () => {
  test('workflow build matrix produces exactly the assets the updater requests', () => {
    const artifacts = [...WORKFLOW.matchAll(/artifact:\s*(\S+)/g)].map((m) => m[1]).sort();
    expect(artifacts).toEqual([...EXPECTED_ASSETS].sort());
  });

  test('every expected asset is attached to the release', () => {
    for (const name of EXPECTED_ASSETS) {
      // download-artifact unpacks to artifacts/<name>/<name>
      expect(WORKFLOW).toContain(`artifacts/${name}/${name}`);
    }
  });

  test('idempotency completeness check names every expected asset', () => {
    // The version job only skips when the existing release carries ALL assets;
    // its sorted-join comparison string must stay in sync with the matrix.
    expect(WORKFLOW).toContain([...EXPECTED_ASSETS].sort().join(','));
  });

  test('release tag derives from the VERSION file, v-prefixed', () => {
    expect(WORKFLOW).toContain('< VERSION');
    expect(WORKFLOW).toMatch(/tag_name: v\$\{\{ needs\.version\.outputs\.version \}\}/);
  });

  test('missing binaries fail the release instead of publishing assetless', () => {
    expect(WORKFLOW).toContain('fail_on_unmatched_files: true');
  });

  test('contents:write is scoped to the release job, not the whole workflow', () => {
    const topLevel = WORKFLOW.slice(0, WORKFLOW.indexOf('jobs:'));
    expect(topLevel).toContain('contents: read');
    expect(topLevel).not.toContain('contents: write');
  });
});

describe('scripts/changelog-entry.sh', () => {
  const FIXTURE = `# Changelog

## [0.42.67.0] - 2026-07-28

Release summary line.

### Fixed
- top entry fix

## [0.42.6] - 2026-07-27

### Added
- historical 3-segment entry
`;

  function run(version: string): { out: string; code: number } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-chlog-'));
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    try {
      const out = execFileSync('bash', [join(ROOT, 'scripts/changelog-entry.sh'), version, file], {
        encoding: 'utf-8',
      });
      return { out, code: 0 };
    } catch (e: any) {
      return { out: String(e.stdout ?? ''), code: e.status ?? 1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('extracts exactly the requested entry, header excluded', () => {
    const { out, code } = run('0.42.67.0');
    expect(code).toBe(0);
    expect(out).toContain('top entry fix');
    expect(out).not.toContain('## [0.42.67.0]');
    expect(out).not.toContain('historical 3-segment entry');
  });

  test('extracts a non-top (historical 3-segment) entry', () => {
    const { out, code } = run('0.42.6');
    expect(code).toBe(0);
    expect(out).toContain('historical 3-segment entry');
    expect(out).not.toContain('top entry fix');
  });

  test('exits non-zero for a version with no entry', () => {
    expect(run('9.9.9.9').code).not.toBe(0);
  });

  test('a version that is a string prefix of another does not false-match', () => {
    // "0.42.67" is a prefix of "0.42.67.0" but has no entry of its own.
    expect(run('0.42.67').code).not.toBe(0);
  });
});
