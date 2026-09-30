import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const oldBinary = process.env.GBRAIN_TEST_OLD_BINARY;
const worker = join(import.meta.dir, 'fixtures/persistence-skill-worker.ts');

(oldBinary ? test : test.skip)('retained pre-feature executable is denied before a skill claim at protocol floors one and two', async () => {
  expect(existsSync(oldBinary!)).toBe(true);
  for (const floor of [1, 2]) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-old-consumer-'));
    const config = { engine: 'pglite', database_path: join(home, 'db'), root: join(home, 'root'), sourceId: 'compatibility-example' };
    const configPath = join(home, 'worker.json');
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
    const env = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SWEEP: '0', GBRAIN_NO_BANNER: '1',
      GBRAIN_UPDATE_CHECK: '0', GBRAIN_BRAIN_ID: 'host' };
    const run = async (mode: string) => {
      const child = Bun.spawn([process.execPath, worker, mode, configPath, 'legacy-target'], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        return stdout;
      } finally { clearTimeout(timer); }
    };
    let owner: ReturnType<typeof Bun.spawn> | undefined;
    let stderr = '', stdout = '';
    const readers: Promise<void>[] = [];
    const read = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      for await (const bytes of stream) append(new TextDecoder().decode(bytes));
    };
    try {
      await run('initialize'); await run('admit');
      if (floor === 1) await run('preactivation-fixture');
      owner = Bun.spawn([oldBinary!, 'serve'], { cwd: home, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      readers.push(read(owner.stdout as ReadableStream<Uint8Array>, text => { stdout += text; }), read(owner.stderr as ReadableStream<Uint8Array>, text => { stderr += text; }));
      (owner.stdin as { write(value: string): unknown }).write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'compatibility-fixture', version: '1' } } }) + '\n');
      const deadline = performance.now() + 60_000;
      while (performance.now() < deadline && !stderr.includes('[persistence] Consumer paused after a storage error')) {
        if (owner.exitCode !== null) throw new Error(`Preserved executable exited before exercising its consumer: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(stderr).toContain('[persistence] Consumer paused after a storage error');
      expect(stdout).toContain('"id":1');
      owner.kill('SIGTERM');
      const kill = setTimeout(() => owner?.kill('SIGKILL'), 10_000);
      await owner.exited; clearTimeout(kill); await Promise.all(readers);
      const inspection = await run('inspect');
      const result = JSON.parse(inspection.trim().split('\n').at(-1)!);
      expect(result).toMatchObject({ state: 'queued', execution_token: null, recovery: null,
        files: ['old-0', null, 'old-2'] });
    } finally {
      if (owner?.exitCode === null) { owner.kill('SIGKILL'); await owner.exited; }
      await Promise.allSettled(readers);
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 180_000);
