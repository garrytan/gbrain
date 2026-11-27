import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { CLI, claudeJson, createSetupFixture, launcher, readJson, receipt, setup } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('gbrain setup claude-code: target first', () => {
  test('an explicit --surface full lists every operation, and a later run without flags keeps that registration as it is', async () => {
    const b = box();
    const first = await setup(b, ['claude-code', '--surface', 'full', '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.target.advertise).toBeUndefined();
    const listedFull = { type: 'stdio', command: launcher(b), args: [b.bin, 'serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome } };
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toEqual(listedFull);
    const again = await setup(b, ['claude-code', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.steps.find((s: any) => s.step === 'mcp').action).toBe('keep');
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toEqual(listedFull);
  });

  test('--dry-run on a new install shows the verbs listing over the starter surface', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--dry-run', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.target).toMatchObject({ surface: 'starter', advertise: 'verbs' });
  });

  test('--dry-run prints the target and writes nothing; GBRAIN_SURFACE is honoured', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--dry-run', '--json'], { GBRAIN_SURFACE: 'starter' });
    expect(r.exitCode).toBe(0);
    expect(r.doc.target).toMatchObject({ transport: 'local-stdio', surface: 'starter', registration_owner: 'none', launcher: b.bin });
    expect(r.doc.target.advertise).toBeUndefined();
    expect(r.doc.steps.find((s: any) => s.step === 'brain').detail).toContain('--no-embedding');
    expect(existsSync(claudeJson(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain'))).toBe(false);
  });

  test('a hosted connection never falls back to a new local brain', async () => {
    const thin = box();
    mkdirSync(join(thin.gbrainHome, '.gbrain'));
    writeFileSync(join(thin.gbrainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', remote_mcp: {
      issuer_url: 'https://brain.example.test', mcp_url: 'https://brain.example.test/mcp', oauth_client_id: 'client-a', oauth_client_secret: 'secret-a' } }));
    const r = await setup(thin, ['claude-code', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.code).toBe('setup_hosted_connection');
    expect(r.doc.message).toContain('https://brain.example.test/mcp');
    expect(existsSync(join(thin.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(existsSync(claudeJson(thin))).toBe(false);

    const wired = box();
    const hostedCfg = JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: 'https://brain.example.test/mcp', headers: { Authorization: 'Bearer x' } } } });
    writeFileSync(claudeJson(wired), hostedCfg);
    writeFileSync(receipt(wired), JSON.stringify({ client_id: 'client-a', mcp_url: 'https://brain.example.test/mcp', status: 'installed', harness: 'claude-code' }));
    const w = await setup(wired, ['claude-code', '--json']);
    expect(w.exitCode).toBe(1);
    expect(w.doc.code).toBe('setup_hosted_connection');
    expect(readFileSync(claudeJson(wired), 'utf8')).toBe(hostedCfg);
    expect(existsSync(join(wired.gbrainHome, '.gbrain'))).toBe(false);
  });

  test('a live PGLite owner that this setup did not register is an owner conflict; setup writes nothing', async () => {
    const b = box();
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home: b.home });
    expect(init.exitCode).toBe(0);
    const serve = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], {
      env: { ...process.env, HOME: b.home, GBRAIN_HOME: b.gbrainHome, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      expect(existsSync(lockFile)).toBe(true);
      const r = await setup(b, ['claude-code', '--json']);
      expect(r.exitCode).toBe(1);
      expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'live_serve' });
      expect(r.doc.fix.argv).toEqual(['kill', String(serve.pid)]);
      expect(existsSync(claudeJson(b))).toBe(false);
      expect(existsSync(receipt(b))).toBe(false);
    } finally {
      serve.kill();
      await serve.exited;
    }
  });

  test('a live stdio serve started by this setup\'s own registration is reused, not a conflict', async () => {
    const b = box();
    expect((await setup(b, ['claude-code'])).exitCode).toBe(0);
    const entry = readJson(claudeJson(b)).mcpServers.gbrain;
    const serve = Bun.spawn([entry.command, ...entry.args], {
      env: { ...process.env, ...entry.env, HOME: b.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      const r = await setup(b, ['claude-code', '--json']);
      expect(r.exitCode).toBe(0);
      expect(r.doc.target.live_owner).toMatchObject({ pid: serve.pid, transport: 'stdio', ours: true });
      expect(r.doc.verify.reason).toBe('wired_running');
    } finally {
      serve.kill();
      await serve.exited;
    }
  });
});
