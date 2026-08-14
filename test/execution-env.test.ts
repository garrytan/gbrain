/**
 * execution-env.ts — detection matrices for the third bootstrap axis.
 * Pure signal-injected tests: nothing here reads the real process.env or
 * the real filesystem, so results are identical on any CI host.
 */
import { describe, expect, test } from 'bun:test';

import {
  detectExecutionEnvironment,
  isCredentialInjectingProxy,
  binaryOnPath,
} from '../src/core/execution-env.ts';

const noFile = () => false;

describe('isCredentialInjectingProxy', () => {
  test('GH_TOKEN placeholder literal → true', () => {
    expect(isCredentialInjectingProxy({ GH_TOKEN: 'proxy-injected' })).toBe(true);
  });

  test('GITHUB_TOKEN placeholder literal → true', () => {
    expect(isCredentialInjectingProxy({ GITHUB_TOKEN: 'proxy-injected' })).toBe(true);
  });

  test('anthropic-egress JWT in https_proxy (either casing) → true', () => {
    expect(
      isCredentialInjectingProxy({ https_proxy: 'http://user:eyJx.anthropic-egress-control@proxy:8080' }),
    ).toBe(true);
    expect(
      isCredentialInjectingProxy({ HTTPS_PROXY: 'http://x.ANTHROPIC-EGRESS.y@proxy:8080' }),
    ).toBe(true);
  });

  test('a real user token / ordinary proxy → false', () => {
    expect(isCredentialInjectingProxy({ GH_TOKEN: 'ghp_realtoken123' })).toBe(false);
    expect(isCredentialInjectingProxy({ https_proxy: 'http://corp-proxy:3128' })).toBe(false);
    expect(isCredentialInjectingProxy({})).toBe(false);
  });
});

describe('detectExecutionEnvironment', () => {
  test('plain env, no container markers → local', () => {
    expect(detectExecutionEnvironment({ env: {}, fileExists: noFile })).toBe('local');
  });

  test('CLAUDE_CODE_REMOTE=true → cloud-sandbox (primary official signal)', () => {
    expect(
      detectExecutionEnvironment({ env: { CLAUDE_CODE_REMOTE: 'true' }, fileExists: noFile }),
    ).toBe('cloud-sandbox');
  });

  test('CLAUDE_CODE_REMOTE with a non-true value is NOT the cloud signal', () => {
    expect(
      detectExecutionEnvironment({ env: { CLAUDE_CODE_REMOTE: '1' }, fileExists: noFile }),
    ).toBe('local');
  });

  test('cse_-prefixed remote session id → cloud-sandbox', () => {
    expect(
      detectExecutionEnvironment({
        env: { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_abc123' },
        fileExists: noFile,
      }),
    ).toBe('cloud-sandbox');
  });

  test('proxy-injected token signature → cloud-sandbox', () => {
    expect(
      detectExecutionEnvironment({ env: { GH_TOKEN: 'proxy-injected' }, fileExists: noFile }),
    ).toBe('cloud-sandbox');
  });

  test.each([
    ['RENDER', { RENDER: 'true' }],
    ['RAILWAY_ENVIRONMENT', { RAILWAY_ENVIRONMENT: 'production' }],
    ['FLY_APP_NAME', { FLY_APP_NAME: 'my-app' }],
  ] as const)('%s env → ephemeral-container', (_name, env) => {
    expect(detectExecutionEnvironment({ env, fileExists: noFile })).toBe('ephemeral-container');
  });

  test('/.dockerenv marker → ephemeral-container', () => {
    expect(
      detectExecutionEnvironment({ env: {}, fileExists: (p) => p === '/.dockerenv' }),
    ).toBe('ephemeral-container');
  });

  test('cloud signals win over container signals (a sandbox is also a container)', () => {
    expect(
      detectExecutionEnvironment({
        env: { CLAUDE_CODE_REMOTE: 'true', RENDER: 'true' },
        fileExists: (p) => p === '/.dockerenv',
      }),
    ).toBe('cloud-sandbox');
  });
});

describe('binaryOnPath', () => {
  test('a binary every host has resolves; a nonsense name does not', () => {
    expect(binaryOnPath('sh')).toBe(true);
    expect(binaryOnPath('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});
