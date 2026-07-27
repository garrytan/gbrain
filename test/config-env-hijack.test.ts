import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { dotenvValuesForKey, effectiveEnvDatabaseUrl } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

// #427 — Bun auto-loads `.env` from the process cwd, so running gbrain inside
// any web-app checkout whose `.env` defines DATABASE_URL silently retargets
// the brain at that app's database. These tests pin the guard:
// effectiveEnvDatabaseUrl() must treat a DATABASE_URL whose value matches a
// cwd .env assignment as file-origin (ignored), while still honoring
// GBRAIN_DATABASE_URL and genuinely exported DATABASE_URLs.
//
// The dir is injected instead of process.chdir'd so these tests stay safe in
// the parallel shard runner (cwd is process-global, same reason with-env.ts
// exists for process.env).

function tmpProject(envFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-env-hijack-'));
  for (const [name, content] of Object.entries(envFiles)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('dotenvValuesForKey', () => {
  test('collects assignments across all auto-loaded .env variants', () => {
    const dir = tmpProject({
      '.env': 'DATABASE_URL=postgres://app:pw@prod.example.test:5432/app\n',
      '.env.local': "DATABASE_URL='postgres://app:pw@local.example.test:5432/app'\n",
    });
    try {
      const values = dotenvValuesForKey('DATABASE_URL', dir);
      expect(values.has('postgres://app:pw@prod.example.test:5432/app')).toBe(true);
      expect(values.has('postgres://app:pw@local.example.test:5432/app')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handles export prefix, double quotes, comments, and unrelated keys', () => {
    const dir = tmpProject({
      '.env': [
        '# comment line',
        'export DATABASE_URL="postgres://quoted.example.test/db"',
        'OTHER_KEY=not-a-db-url',
        'EMPTY=',
        '',
      ].join('\n'),
    });
    try {
      const values = dotenvValuesForKey('DATABASE_URL', dir);
      expect(values.has('postgres://quoted.example.test/db')).toBe(true);
      expect(values.size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns empty set when no .env files exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-env-hijack-none-'));
    try {
      expect(dotenvValuesForKey('DATABASE_URL', dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('effectiveEnvDatabaseUrl (#427 guard)', () => {
  const HIJACK_URL = 'postgres://app:pw@victim-prod.example.test:5432/app';
  const OPERATOR_URL = 'postgres://operator@deliberate.example.test:5432/brain';

  test('ignores DATABASE_URL whose value matches a cwd .env assignment', async () => {
    const dir = tmpProject({ '.env': `DATABASE_URL=${HIJACK_URL}\n` });
    try {
      await withEnv(
        { GBRAIN_DATABASE_URL: undefined, DATABASE_URL: HIJACK_URL },
        () => {
          expect(effectiveEnvDatabaseUrl(dir)).toBeUndefined();
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('honors an exported DATABASE_URL that differs from the cwd .env', async () => {
    const dir = tmpProject({ '.env': `DATABASE_URL=${HIJACK_URL}\n` });
    try {
      await withEnv(
        { GBRAIN_DATABASE_URL: undefined, DATABASE_URL: OPERATOR_URL },
        () => {
          expect(effectiveEnvDatabaseUrl(dir)).toBe(OPERATOR_URL);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GBRAIN_DATABASE_URL is never ignored, even when it matches the cwd .env', async () => {
    const dir = tmpProject({ '.env': `GBRAIN_DATABASE_URL=${OPERATOR_URL}\nDATABASE_URL=${HIJACK_URL}\n` });
    try {
      await withEnv(
        { GBRAIN_DATABASE_URL: OPERATOR_URL, DATABASE_URL: HIJACK_URL },
        () => {
          expect(effectiveEnvDatabaseUrl(dir)).toBe(OPERATOR_URL);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('honors DATABASE_URL when no .env files exist in cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-env-hijack-clean-'));
    try {
      await withEnv(
        { GBRAIN_DATABASE_URL: undefined, DATABASE_URL: OPERATOR_URL },
        () => {
          expect(effectiveEnvDatabaseUrl(dir)).toBe(OPERATOR_URL);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns undefined when neither env var is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-env-hijack-unset-'));
    try {
      await withEnv(
        { GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
        () => {
          expect(effectiveEnvDatabaseUrl(dir)).toBeUndefined();
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
