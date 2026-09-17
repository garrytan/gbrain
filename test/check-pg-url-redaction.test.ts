/**
 * scripts/check-pg-url-redaction.sh CI gate self-test (widened to every
 * db_url_credentials scheme, per TODOS.md: "the guard greps src/ for
 * postgres(ql)://…@ literals only; comments could still spell a
 * mysql/mongodb/redis URL with userinfo").
 *
 * Same positive/negative structure as test/check-system-of-record.test.ts:
 *   - Positive: the real repo's src/ tree must stay clean (exit 0).
 *   - Negative: a synthetic mini-repo with a credential-bearing URL of a
 *     newly-covered scheme (mysql / mongodb+srv) must trip the gate
 *     (exit 1, names the file) — this is the regression guard that would
 *     have failed before the widening (only postgres(ql):// tripped it).
 *   - The already-redacted `***@` form of a new scheme must still pass,
 *     confirming the widened pattern didn't turn into a blanket ban on
 *     the scheme name itself.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'check-pg-url-redaction.sh');

function runGate(scriptPath: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [scriptPath], { encoding: 'utf-8', timeout: 30_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-pg-url-redaction.sh — positive case (real repo)', () => {
  test('exits 0 on the current repo state', () => {
    const r = runGate(SCRIPT_PATH);
    expect(r.code).toBe(0);
  });
});

describe('check-pg-url-redaction.sh — negative case (newly-covered schemes)', () => {
  function withFakeRepo(fn: (fakeRepo: string, fakeScript: string) => void): void {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'pg-url-redaction-gate-test-'));
    try {
      const fakeScripts = join(fakeRepo, 'scripts');
      mkdirSync(fakeScripts, { recursive: true });
      const fakeScript = join(fakeScripts, 'check-pg-url-redaction.sh');
      cpSync(SCRIPT_PATH, fakeScript);
      mkdirSync(join(fakeRepo, 'src'), { recursive: true });
      fn(fakeRepo, fakeScript);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  }

  test('a bare mysql:// URL with userinfo trips the gate (pre-widening this scheme was invisible to it)', () => {
    withFakeRepo((fakeRepo, fakeScript) => {
      writeFileSync(
        join(fakeRepo, 'src', 'violator.ts'),
        "console.log('connecting: mysql://admin:hunter2@db.internal:3306/app');\n",
        'utf-8',
      );
      const r = runGate(fakeScript);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('violator.ts');
      expect(r.stdout).toContain('unredacted database URL');
    });
  });

  test('a bare mongodb+srv:// URL with userinfo also trips the gate', () => {
    withFakeRepo((fakeRepo, fakeScript) => {
      writeFileSync(
        join(fakeRepo, 'src', 'violator2.ts'),
        "console.error(`failed: mongodb+srv://svc:s3cr3t@cluster0.example.net/app`);\n",
        'utf-8',
      );
      const r = runGate(fakeScript);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('violator2.ts');
    });
  });

  test('an already-redacted `***@` mysql URL does NOT trip the gate', () => {
    withFakeRepo((fakeRepo, fakeScript) => {
      writeFileSync(
        join(fakeRepo, 'src', 'clean.ts'),
        "console.log('connecting: mysql://***@db.internal:3306/app');\n",
        'utf-8',
      );
      const r = runGate(fakeScript);
      expect(r.code).toBe(0);
    });
  });

  test('a bare postgresql:// URL still trips the gate (pre-existing coverage unaffected)', () => {
    withFakeRepo((fakeRepo, fakeScript) => {
      writeFileSync(
        join(fakeRepo, 'src', 'violator3.ts'),
        "console.log('connecting: postgresql://admin:hunter2@db.internal:5432/app');\n",
        'utf-8',
      );
      const r = runGate(fakeScript);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('violator3.ts');
    });
  });

  // The remaining three db_url_credentials schemes not covered by the
  // dedicated tests above — each gets its own fake source file so a single
  // failure names exactly which scheme's alternation broke.
  for (const scheme of ['redis', 'rediss', 'amqp', 'mssql']) {
    test(`a bare ${scheme}:// URL with userinfo trips the gate`, () => {
      withFakeRepo((fakeRepo, fakeScript) => {
        writeFileSync(
          join(fakeRepo, 'src', `violator-${scheme}.ts`),
          `console.log('connecting: ${scheme}://admin:hunter2@db.internal/app');\n`,
          'utf-8',
        );
        const r = runGate(fakeScript);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain(`violator-${scheme}.ts`);
      });
    });
  }
});
