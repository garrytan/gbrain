import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadEnvFile,
  readArgs,
  runPreflight,
  type PreflightIssue,
} from '../scripts/saas-preflight.ts';
import { validate, type CompanyBrainManifest } from '../scripts/provision-company-brain.ts';

const validEnv = {
  CORTEX_DATABASE_URL: 'postgresql://postgres.projref:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  CORTEX_PUBLIC_URL: 'https://brain.acme.test',
  CORTEX_HTTP_CORS_ORIGIN: 'https://brain.acme.test',
  CORTEX_HTTP_TRUST_PROXY: '1',
  CORTEX_HOME: '/data/cortex',
  CORTEX_POOL_SIZE: '2',
  CORTEX_DISABLE_DIRECT_POOL: '1',
  CORTEX_ADMIN_BOOTSTRAP_TOKEN: '0123456789abcdef0123456789abcdef',
  CORTEX_SUPPRESS_BOOTSTRAP_TOKEN: '1',
  ZEROENTROPY_API_KEY: 'ze-test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

const validManifest: CompanyBrainManifest = {
  sources: [
    { id: 'shared', url: 'https://github.com/acme/shared.git' },
    { id: 'customers', url: 'https://github.com/acme/customers.git' },
  ],
  clients: [
    {
      name: 'alice',
      source: 'customers',
      federated_read: ['customers', 'shared'],
      scopes: ['read', 'write'],
    },
  ],
};

function codes(issues: PreflightIssue[]) {
  return issues.map((issue) => issue.code);
}

describe('SaaS preflight args and env parsing', () => {
  test('parses flags', () => {
    expect(readArgs(['--env-file', '.env.saas', '--manifest', 'tenant.yml', '--json', '--strict'])).toEqual({
      envFile: '.env.saas',
      manifestPath: 'tenant.yml',
      json: true,
      strict: true,
      help: false,
    });
  });

  test('loads simple dotenv files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-saas-preflight-'));
    try {
      const path = join(dir, '.env');
      await Bun.write(path, [
        '# comment',
        'export DATABASE_URL="postgresql://user:pass@host:5432/postgres"',
        "CORTEX_PUBLIC_URL='https://brain.acme.test'",
        'CORTEX_POOL_SIZE=2',
      ].join('\n'));
      await expect(loadEnvFile(path)).resolves.toEqual({
        DATABASE_URL: 'postgresql://user:pass@host:5432/postgres',
        CORTEX_PUBLIC_URL: 'https://brain.acme.test',
        CORTEX_POOL_SIZE: '2',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SaaS preflight checks', () => {
  test('accepts a Supabase session-pooler tenant shape', () => {
    const issues = runPreflight({ env: validEnv, manifest: validManifest });
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });

  test('requires prepared statements to be disabled for Supabase transaction pooler', () => {
    const env = {
      ...validEnv,
      CORTEX_DATABASE_URL: 'postgresql://postgres.projref:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    };
    expect(codes(runPreflight({ env, manifest: validManifest })))
      .toContain('supabase_transaction_prepare_missing');

    expect(codes(runPreflight({
      env: { ...env, CORTEX_DATABASE_URL: `${env.CORTEX_DATABASE_URL}?prepare=false` },
      manifest: validManifest,
    }))).not.toContain('supabase_transaction_prepare_missing');
  });

  test('warns when Supabase pooler direct DDL may need an IPv6-capable host', () => {
    const env = { ...validEnv };
    delete (env as Partial<typeof validEnv>).CORTEX_DISABLE_DIRECT_POOL;
    expect(codes(runPreflight({ env, manifest: validManifest })))
      .toContain('supabase_direct_pool_may_need_ipv6');
  });

  test('rejects hosted security footguns', () => {
    const issues = runPreflight({
      env: {
        ...validEnv,
        CORTEX_ALLOW_SHELL_JOBS: '1',
        CORTEX_PUBLIC_URL: 'http://brain.acme.test',
      },
      manifest: validManifest,
    });
    expect(codes(issues)).toContain('shell_jobs_enabled');
    expect(codes(issues)).toContain('public_url_https');
  });

  test('accepts Railway public domain as the hosted origin fallback', () => {
    const env = {
      ...validEnv,
      CORTEX_PUBLIC_URL: '',
      CORTEX_HTTP_CORS_ORIGIN: '',
      RAILWAY_PUBLIC_DOMAIN: 'cortex-demo.up.railway.app',
    };
    const issueCodes = codes(runPreflight({ env, manifest: validManifest }));
    expect(issueCodes).not.toContain('public_url_missing');
    expect(issueCodes).not.toContain('cors_origin_missing');
  });

  test('requires Resend settings when invite email delivery is enabled', () => {
    const missing = runPreflight({
      env: {
        ...validEnv,
        CORTEX_EMAIL_PROVIDER: 'resend',
      },
      manifest: validManifest,
    });
    expect(codes(missing)).toContain('resend_api_key_missing');
    expect(codes(missing)).toContain('email_from_missing');

    const configured = runPreflight({
      env: {
        ...validEnv,
        CORTEX_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test',
        CORTEX_EMAIL_FROM: 'Cortex <onboarding@example.com>',
        CORTEX_EMAIL_DELIVERY_SECRET: 'email-worker-secret',
      },
      manifest: validManifest,
    });
    expect(codes(configured)).not.toContain('resend_api_key_missing');
    expect(codes(configured)).not.toContain('email_from_missing');
    expect(codes(configured)).not.toContain('email_delivery_secret_missing');
  });

  test('flags missing tenant manifest', () => {
    expect(codes(runPreflight({ env: validEnv }))).toContain('manifest_missing');
  });
});

describe('company brain manifest validation hardening', () => {
  test('rejects duplicate sources and clients', () => {
    expect(() => validate({
      sources: [
        { id: 'shared', url: 'https://github.com/acme/shared.git' },
        { id: 'shared', url: 'https://github.com/acme/shared-2.git' },
      ],
    })).toThrow(/duplicate source/);

    expect(() => validate({
      sources: [{ id: 'shared', url: 'https://github.com/acme/shared.git' }],
      clients: [
        { name: 'alice', source: 'shared' },
        { name: 'alice', source: 'shared' },
      ],
    })).toThrow(/duplicate client/);
  });
});
