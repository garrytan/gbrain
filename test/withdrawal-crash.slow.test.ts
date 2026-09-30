import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const backend of testBackends()) for (const boundary of ['after_mirror_file', 'before_mirror_commit']) {
  test(`${backend}: SIGKILL at ${boundary} recovers forward with exact unrelated state`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-crash-'));
    const files = join(root, 'files'); mkdirSync(files);
    const pg = backend === 'postgres' ? await isolatedPersistencePostgres(process.env.DATABASE_URL!) : null;
    const database = pg?.databaseUrl ?? join(root, 'pglite');
    if (pg) await pg.engine.disconnect();
    const launch = (mode: string) => Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/withdrawal-effect-process.ts'), mode, backend, files, database, boundary], {
      env: { ...process.env, GBRAIN_HOME: join(root, 'home'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const seed = launch('seed'); const seeded = await new Response(seed.stderr).text();
      expect(await seed.exited, seeded).toBe(0);
      const child = launch('crash'), reader = child.stdout.getReader();
      const errors = new Response(child.stderr).text();
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          output += new TextDecoder().decode(next.value);
          if (output.includes('AT_MIRROR_BOUNDARY')) break;
        }
        child.kill('SIGKILL');
        expect(await child.exited).toBe(137); expect(child.signalCode).toBe('SIGKILL');
        expect(output, await errors).toContain('AT_MIRROR_BOUNDARY');
      } finally { clearTimeout(timer); child.kill(); }
      const recovery = launch('recover');
      const recovered = await new Response(recovery.stdout).text(), stderr = await new Response(recovery.stderr).text();
      expect(await recovery.exited, stderr).toBe(0); expect(recovered).toContain('RECOVERED_EXACTLY');
    } finally { await pg?.close(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
}
