/**
 * A4 Tier 1 fixture: observational startup before consent.
 *
 * Protects: a command declaring `startup: 'observational'` connects probe-only
 * (no schema migrations, no retired-marker cleanup, no DB-plane config merge),
 * so when its consent check refuses, a brain with a pending migration keeps
 * its schema version. An authorized run completes startup through
 * `ctx.completeStartup` and the migration applies. The control proves the
 * fixture really has a pending migration that a normal startup applies.
 *
 * Seam: the real dispatcher (`__testing.main`) against a real on-disk PGLite
 * brain. The synthetic command is the `repair` record with `startup` set for
 * the test and its module replaced by a consent-gated handler (mock.module,
 * hence the serial lane).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, hasPendingMigrations } from '../src/core/migrate.ts';
import { isConsentRefusal, printConsentRefusal, requireConsent } from '../src/core/consent.ts';
import { findCliCommand, type CliDispatchContext } from '../src/cli/command-table.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const seen: { atHandler?: string | null; afterStartup?: string | null } = {};

mock.module('../src/cli/commands/repair.ts', () => ({
  run: async (engine: BrainEngine, args: string[], ctx: CliDispatchContext) => {
    seen.atHandler = await engine.getConfig('version');
    try {
      await requireConsent({
        command: 'repair', effects: ['paid'], actor: 'agent', what: 'gbrain repair', why: 'Synthetic paid work.',
        risk: 'Spends up to the cap.', user_message: 'Spend about $0.10?', argv: ['gbrain', 'repair'], est_usd: 0.1, args,
      }, { interactive: false, preapprovals: {}, note: () => {} });
    } catch (e) {
      if (isConsentRefusal(e)) process.exit(printConsentRefusal(e, { json: args.includes('--json') }));
      throw e;
    }
    await ctx.completeStartup?.(engine);
    seen.afterStartup = await engine.getConfig('version');
  },
}));

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

const PENDING = String(LATEST_VERSION - 1);
const ENV_KEYS = ['HOME', 'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_NO_RETRY_CONNECT'];
const savedEnv: Record<string, string | undefined> = {};
let home: string;
let brainPath: string;
let main: () => Promise<void>;
let stdout: string;

async function withBrain<T>(fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: brainPath });
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

async function run(argv: string[]): Promise<string> {
  const savedArgv = process.argv;
  process.argv = [savedArgv[0]!, 'gbrain', ...argv];
  try {
    await main();
    return 'returned';
  } catch (e) {
    if (e instanceof ExitSignal) return `exit:${e.code}`;
    throw e;
  } finally {
    process.argv = savedArgv;
  }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'gbrain-observational-'));
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.GBRAIN_NO_RETRY_CONNECT = '1';
  brainPath = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: brainPath }, null, 2));
  await withBrain(engine => engine.initSchema());
  main = (await import('../src/cli.ts')).__testing.main;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

let restores: Array<() => void> = [];
beforeEach(async () => {
  await withBrain(engine => engine.setConfig('version', PENDING));
  delete seen.atHandler;
  delete seen.afterStartup;
  stdout = '';
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new TypeError('no network in this test'); }) as never);
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as never);
  const errWrite = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  const quiet = (['log', 'error', 'warn'] as const).map(m => spyOn(console, m).mockImplementation(() => {}));
  restores = [() => exit.mockRestore(), () => fetchSpy.mockRestore(), () => write.mockRestore(), () => errWrite.mockRestore(), ...quiet.map(q => () => q.mockRestore())];
});

afterEach(() => {
  for (const r of restores) r();
  delete (findCliCommand('repair') as { startup?: string }).startup;
  process.exitCode = 0;
});

const markObservational = () => { (findCliCommand('repair') as { startup?: string }).startup = 'observational'; };

describe('observational startup before consent (pending-migration fixture)', () => {
  test('control: a normal post-connect command applies the pending migration before its handler', async () => {
    expect(await run(['repair', '--yes'])).toBe('returned');
    expect(seen.atHandler).toBe(String(LATEST_VERSION));
    expect(await withBrain(engine => engine.getConfig('version'))).toBe(String(LATEST_VERSION));
  });

  test('observational + refused consent: exit 3 with the payload, schema version unchanged', async () => {
    markObservational();
    expect(await run(['repair', '--json'])).toBe('exit:3');
    expect(seen.atHandler).toBe(PENDING);
    expect(seen.afterStartup).toBeUndefined();
    expect(JSON.parse(stdout)).toMatchObject({ status: 'confirmation_required', code: 'confirmation_required', effects: ['paid'] });
    await withBrain(async engine => {
      expect(await engine.getConfig('version')).toBe(PENDING);
      expect(await hasPendingMigrations(engine)).toBe(true);
    });
  });

  test('observational + authorized: startup completes after consent and the migration applies', async () => {
    markObservational();
    expect(await run(['repair', '--yes'])).toBe('returned');
    expect(seen.atHandler).toBe(PENDING);
    expect(seen.afterStartup).toBe(String(LATEST_VERSION));
    expect(await withBrain(engine => engine.getConfig('version'))).toBe(String(LATEST_VERSION));
  });
});
