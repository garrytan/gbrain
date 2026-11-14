import { describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const ROOT = resolve(import.meta.dir, '../..');

describe('compiled cl100k portability (#9268)', () => {
  it('counts with the real encoder after every build input is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-tokenizer-'));
    try {
      const build = join(dir, 'build');
      mkdirSync(join(build, 'src/core/chunkers'), { recursive: true });
      // A private package copy, never the running checkout's node_modules.
      cpSync(join(ROOT, 'src/core/chunkers'), join(build, 'src/core/chunkers'), { recursive: true });
      cpSync(join(ROOT, 'src/core/cjk.ts'), join(build, 'src/core/cjk.ts'));
      const pkg = join(build, 'node_modules/@dqbd/tiktoken');
      mkdirSync(pkg, { recursive: true });
      cpSync(resolve(require.resolve('@dqbd/tiktoken'), '..'), pkg, { recursive: true });
      writeFileSync(join(build, 'probe.ts'), `
import { cl100kAvailable, estimateTokens, __testing } from './src/core/chunkers/token-estimate.ts';
const texts = [
  'The quick brown fox jumps over the lazy dog. '.repeat(40),
  'const x = foo?.bar ?? 42;\\n'.repeat(30),
  '日本語と한국어、emoji 🧠 café'.repeat(20),
  'literal <|endoftext|> and <|fim_prefix|>',
  '',
];
const counts = texts.map(estimateTokens);
__testing.setPieceCounting(false);
console.log(JSON.stringify({ available: cl100kAvailable(), counts, whole: texts.map(estimateTokens) }));
`);
      const env = keylessBrainEnv(process.env, dir, {
        DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
        GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1',
      });
      const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
      const source = run([process.execPath, join(build, 'probe.ts')]);
      expect(source.exitCode).toBe(0);
      const expected = JSON.parse(source.stdout.toString());
      expect(expected.available).toBe(true);
      expect(expected.counts[0]).toBe(401);
      expect(expected.counts).toEqual(expected.whole);
      // Node hosts cannot parse Bun's file-import attributes. Bundling the
      // ordinary source path for Node must leave the lazy Bun anchor unused.
      const nodeProbe = join(build, 'probe.cjs');
      const nodeBuild = run([process.execPath, 'build', '--target=node', '--format=cjs', '--external=@dqbd/tiktoken', '--outfile', nodeProbe, join(build, 'probe.ts')]);
      expect(nodeBuild.exitCode).toBe(0);
      const node = run(['node', nodeProbe]);
      expect(node.exitCode).toBe(0);
      expect(JSON.parse(node.stdout.toString())).toEqual(expected);
      const binary = join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      const compile = run([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--outfile', binary, join(build, 'probe.ts')]);
      expect(compile.exitCode).toBe(0);
      // A different cwd alone is insufficient: tiktoken remembers an absolute
      // build path. Removing it proves there is no disk WASM/rank fallback.
      rmSync(build, { recursive: true, force: true });
      const compiled = run([binary]);
      expect(compiled.exitCode).toBe(0);
      expect(JSON.parse(compiled.stdout.toString())).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
