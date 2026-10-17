import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCli } from '../src/core/ai/recipes/codex-cli.ts';
import { CodexCliLanguageModel, CodexCliProcessError } from '../src/core/ai/providers/codex-cli-language-model.ts';

const dirs: string[] = [];
afterEach(async () => {
  delete process.env.GBRAIN_CODEX_CLI_BIN;
  delete process.env.CODEX_FAKE_MODE;
  delete process.env.CODEX_FAKE_CAPTURE;
  delete process.env.CODEX_FAKE_LOCK;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fakeCodex(): Promise<{ bin: string; capture: string; lock: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gbrain-codex-cli-test-')); dirs.push(dir);
  const bin = join(dir, 'codex'); const capture = join(dir, 'capture.json'); const lock = join(dir, 'lock');
  await writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'); const args=process.argv.slice(2); let input='';
process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{
  const mode=process.env.CODEX_FAKE_MODE||'ok';
  if(mode==='auth'){console.error('401 unauthorized: not logged in');process.exit(1)}
  if(mode==='quota'){console.error('429 usage limit reached: quota exhausted');process.exit(1)}
  const lock=process.env.CODEX_FAKE_LOCK;
  if(fs.existsSync(lock)){console.error('concurrency violation');process.exit(9)}
  fs.writeFileSync(lock,'1');
  const capture=process.env.CODEX_FAKE_CAPTURE;
  fs.writeFileSync(capture,JSON.stringify({args,input}));
  const output=args[args.indexOf('--output-last-message')+1];
  setTimeout(()=>{fs.writeFileSync(output,JSON.stringify({text:'structured ok'}));fs.rmSync(lock,{force:true});process.exit(0)},40);
});`);
  await chmod(bin, 0o755);
  process.env.GBRAIN_CODEX_CLI_BIN = bin; process.env.CODEX_FAKE_CAPTURE = capture; process.env.CODEX_FAKE_LOCK = lock;
  return { bin, capture, lock };
}

function call(model = 'codex-cli:gpt-6-luna') {
  return new CodexCliLanguageModel(model).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] } as any);
}

describe('codex-cli subscription provider', () => {
  test('recipe is subscription-backed and has no key requirement', () => {
    expect(codexCli.billing).toBe('subscription');
    expect(codexCli.auth_env?.required).toEqual([]);
    expect(codexCli.touchpoints.chat?.supports_tools).toBe(false);
  });

  test('uses non-interactive structured output and returns its text', async () => {
    const { capture } = await fakeCodex();
    const result = await call();
    expect(result.content).toEqual([{ type: 'text', text: 'structured ok' }]);
    const seen = JSON.parse(await readFile(capture, 'utf8'));
    expect(seen.args.slice(0, 2)).toEqual(['exec', '--ephemeral']);
    expect(seen.args).toContain('--output-schema');
    expect(seen.args).toContain('--output-last-message');
    expect(seen.args).toContain('gpt-6-luna');
    expect(seen.args.at(-1)).toBe('-');
    expect(seen.input).toContain('"text"');
  });

  test('serializes concurrent calls to one subprocess', async () => {
    await fakeCodex();
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.content[0]).toEqual({ type: 'text', text: 'structured ok' });
    expect(b.content[0]).toEqual({ type: 'text', text: 'structured ok' });
  });

  test.each([['auth', 401], ['quota', 429]] as const)('maps %s failures clearly', async (mode, status) => {
    await fakeCodex(); process.env.CODEX_FAKE_MODE = mode;
    try { await call(); throw new Error('expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(CodexCliProcessError);
      expect((error as CodexCliProcessError).apiErrorStatus).toBe(status);
      expect((error as Error).message).toMatch(mode === 'auth' ? /authentication required/ : /quota exhausted/);
    }
  });
});
