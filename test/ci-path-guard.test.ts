/**
 * ci-path-guard — pure classifier tests.
 *
 * Regression suite for the 2026-09-08 shared-brain incident: a GitHub Actions
 * job running gbrain against a shared brain persisted its runner checkout
 * (/home/runner/work/brain/brain) into `sources.local_path`, breaking
 * `gbrain capture` (repo_not_found) on every other machine until the row was
 * repaired by hand. classifyEphemeralCiPath is the shared detector; the
 * canonical consumer list lives in the `Consumers:` block of
 * src/core/ci-path-guard.ts (writeSyncAnchor, addSource, sources set-path,
 * runImport).
 *
 * Every case passes an explicit `env` object — the classifier must never be
 * tested through ambient process.env (this suite itself runs under CI=true on
 * GitHub Actions, where GITHUB_WORKSPACE is set for real).
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyEphemeralCiPath,
  isCiEnv,
  allowEphemeralPersist,
} from '../src/core/ci-path-guard.ts';

const NO_ENV: NodeJS.ProcessEnv = {};

describe('classifyEphemeralCiPath — unconditional runner prefixes', () => {
  test('the incident path: GitHub Actions Linux runner checkout', () => {
    const v = classifyEphemeralCiPath('/home/runner/work/brain/brain', NO_ENV);
    expect(v.ephemeral).toBe(true);
    expect(v.rule).toBe('ci_runner_path');
    expect(v.detail).toContain('GitHub Actions');
  });

  test('fires with NO env at all (replayed runner path outside CI)', () => {
    expect(classifyEphemeralCiPath('/home/runner/work/x/y', NO_ENV).ephemeral).toBe(true);
  });

  test('GitHub Actions macOS runner checkout', () => {
    expect(classifyEphemeralCiPath('/Users/runner/work/repo/repo', NO_ENV).ephemeral).toBe(true);
  });

  test('GitHub Actions container-job workspace mount', () => {
    expect(classifyEphemeralCiPath('/__w/repo/repo', NO_ENV).ephemeral).toBe(true);
  });

  test('CircleCI convenience-image checkout (exact and subtree)', () => {
    expect(classifyEphemeralCiPath('/home/circleci/project', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('/home/circleci/project/sub', NO_ENV).ephemeral).toBe(true);
  });

  test('Azure Pipelines hosted-agent workspace', () => {
    expect(classifyEphemeralCiPath('/home/vsts/work/1/s', NO_ENV).ephemeral).toBe(true);
  });

  test('Buildkite build directory', () => {
    expect(classifyEphemeralCiPath('/buildkite/builds/agent-1/org/repo', NO_ENV).ephemeral).toBe(true);
  });

  test('runner HOME outside the work dir is NOT flagged (e.g. $GBRAIN_HOME on a runner)', () => {
    expect(classifyEphemeralCiPath('/home/runner/.gbrain/clones/x', NO_ENV).ephemeral).toBe(false);
  });

  test('prefix match is path-segment-exact: /home/runner/workspace is NOT /home/runner/work/', () => {
    expect(classifyEphemeralCiPath('/home/runner/workspace/repo', NO_ENV).ephemeral).toBe(false);
  });

  test('GitHub Actions hosted Windows runner workspace (D:\\a\\...)', () => {
    // Win32-absolute spellings are recognized on any host: backslashes
    // normalize to forward slashes and the whole path is lowercased (NTFS
    // is case-insensitive), so a Windows-origin path in a shared brain
    // classifies from a Mac too.
    expect(classifyEphemeralCiPath('D:\\a\\repo\\repo', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('d:/a/repo/repo/sub', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('D:/A/repo', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('D:/awork/repo', NO_ENV).ephemeral).toBe(false);
  });

  test('win32 spellings cannot dodge the prefix with dot segments or doubled separators', () => {
    expect(classifyEphemeralCiPath('D:/foo/../a/repo/repo', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('D://a//repo', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('D:/./a/repo', NO_ENV).ephemeral).toBe(true);
  });

  test('non-canonical spellings are resolved before matching (.., trailing slash)', () => {
    // The header contract: comparison is lexical via path.resolve, so a
    // runner path spelled with traversal or a trailing slash cannot dodge
    // the prefix match.
    expect(classifyEphemeralCiPath('/tmp/../home/runner/work/brain/brain', NO_ENV).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('/home/runner/work/brain/brain/', NO_ENV).ephemeral).toBe(true);
    // And a workspace env var with a trailing slash still contains its tree.
    expect(
      classifyEphemeralCiPath('/srv/agent/_work/repo', { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: '/srv/agent/_work/' }).ephemeral,
    ).toBe(true);
  });
});

describe('classifyEphemeralCiPath — CI-corroborated prefixes', () => {
  test('/builds/ fires only when a CI env is present (GitLab default)', () => {
    expect(classifyEphemeralCiPath('/builds/group/proj', NO_ENV).ephemeral).toBe(false);
    expect(classifyEphemeralCiPath('/builds/group/proj', { GITLAB_CI: 'true' }).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('/builds/group/proj', { CI: 'true' }).ephemeral).toBe(true);
  });

  test('CI=false / CI=0 do not corroborate', () => {
    expect(classifyEphemeralCiPath('/builds/group/proj', { CI: 'false' }).ephemeral).toBe(false);
    expect(classifyEphemeralCiPath('/builds/group/proj', { CI: '0' }).ephemeral).toBe(false);
  });
});

describe('classifyEphemeralCiPath — workspace-env containment (self-hosted runners)', () => {
  test('path inside $GITHUB_WORKSPACE is ephemeral regardless of shape', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: '/srv/agent/_work/brain/brain' };
    const v = classifyEphemeralCiPath('/srv/agent/_work/brain/brain', env);
    expect(v.ephemeral).toBe(true);
    expect(v.rule).toBe('ci_workspace_env');
    expect(
      classifyEphemeralCiPath('/srv/agent/_work/brain/brain/notes', env).ephemeral,
    ).toBe(true);
  });

  test('path OUTSIDE the workspace stays allowed — durable brain on a self-hosted runner', () => {
    const env = { GITHUB_WORKSPACE: '/srv/agent/_work/brain/brain', CI: 'true' };
    expect(classifyEphemeralCiPath('/srv/durable-brain', env).ephemeral).toBe(false);
  });

  test('sibling-prefix paths are not contained (/srv/app vs /srv/app2)', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: '/srv/app' };
    expect(classifyEphemeralCiPath('/srv/app2', env).ephemeral).toBe(false);
  });

  test('Azure self-hosted agent via BUILD_SOURCESDIRECTORY / PIPELINE_WORKSPACE (codex P2 repro)', () => {
    // TF_BUILD corroborates but the containment must come from Azure's own
    // workspace vars — /agent/_work/1/s matches no static prefix.
    expect(
      classifyEphemeralCiPath('/agent/_work/1/s', {
        TF_BUILD: 'True', BUILD_SOURCESDIRECTORY: '/agent/_work/1/s', PIPELINE_WORKSPACE: '/agent/_work/1',
      }).ephemeral,
    ).toBe(true);
    expect(
      classifyEphemeralCiPath('/agent/_work/1/a/artifact', { TF_BUILD: 'True', PIPELINE_WORKSPACE: '/agent/_work/1' }).ephemeral,
    ).toBe(true);
    expect(
      classifyEphemeralCiPath('/srv/durable', { TF_BUILD: 'True', BUILD_SOURCESDIRECTORY: '/agent/_work/1/s' }).ephemeral,
    ).toBe(false);
  });

  test('CI_PROJECT_DIR (GitLab), BUILDKITE_BUILD_CHECKOUT_PATH, CIRCLE_WORKING_DIRECTORY', () => {
    expect(
      classifyEphemeralCiPath('/data/ci/proj/x', { GITLAB_CI: 'true', CI_PROJECT_DIR: '/data/ci/proj' }).ephemeral,
    ).toBe(true);
    expect(
      classifyEphemeralCiPath('/bk/checkout', { BUILDKITE: 'true', BUILDKITE_BUILD_CHECKOUT_PATH: '/bk/checkout' }).ephemeral,
    ).toBe(true);
    expect(
      classifyEphemeralCiPath('/cci/wd/repo', { CIRCLECI: 'true', CIRCLE_WORKING_DIRECTORY: '/cci/wd' }).ephemeral,
    ).toBe(true);
  });

  test('win32-shaped workspace var contains its backslash-spelled checkout', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: 'D:\\w\\brain\\brain' };
    expect(classifyEphemeralCiPath('D:\\w\\brain\\brain\\notes', env).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('D:/w/brain/brain', env).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath('D:/w/brain2', env).ephemeral).toBe(false);
  });

  test('literal ~ workspace value is expanded (CircleCI CIRCLE_WORKING_DIRECTORY convention)', async () => {
    const { homedir } = await import('os');
    const env = { CIRCLECI: 'true', CIRCLE_WORKING_DIRECTORY: '~/project' };
    expect(classifyEphemeralCiPath(`${homedir()}/project/repo`, env).ephemeral).toBe(true);
    expect(classifyEphemeralCiPath(`${homedir()}/elsewhere`, env).ephemeral).toBe(false);
    // Bare '~' expands to the home dir itself.
    expect(classifyEphemeralCiPath(`${homedir()}/x`, { CIRCLECI: 'true', CIRCLE_WORKING_DIRECTORY: '~' }).ephemeral).toBe(true);
  });

  test('symlink aliases of a live workspace cannot slip containment (realpath assist)', async () => {
    // macOS /var → /private/var is the everyday shape: the provider env
    // carries one spelling while a caller realpaths to the other. Build the
    // alias deterministically so the pin holds on every platform.
    const { mkdtempSync, symlinkSync, rmSync, realpathSync, mkdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const outer = mkdtempSync(join(tmpdir(), 'gbrain-alias-'));
    try {
      const real = join(outer, 'real-ws');
      mkdirSync(join(real, 'repo'), { recursive: true });
      const alias = join(outer, 'alias-ws');
      symlinkSync(real, alias);
      const realCanonical = realpathSync(real);
      // Candidate under the REAL spelling; workspace env carries the ALIAS.
      expect(
        classifyEphemeralCiPath(`${realCanonical}/repo`, { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: alias }).ephemeral,
      ).toBe(true);
      // Mirror direction: candidate spelled through the alias, env real.
      expect(
        classifyEphemeralCiPath(`${alias}/repo`, { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: realCanonical }).ephemeral,
      ).toBe(true);
      // Codex P2 repro: a NONEXISTENT child under the aliased workspace must
      // still classify — the realpath assist walks to the nearest existing
      // ancestor instead of discarding the symlinked parent's identity.
      expect(
        classifyEphemeralCiPath(`${alias}/does-not-exist-yet`, { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: realCanonical }).ephemeral,
      ).toBe(true);
      expect(
        classifyEphemeralCiPath(`${realCanonical}/also-missing/child`, { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: alias }).ephemeral,
      ).toBe(true);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test('a STALE workspace var with NO CI-presence env does not fire (dev-shell leak)', () => {
    // A leaked GITHUB_WORKSPACE (act, direnv, a sourced .env) on a normal
    // machine must not block durable-path persistence — every real CI
    // provider also sets its presence var, so requiring corroboration
    // costs zero recall.
    expect(
      classifyEphemeralCiPath('/srv/agent/_work/brain', { GITHUB_WORKSPACE: '/srv/agent/_work' }).ephemeral,
    ).toBe(false);
  });

  test('degenerate workspace "/" never swallows every path', () => {
    expect(classifyEphemeralCiPath('/Users/alice/brain', { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: '/' }).ephemeral).toBe(false);
  });

  test('degenerate drive-root workspace (D:/) never swallows a drive', () => {
    expect(classifyEphemeralCiPath('D:/some/brain', { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: 'D:/' }).ephemeral).toBe(false);
  });

  test('empty workspace var is ignored', () => {
    expect(classifyEphemeralCiPath('/Users/alice/brain', { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: '' }).ephemeral).toBe(false);
  });
});

describe('classifyEphemeralCiPath — negatives (must never flag)', () => {
  test('a normal user brain path, even under CI=true (bare CI is deliberately NOT a rule)', () => {
    expect(classifyEphemeralCiPath('/Users/alice/brain', { CI: 'true' }).ephemeral).toBe(false);
    expect(classifyEphemeralCiPath('/home/alice/brain', { CI: 'true' }).ephemeral).toBe(false);
  });

  test('tmpdir fixtures (what this test suite itself syncs in CI)', () => {
    expect(classifyEphemeralCiPath('/tmp/gbrain-sync-e2e-abc123', { CI: 'true' }).ephemeral).toBe(false);
    expect(
      classifyEphemeralCiPath('/var/folders/ab/xyz/T/gbrain-fixture', { CI: 'true' }).ephemeral,
    ).toBe(false);
  });
});

describe('isCiEnv / allowEphemeralPersist', () => {
  test('isCiEnv recognizes the major providers and rejects falsy values', () => {
    expect(isCiEnv(NO_ENV)).toBe(false);
    expect(isCiEnv({ CI: 'true' })).toBe(true);
    expect(isCiEnv({ CI: '1' })).toBe(true);
    expect(isCiEnv({ CI: 'false' })).toBe(false);
    expect(isCiEnv({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiEnv({ GITLAB_CI: 'true' })).toBe(true);
    expect(isCiEnv({ BUILDKITE: 'true' })).toBe(true);
    expect(isCiEnv({ CIRCLECI: 'true' })).toBe(true);
    expect(isCiEnv({ TF_BUILD: 'True' })).toBe(true);
  });

  test('whitespace-only env values are falsy (trim before truthiness)', () => {
    expect(isCiEnv({ CI: '   ' })).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '  ' })).toBe(false);
  });

  test('allowEphemeralPersist reads GBRAIN_ALLOW_EPHEMERAL_REPO_PATH (affirmative allowlist)', () => {
    expect(allowEphemeralPersist(NO_ENV)).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '1' })).toBe(true);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'true' })).toBe(true);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'yes' })).toBe(true);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'ON' })).toBe(true);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '0' })).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'false' })).toBe(false);
    // A hatch DISABLES a protection: negations spelled outside the falsy
    // list must not silently open the bypass (fail-open would defeat it).
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'no' })).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'off' })).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'disabled' })).toBe(false);
  });

  test('GUARD_ENV_VARS covers every env var the guard reads (test-neutralization contract)', async () => {
    const { GUARD_ENV_VARS } = await import('../src/core/ci-path-guard.ts');
    for (const name of [
      'GITHUB_WORKSPACE', 'CI_PROJECT_DIR', 'BUILDKITE_BUILD_CHECKOUT_PATH',
      'CIRCLE_WORKING_DIRECTORY', 'BUILD_SOURCESDIRECTORY', 'PIPELINE_WORKSPACE',
      'CI', 'GITHUB_ACTIONS', 'GITLAB_CI',
      'BUILDKITE', 'CIRCLECI', 'TF_BUILD', 'GBRAIN_ALLOW_EPHEMERAL_REPO_PATH',
    ]) {
      expect(GUARD_ENV_VARS).toContain(name);
    }
  });
});
