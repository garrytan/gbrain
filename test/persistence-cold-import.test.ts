import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const moduleUrl = (entry: string) => new URL(`../src/core/${entry}`, import.meta.url).href;

for (const entry of ['persistence/params.ts', 'persistence/purge-params.ts', 'ops/contract.ts', 'ops/facts.ts', 'verbs.ts']) {
  test(`cold ${entry} import preserves mutation schemas and purge errors`, () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-persistence-import-'));
    try {
      // Each entry must work without a previously initialized operation registry.
      const script = `
        await import(${JSON.stringify(moduleUrl(entry))});
        const { PAGE_MUTATION_PARAMS } = await import(${JSON.stringify(moduleUrl('persistence/params.ts'))});
        const { assertPurgeParams } = await import(${JSON.stringify(moduleUrl('persistence/purge-params.ts'))});
        const { OperationError } = await import(${JSON.stringify(moduleUrl('ops/contract.ts'))});
        const { verbOperations } = await import(${JSON.stringify(moduleUrl('verbs.ts'))});
        assertPurgeParams({ purge: true }, false);
        const failures = [];
        for (const [params, remote] of [[{ purge: 'true' }, false], [{ purge: true }, true], [{ purge: true }, undefined]]) {
          try { assertPurgeParams(params, remote); failures.push(null); }
          catch (error) { failures.push({ typed: error instanceof OperationError, code: error.code }); }
        }
        console.log(JSON.stringify({
          requestType: PAGE_MUTATION_PARAMS.request_id.type,
          sharedRevision: verbOperations.find(op => op.name === 'remember').params.expected_revision === PAGE_MUTATION_PARAMS.expected_revision,
          failures,
        }));
      `;
      const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
        cwd: home,
        env: keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }),
        stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({
        requestType: 'string', sharedRevision: true,
        failures: [
          { typed: true, code: 'invalid_params' },
          { typed: true, code: 'permission_denied' },
          { typed: true, code: 'permission_denied' },
        ],
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
