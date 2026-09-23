import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

for (const [name, expected] of [['computeManifestSha8', '9ae9e2aa'], ['computeAliasClosureHash', '44136fa355b3678a']] as const) {
  test(`${name} settles after the last referenced callback with its existing fingerprint`, () => {
    const script = `
      import { parseSchemaPackManifest, computeManifestSha8 } from ${JSON.stringify(resolve(import.meta.dir, '../src/core/schema-pack/manifest-v1.ts'))};
      import { computeAliasClosureHash } from ${JSON.stringify(resolve(import.meta.dir, '../src/core/schema-pack/closure.ts'))};
      async function main() {
        const manifest = parseSchemaPackManifest({ api_version: 'gbrain-schema-pack-v1', name: 'synthetic-empty', version: '1.0.0', extends: null });
        await new Promise(resolve => setImmediate(resolve));
        const hash = ${name}(manifest);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        console.log(await hash);
      }
      main().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = Bun.spawnSync([process.execPath, '--eval', script], {
        cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 10_000,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe(expected);
    }
  }, 40_000);
}
