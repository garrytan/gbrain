import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const moduleUrl = (name: string) => new URL(`../src/core/minions/${name}`, import.meta.url).href;

for (const entry of ['types.ts', 'handlers/subagent.ts', 'worker.ts']) {
  test(`cold ${entry} import preserves unrecoverable error identity`, () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-minion-import-'));
    try {
      // A fresh process is essential: a warm test module registry hides cycles.
      const script = `
        await import(${JSON.stringify(moduleUrl(entry))});
        const { UnrecoverableError } = await import(${JSON.stringify(moduleUrl('types.ts'))});
        const { DelegationDeniedError } = await import(${JSON.stringify(moduleUrl('delegated-policy.ts'))});
        const { encodeHandlerError, reconstructHandlerError } = await import(${JSON.stringify(moduleUrl('job-isolation.ts'))});
        const denied = new DelegationDeniedError(['fixture_denial']);
        const encoded = encodeHandlerError(denied);
        console.log(JSON.stringify({
          unrecoverable: denied instanceof UnrecoverableError,
          errorKind: encoded.errorKind,
          reconstructed: reconstructHandlerError(encoded) instanceof UnrecoverableError,
        }));
      `;
      const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
        cwd: home, env: keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }),
        stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({ unrecoverable: true, errorKind: 'unrecoverable', reconstructed: true });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
