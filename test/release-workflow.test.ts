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
import { EXPECTED_BUILDER_IDS, expectedAssetName } from '../src/core/binary-self-update.ts';

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

  test('build attests provenance for the compiled binary (self-update integrity depends on it)', () => {
    // binary-self-update verifies the downloaded asset against this attestation
    // (verifyIntegrity). Removing the attest step would fail-close every fleet
    // self-update (integrity_unavailable) with CI still green — this is the pin.
    expect(WORKFLOW).toContain('attest-build-provenance');
    expect(WORKFLOW).toMatch(/subject-path:\s*bin\/\$\{\{ matrix\.artifact \}\}/);
  });

  test('expected builder ids name this workflow file on a trusted ref', () => {
    // verifyIntegrity accepts only attestations whose builder id is exactly
    // release.yml@<trusted ref>. If the workflow file is renamed or the ref
    // scheme changes, this test forces the constant to move in lockstep.
    for (const id of EXPECTED_BUILDER_IDS) {
      expect(id).toContain('/.github/workflows/release.yml@');
      const ref = id.split('@')[1]!;
      expect(ref.startsWith('refs/')).toBe(true);
    }
    // The workflow this repo actually ships from is the one the ids name.
    expect(EXPECTED_BUILDER_IDS.some((id) => id.endsWith('@refs/heads/master'))).toBe(true);
  });

  test('release builds the admin UI fresh from source before compiling', () => {
    // Supply-chain pin: the distributed binary's admin bundle must come from
    // admin/src (built in the release job), never from committed admin/dist
    // bytes. Deleting this step would silently re-trust the committed bundle.
    expect(WORKFLOW).toContain('bun run build:admin');
    expect(WORKFLOW).toMatch(/cd admin && bun install --frozen-lockfile/);
    // Cache key covers the admin lockfile so the fresh build is reproducible.
    expect(WORKFLOW).toContain("hashFiles('bun.lock', 'admin/bun.lock')");
    // Ordering: the admin build must run BEFORE the compile that embeds it.
    const adminIdx = WORKFLOW.indexOf('bun run build:admin');
    const compileIdx = WORKFLOW.indexOf('bun build --compile');
    expect(adminIdx).toBeGreaterThan(-1);
    expect(compileIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(compileIdx);
  });

  test('template-repo push keeps the PAT out of argv (askpass, not URL-embedded)', () => {
    // The token must never ride the git command line: no
    // `https://x-access-token:${TEMPLATE_REPO_PAT}@...` remote URLs.
    expect(WORKFLOW).not.toContain('x-access-token:${TEMPLATE_REPO_PAT}@');
    expect(WORKFLOW).not.toMatch(/git push[^\n]*TEMPLATE_REPO_PAT/);
    // Credential travels out-of-band via a one-shot askpass reading env.
    expect(WORKFLOW).toContain('GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0');
    // Force-push semantics preserved (history-less template publish).
    expect(WORKFLOW).toMatch(/git push --force "https:\/\/github\.com\/\$\{TEMPLATE_REPO\}\.git" HEAD:main/);
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
