/**
 * ci-path-guard — pure classifier tests.
 *
 * Regression suite for the 2026-09-08 shared-brain incident: a GitHub Actions
 * job running gbrain against a shared brain persisted its runner checkout
 * (/home/runner/work/brain/brain) into `sources.local_path`, breaking
 * `gbrain capture` (repo_not_found) on every other machine until the row was
 * repaired by hand. classifyEphemeralCiPath is the shared detector consumed by
 * sync's writeSyncAnchor and sources-ops addSource.
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
    const env = { GITHUB_WORKSPACE: '/srv/agent/_work/brain/brain' };
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
    const env = { GITHUB_WORKSPACE: '/srv/app' };
    expect(classifyEphemeralCiPath('/srv/app2', env).ephemeral).toBe(false);
  });

  test('CI_PROJECT_DIR (GitLab), BUILDKITE_BUILD_CHECKOUT_PATH, CIRCLE_WORKING_DIRECTORY', () => {
    expect(
      classifyEphemeralCiPath('/data/ci/proj/x', { CI_PROJECT_DIR: '/data/ci/proj' }).ephemeral,
    ).toBe(true);
    expect(
      classifyEphemeralCiPath('/bk/checkout', { BUILDKITE_BUILD_CHECKOUT_PATH: '/bk/checkout' }).ephemeral,
    ).toBe(true);
    expect(
      classifyEphemeralCiPath('/cci/wd/repo', { CIRCLE_WORKING_DIRECTORY: '/cci/wd' }).ephemeral,
    ).toBe(true);
  });

  test('degenerate workspace "/" never swallows every path', () => {
    expect(classifyEphemeralCiPath('/Users/alice/brain', { GITHUB_WORKSPACE: '/' }).ephemeral).toBe(false);
  });

  test('empty workspace var is ignored', () => {
    expect(classifyEphemeralCiPath('/Users/alice/brain', { GITHUB_WORKSPACE: '' }).ephemeral).toBe(false);
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

  test('allowEphemeralPersist reads GBRAIN_ALLOW_EPHEMERAL_REPO_PATH', () => {
    expect(allowEphemeralPersist(NO_ENV)).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '1' })).toBe(true);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'true' })).toBe(true);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '0' })).toBe(false);
    expect(allowEphemeralPersist({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: 'false' })).toBe(false);
  });
});
