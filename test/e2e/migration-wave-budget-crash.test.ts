import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrationWaveFixture } from '../helpers/migration-wave-fixture.ts';

for (const kind of ['pglite', 'postgres'] as const) {
  for (const requestKind of ['embedding', 'rerank']) {
    for (const boundary of ['before-reservation', 'after-debit', 'after-dispatch']) {
      test.skipIf(kind === 'postgres' && !process.env.DATABASE_URL)(`${kind} ${requestKind}: SIGKILL ${boundary} retains authorization across reopen`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'migration-wave-crash-'));
        const fixture = await migrationWaveFixture(kind);
        await fixture.engine.disconnect();
        const launch = (mode: string) => Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../helpers/migration-wave-budget-process.ts'), mode, kind, fixture.database, root, boundary, requestKind], {
          env: { ...process.env, HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'home'), DATABASE_URL: '', GBRAIN_DATABASE_URL: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdout: 'pipe', stderr: 'pipe',
        });
        try {
          const child = launch('crash');
          const errors = new Response(child.stderr).text();
          const reader = child.stdout.getReader();
          const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
          let output = '';
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              output += new TextDecoder().decode(next.value);
              if (output.includes('MIGRATION_WAVE_CRASH_BOUNDARY')) break;
            }
            child.kill('SIGKILL');
            expect(await child.exited, await errors).toBe(137);
            expect(child.signalCode).toBe('SIGKILL');
            expect(output).toContain('MIGRATION_WAVE_CRASH_BOUNDARY');
          } finally { clearTimeout(timer); child.kill(); await child.exited; }
          const recovery = launch('recover');
          const killRecovery = setTimeout(() => recovery.kill('SIGKILL'), 30_000);
          try {
            const [stdout, stderr, code] = await Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text(), recovery.exited]);
            expect(code, stderr).toBe(0);
            expect(stdout).toContain('MIGRATION_WAVE_BUDGET_RECOVERED');
            console.log(stdout.trim());
          } finally { clearTimeout(killRecovery); recovery.kill(); await recovery.exited; }
        } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
      }, 120_000);
    }
  }
}
