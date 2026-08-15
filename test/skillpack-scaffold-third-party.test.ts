/**
 * Tests for src/core/skillpack/scaffold-third-party.ts — the orchestrator.
 *
 * Uses a synthetic local-path skillpack fixture so the flow exercises:
 * resolveSource → loadSkillpackManifest → askTrust → enumerateScaffoldEntries
 * → copyArtifacts → state.json upsert → bootstrap display.
 *
 * Git + tarball sources are exercised in test/skillpack-remote-source.test.ts
 * and in the e2e flow test.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ScaffoldThirdPartyError,
  runScaffoldThirdParty,
} from '../src/core/skillpack/scaffold-third-party.ts';
import { resolveSource } from '../src/core/skillpack/remote-source.ts';
import { SKILLPACK_API_VERSION, type SkillpackManifest } from '../src/core/skillpack/manifest-v1.ts';
import { loadState, SKILLPACK_STATE_SCHEMA_VERSION } from '../src/core/skillpack/state.ts';

interface FixtureOptions {
  /** Optional manifest overrides. */
  manifestOverrides?: Partial<SkillpackManifest>;
  /** When true, include a bootstrap.md runbook. */
  withBootstrap?: boolean;
}

/** Build a minimal valid third-party pack in a tempdir. */
function buildPackFixture(root: string, opts: FixtureOptions = {}): SkillpackManifest {
  const manifest: SkillpackManifest = {
    api_version: SKILLPACK_API_VERSION,
    name: 'sample-pack',
    version: '0.1.0',
    description: 'Sample pack for tests.',
    author: 'Test Author',
    license: 'MIT',
    homepage: 'https://example.com/sample-pack',
    gbrain_min_version: '0.30.0',
    skills: ['skills/sample-skill'],
    ...opts.manifestOverrides,
  };
  if (opts.withBootstrap) {
    manifest.runbooks = { bootstrap: 'runbooks/bootstrap.md' };
  }

  mkdirSync(join(root, 'skills/sample-skill'), { recursive: true });
  writeFileSync(
    join(root, 'skills/sample-skill/SKILL.md'),
    '---\nname: sample-skill\ndescription: sample\ntriggers:\n  - sample me\n---\n\nsample content\n',
  );
  writeFileSync(join(root, 'skillpack.json'), JSON.stringify(manifest, null, 2));

  if (opts.withBootstrap) {
    mkdirSync(join(root, 'runbooks'), { recursive: true });
    writeFileSync(
      join(root, 'runbooks/bootstrap.md'),
      '1. agent: gbrain put_page wiki/example\n2. show user: "Pack installed."\n',
    );
  }
  return manifest;
}

let tmp: string;
let workspace: string;
let statePath: string;
let packDir: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'scaffold-tp-test-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshSandbox(): void {
  workspace = mkdtempSync(join(tmp, 'workspace-'));
  packDir = mkdtempSync(join(tmp, 'pack-'));
  statePath = join(tmp, `state-${Date.now()}-${Math.random()}.json`);
}

describe('runScaffoldThirdParty — happy path', () => {
  test('wrote_new on first scaffold of a fresh pack', async () => {
    freshSandbox();
    buildPackFixture(packDir);
    const resolved = resolveSource(packDir);

    const result = await runScaffoldThirdParty(
      {
        resolved,
        targetWorkspace: workspace,
        statePath,
        // Local sources skip trust prompt automatically.
      },
      '0.36.0',
    );

    expect(result.status).toBe('wrote_new');
    expect(result.copy?.summary.wroteNew).toBeGreaterThan(0);
    expect(result.trustDecision.reason).toBe('local_path_no_prompt');
    expect(existsSync(join(workspace, 'skills/sample-skill/SKILL.md'))).toBe(true);
  });

  test('records the pack in state.json after a successful scaffold', async () => {
    freshSandbox();
    buildPackFixture(packDir);
    const resolved = resolveSource(packDir);

    await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath },
      '0.36.0',
    );

    const state = loadState({ statePath });
    expect(state.packs).toHaveLength(1);
    expect(state.packs[0]?.name).toBe('sample-pack');
    expect(state.packs[0]?.source_kind).toBe('local');
    expect(state.packs[0]?.skill_slugs).toEqual(['skills/sample-skill']);
  });

  test('second scaffold of same pack lands all_skipped_existing (refuses to overwrite)', async () => {
    freshSandbox();
    buildPackFixture(packDir);
    const resolved = resolveSource(packDir);

    await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath },
      '0.36.0',
    );
    const second = await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath },
      '0.36.0',
    );

    expect(second.status).toBe('all_skipped_existing');
    expect(second.copy?.summary.wroteNew).toBe(0);
    expect(second.copy?.summary.skippedExisting).toBeGreaterThan(0);
  });

  test('dry_run does not write files or state', async () => {
    freshSandbox();
    buildPackFixture(packDir);
    const resolved = resolveSource(packDir);

    const result = await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath, dryRun: true },
      '0.36.0',
    );

    expect(result.status).toBe('dry_run');
    expect(existsSync(join(workspace, 'skills/sample-skill/SKILL.md'))).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  test('displays bootstrap.md when declared and present', async () => {
    freshSandbox();
    buildPackFixture(packDir, { withBootstrap: true });
    const resolved = resolveSource(packDir);

    const result = await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath },
      '0.36.0',
    );

    expect(result.bootstrap.shown).toBe(true);
    expect(result.bootstrap.text).toContain('BOOTSTRAP STEPS');
    expect(result.bootstrap.text).toContain('agent: gbrain put_page wiki/example');
  });
});

describe('runScaffoldThirdParty — gbrain version gate', () => {
  test('rejects when current version is below gbrain_min_version', async () => {
    freshSandbox();
    buildPackFixture(packDir, { manifestOverrides: { gbrain_min_version: '99.0.0' } });
    const resolved = resolveSource(packDir);

    try {
      await runScaffoldThirdParty(
        { resolved, targetWorkspace: workspace, statePath },
        '0.36.0',
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ScaffoldThirdPartyError);
      expect((err as ScaffoldThirdPartyError).code).toBe('gbrain_version_too_old');
    }
  });

  test('accepts exact-version match', async () => {
    freshSandbox();
    buildPackFixture(packDir, { manifestOverrides: { gbrain_min_version: '0.36.0' } });
    const resolved = resolveSource(packDir);

    const r = await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath },
      '0.36.0',
    );
    expect(r.status).toBe('wrote_new');
  });

  test('accepts current > min', async () => {
    freshSandbox();
    buildPackFixture(packDir, { manifestOverrides: { gbrain_min_version: '0.36.0' } });
    const resolved = resolveSource(packDir);

    const r = await runScaffoldThirdParty(
      { resolved, targetWorkspace: workspace, statePath },
      '0.37.0',
    );
    expect(r.status).toBe('wrote_new');
  });
});

describe('runScaffoldThirdParty — trust prompt gate', () => {
  test('aborted_no_trust when prompt is rejected', async () => {
    freshSandbox();
    buildPackFixture(packDir);
    const resolved = resolveSource(packDir);
    // Re-classify as if it came from a tarball so trust prompt fires.
    const fakeResolved = { ...resolved, kind: 'tarball' as const, tarball_sha256: 'fakesha' };

    const result = await runScaffoldThirdParty(
      {
        resolved: fakeResolved,
        targetWorkspace: workspace,
        statePath,
        isTTY: true,
        readLine: async () => 'n',
      },
      '0.36.0',
    );

    expect(result.status).toBe('aborted_no_trust');
    expect(result.trustDecision.reason).toBe('prompt_rejected');
    expect(existsSync(join(workspace, 'skills/sample-skill/SKILL.md'))).toBe(false);
  });

  test('--trust flag bypasses prompt', async () => {
    freshSandbox();
    buildPackFixture(packDir);
    const resolved = resolveSource(packDir);
    const fakeResolved = { ...resolved, kind: 'tarball' as const, tarball_sha256: 'fakesha' };

    const result = await runScaffoldThirdParty(
      {
        resolved: fakeResolved,
        targetWorkspace: workspace,
        statePath,
        trustFlag: true,
      },
      '0.36.0',
    );

    expect(result.status).toBe('wrote_new');
    expect(result.trustDecision.reason).toBe('trust_flag_bypassed');
  });
});

describe('runScaffoldThirdParty — manifest validation', () => {
  test('throws manifest_invalid for missing skillpack.json', async () => {
    freshSandbox();
    mkdirSync(packDir, { recursive: true });
    // Don't create skillpack.json; resolveSource will reject earlier.
    // Test the orchestrator's handling by calling it with a path that lacks the file.
    // We bypass resolveSource's check by constructing the ResolvedSource manually.
    try {
      await runScaffoldThirdParty(
        {
          resolved: {
            path: packDir,
            kind: 'local',
            source: packDir,
            pinned_commit: null,
            tarball_sha256: null,
            cache_hit: false,
          },
          targetWorkspace: workspace,
          statePath,
        },
        '0.36.0',
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScaffoldThirdPartyError).code).toBe('manifest_invalid');
    }
  });
});
