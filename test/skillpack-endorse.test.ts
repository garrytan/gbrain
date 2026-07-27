/**
 * Tests for src/core/skillpack/endorse.ts — Garry-only registry endorsement
 * workflow.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  EndorseError,
  applyEndorsement,
  runEndorse,
} from '../src/core/skillpack/endorse.ts';
import {
  ENDORSEMENTS_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  type EndorsementsFile,
} from '../src/core/skillpack/registry-schema.ts';

const VALID_REGISTRY = {
  schema_version: REGISTRY_SCHEMA_VERSION,
  updated_at: '2026-05-18T20:00:00Z',
  skillpacks: [
    {
      name: 'hackathon-evaluation',
      description: 'Score hackathon submissions',
      author: 'Garry Tan',
      author_handle: 'garrytan',
      homepage: 'https://github.com/garrytan/skillpack-hackathon-evaluation',
      source: {
        kind: 'git' as const,
        url: 'https://github.com/garrytan/skillpack-hackathon-evaluation.git',
        pinned_commit: 'a'.repeat(40),
      },
      tarball_sha256: 'b'.repeat(64),
      gbrain_min_version: '0.36.0',
      default_tier: 'community' as const,
      tags: ['evaluation'],
      validated_at: '2026-05-18T20:00:00Z',
      validation_run_id: 'r1',
      skills_count: 2,
      skills: ['skills/judge-submission', 'skills/score-rubric'],
      version: '0.1.0',
    },
  ],
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'endorse-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Create a synthetic registry repo, optionally with pre-existing endorsements. */
function makeRegistryRepo(prior?: EndorsementsFile): string {
  const repo = mkdtempSync(join(tmp, 'repo-'));
  writeFileSync(join(repo, 'registry.json'), JSON.stringify(VALID_REGISTRY, null, 2));
  if (prior) {
    writeFileSync(join(repo, 'endorsements.json'), JSON.stringify(prior, null, 2));
  }
  // Initialize as a real git repo so commit works.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

describe('applyEndorsement — pure mutation', () => {
  test('promotes a previously-unset pack to endorsed', () => {
    const current: EndorsementsFile = {
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: {},
    };
    const { next, prior_tier } = applyEndorsement(current, 'foo', 'endorsed');
    expect(prior_tier).toBeNull();
    expect(next.endorsements['foo']?.tier).toBe('endorsed');
    expect(next.endorsements['foo']?.endorsed_at).toBeTruthy();
  });

  test('updates an existing endorsement', () => {
    const current: EndorsementsFile = {
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: { foo: { tier: 'community', endorsed_at: '2026-01-01' } },
    };
    const { next, prior_tier } = applyEndorsement(current, 'foo', 'endorsed');
    expect(prior_tier).toBe('community');
    expect(next.endorsements['foo']?.tier).toBe('endorsed');
  });

  test('records the note when provided', () => {
    const { next } = applyEndorsement(
      { schema_version: ENDORSEMENTS_SCHEMA_VERSION, endorsements: {} },
      'foo',
      'endorsed',
      'promoted after 30 clean days',
    );
    expect(next.endorsements['foo']?.note).toBe('promoted after 30 clean days');
  });

  test('immutable: does not mutate the input', () => {
    const current: EndorsementsFile = {
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: { foo: { tier: 'community', endorsed_at: '2026-01-01' } },
    };
    applyEndorsement(current, 'bar', 'endorsed');
    expect(current.endorsements['bar']).toBeUndefined();
  });
});

describe('runEndorse — full flow', () => {
  test('writes endorsements.json + commits when pack is in the catalog', () => {
    const repo = makeRegistryRepo();
    const result = runEndorse({
      registryRepoRoot: repo,
      packName: 'hackathon-evaluation',
    });
    expect(result.prior_tier).toBeNull();
    expect(result.new_tier).toBe('endorsed');
    expect(result.commit_sha).toMatch(/^[a-f0-9]{7,40}$/);
    expect(result.pushed).toBe(false);

    // File contents.
    const file = JSON.parse(readFileSync(join(repo, 'endorsements.json'), 'utf-8'));
    expect(file.endorsements['hackathon-evaluation']?.tier).toBe('endorsed');

    // Commit message.
    const msg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf-8' });
    expect(msg.trim()).toBe('endorse: hackathon-evaluation -> endorsed');
  });

  test('refuses when pack is not in the catalog', () => {
    const repo = makeRegistryRepo();
    try {
      runEndorse({
        registryRepoRoot: repo,
        packName: 'nonexistent-pack',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as EndorseError).code).toBe('pack_not_in_catalog');
    }
  });

  test('refuses when path is not a registry repo', () => {
    const notRepo = mkdtempSync(join(tmp, 'not-a-repo-'));
    try {
      runEndorse({
        registryRepoRoot: notRepo,
        packName: 'hackathon-evaluation',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as EndorseError).code).toBe('not_a_registry_repo');
    }
  });

  test('--dry-run reports the change without writing or committing', () => {
    const repo = makeRegistryRepo();
    const result = runEndorse({
      registryRepoRoot: repo,
      packName: 'hackathon-evaluation',
      dryRun: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.commit_sha).toBeNull();
    expect(result.pushed).toBe(false);
    // No file written.
    expect(existsSync(join(repo, 'endorsements.json'))).toBe(false);
    // No commit beyond the initial.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' });
    expect(log.split('\n').filter(Boolean).length).toBe(1);
  });

  test('preserves stable key ordering on write', () => {
    const repo = makeRegistryRepo({
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: {
        'zeta-pack': { tier: 'community', endorsed_at: '2026-01-01' },
        'alpha-pack': { tier: 'endorsed', endorsed_at: '2026-01-01' },
      },
    });
    runEndorse({
      registryRepoRoot: repo,
      packName: 'hackathon-evaluation',
    });
    const content = readFileSync(join(repo, 'endorsements.json'), 'utf-8');
    const alphaIdx = content.indexOf('alpha-pack');
    const hackIdx = content.indexOf('hackathon-evaluation');
    const zetaIdx = content.indexOf('zeta-pack');
    expect(alphaIdx).toBeLessThan(hackIdx);
    expect(hackIdx).toBeLessThan(zetaIdx);
  });

  test('handles a tier downgrade to dead', () => {
    const repo = makeRegistryRepo({
      schema_version: ENDORSEMENTS_SCHEMA_VERSION,
      endorsements: {
        'hackathon-evaluation': { tier: 'endorsed', endorsed_at: '2026-01-01' },
      },
    });
    const result = runEndorse({
      registryRepoRoot: repo,
      packName: 'hackathon-evaluation',
      tier: 'dead',
      note: 'author archived the source repo',
    });
    expect(result.prior_tier).toBe('endorsed');
    expect(result.new_tier).toBe('dead');
    const file = JSON.parse(readFileSync(join(repo, 'endorsements.json'), 'utf-8'));
    expect(file.endorsements['hackathon-evaluation']?.tier).toBe('dead');
    expect(file.endorsements['hackathon-evaluation']?.note).toBe('author archived the source repo');
  });
});
