import { describe, expect, test } from 'bun:test';
import {
  entriesForService,
  envEntries,
  railwayVariableSetArgs,
  readArgs,
} from '../scripts/railway-apply-env.ts';

describe('Railway env applier args', () => {
  test('parses web and worker services', () => {
    expect(readArgs([
      '--env-file', '.env.acme',
      '--web-service', 'acme-web',
      '--worker-service', 'acme-worker',
      '--environment', 'production',
      '--manifest', 'deploy/saas/acme.yml',
      '--project', 'proj_123',
      '--strict-preflight',
      '--dry-run',
    ])).toEqual({
      envFile: '.env.acme',
      services: [
        { name: 'acme-web', role: 'web' },
        { name: 'acme-worker', role: 'worker' },
      ],
      environment: 'production',
      manifestPath: 'deploy/saas/acme.yml',
      project: 'proj_123',
      dryRun: true,
      skipPreflight: false,
      strictPreflight: true,
      help: false,
    });
  });

  test('rejects missing values', () => {
    expect(() => readArgs(['--env-file'])).toThrow(/requires a value/);
    expect(() => readArgs(['--service'])).toThrow(/requires a value/);
    expect(() => readArgs(['--web-service'])).toThrow(/requires a value/);
    expect(() => readArgs(['--worker-service'])).toThrow(/requires a value/);
    expect(() => readArgs(['--manifest'])).toThrow(/requires a value/);
  });

  test('keeps generic service mode for linked one-service deployments', () => {
    expect(readArgs([
      '--env-file', '.env.saas',
      '--service', 'cortex-web',
      '--skip-preflight',
    ])).toMatchObject({
      services: [{ name: 'cortex-web' }],
      skipPreflight: true,
      strictPreflight: false,
    });
  });
});

describe('Railway env applier commands', () => {
  test('skips blank variables and sorts keys', () => {
    expect(envEntries({
      CORTEX_PUBLIC_URL: 'https://brain.acme.test',
      EMPTY: '',
      DATABASE_URL: 'postgresql://example',
    })).toEqual([
      { key: 'CORTEX_PUBLIC_URL', value: 'https://brain.acme.test' },
      { key: 'DATABASE_URL', value: 'postgresql://example' },
    ]);
  });

  test('adds safe role overrides for web and worker services', () => {
    const base = [{ key: 'CORTEX_DATABASE_URL', value: 'postgresql://example' }];
    expect(entriesForService(base, { name: 'acme-web', role: 'web' })).toEqual([
      { key: 'CORTEX_DATABASE_URL', value: 'postgresql://example' },
      { key: 'CORTEX_PROCESS', value: 'web' },
    ]);
    expect(entriesForService(base, { name: 'acme-worker', role: 'worker' })).toEqual([
      { key: 'CORTEX_DATABASE_URL', value: 'postgresql://example' },
      { key: 'CORTEX_PROCESS', value: 'worker' },
      { key: 'CORTEX_WORKER_RUN_SCHEMA_MIGRATIONS', value: '0' },
    ]);
  });

  test('renders railway variable set args', () => {
    expect(railwayVariableSetArgs(
      'acme-web',
      [{ key: 'DATABASE_URL', value: 'postgresql://example' }],
      { environment: 'production', project: 'proj_123' },
    )).toEqual([
      'variable',
      'set',
      '--service',
      'acme-web',
      '--environment',
      'production',
      '--skip-deploys',
      '--project',
      'proj_123',
      'DATABASE_URL=postgresql://example',
    ]);
  });
});
