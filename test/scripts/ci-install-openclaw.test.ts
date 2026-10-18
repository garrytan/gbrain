/**
 * scripts/ci-install-openclaw.sh: the Tier 2 OpenClaw install retries a registry race
 * (ETARGET/E404, a dependency version published but not yet visible) on its own longer
 * back-off, keeps the short generic retries for everything else, and stays bounded.
 *
 * A loopback registry serves one tiny package; the script installs it into a throwaway
 * npm prefix with every pause set to zero.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUB_PACKAGE, STUB_VERSION, type StubRegistryOptions, startStubRegistry, stubNpmEnv } from '../helpers/npm-stub-registry.ts';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'ci-install-openclaw.sh');
// The script is an npm install; GitHub's runner images carry npm, a stock Ubicloud CI VM (nodejs without npm) does not.
const NPM = Bun.which('npm');
if (!NPM) console.warn('[ci-install-openclaw] skipped: npm is not on PATH, so the installer script cannot run here');

describe.skipIf(!NPM)('scripts/ci-install-openclaw.sh', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  async function run(options: Omit<StubRegistryOptions, 'dir'>) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-install-'));
    const registry = await startStubRegistry({ dir, ...options });
    cleanups.push(() => { registry.stop(); rmSync(dir, { recursive: true, force: true }); });
    const proc = Bun.spawn(['bash', SCRIPT], { stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, ...stubNpmEnv(registry.url, dir),
      OPENCLAW_SPEC: `${STUB_PACKAGE}@${STUB_VERSION}`, OPENCLAW_INSTALL_RETRY_SLEEP_S: '0', OPENCLAW_INSTALL_RACE_SLEEPS_S: '0 0 0',
    } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const warnings = stderr.split('\n').filter(line => line.startsWith('::warning::') || line.startsWith('::error::'));
    return { exitCode, stdout, warnings, requests: registry.requests(), installed: existsSync(join(dir, 'prefix', 'bin', STUB_PACKAGE)) };
  }

  test.each([['ETARGET'], ['E404']] as const)('a %s race on the first three attempts is waited out and the fourth installs', async (kind) => {
    const result = await run({ race: { kind, times: 3 } });
    expect(result).toMatchObject({ exitCode: 0, installed: true });
    expect(result.warnings).toHaveLength(3);
    for (const warning of result.warnings) expect(warning).toMatch(/^::warning::openclaw install attempt \d hit a registry race/);
    expect(result.requests.packument).toBeGreaterThanOrEqual(4);
    expect(result.requests.tarball).toBe(1);
  }, 120_000);

  test('a race that never resolves stops after four attempts with its own error', async () => {
    const result = await run({ race: { kind: 'ETARGET', times: Number.MAX_SAFE_INTEGER } });
    expect(result).toMatchObject({ exitCode: 1, installed: false });
    expect(result.warnings.filter(line => line.includes('hit a registry race'))).toHaveLength(3);
    expect(result.warnings.at(-1)).toMatch(/^::error::openclaw install: the registry still does not serve .* after 4 attempts \(ETARGET\/E404\)/);
    expect(result.requests.tarball).toBe(0);
  }, 120_000);

  test('a failure that is not a registry race keeps the three generic attempts', async () => {
    const result = await run({ platform: 'unsupported' });
    expect(result).toMatchObject({ exitCode: 1, installed: false });
    expect(result.stdout).toContain('EBADPLATFORM');
    expect(result.warnings).toEqual([
      '::warning::openclaw install attempt 1 failed or timed out; retrying in 0s',
      '::warning::openclaw install attempt 2 failed or timed out; retrying in 0s',
      '::error::openclaw install failed after 3 attempts',
    ]);
  }, 120_000);
});
