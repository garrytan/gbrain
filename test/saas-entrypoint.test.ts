import { describe, expect, test } from 'bun:test';

const entrypoint = 'deploy/saas/entrypoint.sh';

function hostedEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    CORTEX_BIN: 'echo',
    CORTEX_DATABASE_URL: '',
    GBRAIN_DATABASE_URL: '',
    DATABASE_URL: '',
    CORTEX_PUBLIC_URL: '',
    GBRAIN_PUBLIC_URL: '',
    PUBLIC_URL: '',
    RAILWAY_PUBLIC_DOMAIN: '',
    CORTEX_HTTP_CORS_ORIGIN: '',
    GBRAIN_HTTP_CORS_ORIGIN: '',
    CORTEX_ADMIN_BOOTSTRAP_TOKEN: '',
    GBRAIN_ADMIN_BOOTSTRAP_TOKEN: '',
    CORTEX_ALLOW_SHELL_JOBS: '',
    GBRAIN_ALLOW_SHELL_JOBS: '',
    CORTEX_RUN_FULL_MIGRATIONS_ON_START: '0',
    GBRAIN_RUN_FULL_MIGRATIONS_ON_START: '0',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function runEntrypoint(env: Record<string, string>) {
  const assignments = Object.entries(env)
    .filter(([key]) => key.startsWith('CORTEX_') || key.startsWith('GBRAIN_') || key === 'DATABASE_URL' || key === 'PUBLIC_URL' || key === 'RAILWAY_PUBLIC_DOMAIN' || key === 'PORT')
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const proc = Bun.spawn(['bash', '-lc', `${assignments} sh ${entrypoint} web`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe('hosted SaaS entrypoint guardrails', () => {
  test('refuses to boot a web service without a durable database URL', async () => {
    const result = await runEntrypoint(hostedEnv({
      CORTEX_PUBLIC_URL: 'https://cortex.example.test',
      CORTEX_ADMIN_BOOTSTRAP_TOKEN: 'a'.repeat(32),
    }));

    expect(result.code).toBe(64);
    expect(result.stderr).toContain('DATABASE_URL or CORTEX_DATABASE_URL is required');
    expect(result.stdout).toBe('');
  });

  test('refuses to boot without a hosted public URL', async () => {
    const result = await runEntrypoint(hostedEnv({
      CORTEX_DATABASE_URL: 'postgresql://postgres:secret@db.example.test:5432/postgres',
      CORTEX_ADMIN_BOOTSTRAP_TOKEN: 'a'.repeat(32),
    }));

    expect(result.code).toBe(64);
    expect(result.stderr).toContain('CORTEX_PUBLIC_URL is required');
    expect(result.stdout).toBe('');
  });

  test('derives the public URL from Railway and suppresses bootstrap token logging', async () => {
    const result = await runEntrypoint(hostedEnv({
      CORTEX_DATABASE_URL: 'postgresql://postgres:secret@db.example.test:5432/postgres',
      CORTEX_ADMIN_BOOTSTRAP_TOKEN: 'a'.repeat(32),
      RAILWAY_PUBLIC_DOMAIN: 'cortex-demo.up.railway.app',
    }));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('init --migrate-only --json');
    expect(result.stdout).toContain('serve --http');
    expect(result.stdout).toContain('--public-url https://cortex-demo.up.railway.app');
    expect(result.stdout).toContain('--suppress-bootstrap-token');
  });

  test('refuses hosted shell-job execution', async () => {
    const result = await runEntrypoint(hostedEnv({
      CORTEX_DATABASE_URL: 'postgresql://postgres:secret@db.example.test:5432/postgres',
      CORTEX_PUBLIC_URL: 'https://cortex.example.test',
      CORTEX_ADMIN_BOOTSTRAP_TOKEN: 'a'.repeat(32),
      CORTEX_ALLOW_SHELL_JOBS: '1',
    }));

    expect(result.code).toBe(64);
    expect(result.stderr).toContain('CORTEX_ALLOW_SHELL_JOBS must stay disabled');
    expect(result.stdout).toBe('');
  });
});
