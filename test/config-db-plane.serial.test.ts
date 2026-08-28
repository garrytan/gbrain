/**
 * DB-connection config keys are FILE-plane canonical and ENGINE-FREE
 * (db-availability loop 5c): `handleDbPlaneRoutedKeys` must write
 * ~/.gbrain/config.json without EVER touching an engine — "fix your URL with
 * config set database_url" has to work while the database it names is down.
 * No engine object exists anywhere in these tests; that absence IS the
 * regression pin (the old path sat behind connectEngine and died on the
 * exact connection error it was meant to fix).
 *
 * Also pins: engine inference from the key that was set (+ the loud
 * flip-does-not-move-data note), redaction of both postgres:// and
 * postgresql:// DSNs, the thin-client refusal, and the `engine` hard-refusal.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleDbPlaneRoutedKeys, redactConfigValue, tryRunConfigEngineFree } from '../src/commands/config.ts';

const PG_URL = 'postgresql://user:sekret-pw@db.example.com:5432/gbrain';

// ---------------------------------------------------------------------------
// Hermetic home + console/exit capture (the db-repair.test.ts pattern)
// ---------------------------------------------------------------------------

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL'] as const;
const envSnapshot: Record<string, string | undefined> = {};

let home: string;
let logs: string[];
let errs: string[];
let exitCode: number | null;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'gbrain-config-db-plane-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  logs = [];
  errs = [];
  exitCode = null;
  logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function configPath(): string {
  return join(home, '.gbrain', 'config.json');
}

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

/** Run the handler, swallowing only the stubbed-exit throw. */
async function runRouted(key: string, value: string): Promise<boolean | null> {
  try {
    return await handleDbPlaneRoutedKeys(key, value);
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
    return null;
  }
}

// ---------------------------------------------------------------------------

describe('config set database_url/database_path — file plane, engine-free', () => {
  test('REGRESSION: database_url writes the file plane with NO database reachable and NO engine involved', async () => {
    // No config.json yet, no engine anywhere, and db.example.com does not
    // exist — the write must still succeed (that is the whole point).
    const handled = await runRouted('database_url', PG_URL);
    expect(handled).toBe(true);
    expect(exitCode).toBeNull();

    const cfg = readConfig();
    expect(cfg.database_url).toBe(PG_URL);
    expect(cfg.engine).toBe('postgres'); // inferred from the key that was set
    expect('database_path' in cfg).toBe(false);

    // Confirmation names the plane and never echoes the raw credential.
    const out = logs.join('\n');
    expect(out).toContain('file plane');
    expect(out).not.toContain('sekret-pw');
  });

  test('database_path routes to the file plane with engine pglite (and drops database_url)', async () => {
    writeConfig({ engine: 'postgres', database_url: PG_URL });
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    const handled = await runRouted('database_path', dbPath);
    expect(handled).toBe(true);
    expect(exitCode).toBeNull();

    const cfg = readConfig();
    expect(cfg.database_path).toBe(dbPath);
    expect(cfg.engine).toBe('pglite');
    expect('database_url' in cfg).toBe(false);
    // The flip note points at the data-moving recipe for the pglite direction.
    expect(errs.join('\n')).toContain('engine flipped postgres → pglite');
    expect(errs.join('\n')).toContain('gbrain migrate --to pglite');
  });

  test('engine-flip warning: pglite → postgres names the flip and the migrate recipe', async () => {
    writeConfig({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    const handled = await runRouted('database_url', PG_URL);
    expect(handled).toBe(true);

    const err = errs.join('\n');
    expect(err).toContain('engine flipped pglite → postgres');
    expect(err).toContain('NOT moved');
    expect(err).toContain('gbrain migrate --to supabase');

    const cfg = readConfig();
    expect(cfg.engine).toBe('postgres');
    expect(cfg.database_url).toBe(PG_URL);
    expect('database_path' in cfg).toBe(false);
  });

  test('thin-client config refuses: a local database_url would conflict with remote MCP (exit 1, config untouched)', async () => {
    writeConfig({ remote_mcp: { mcp_url: 'https://brain.example.com/mcp' } });
    const before = readFileSync(configPath(), 'utf-8');
    const handled = await runRouted('database_url', PG_URL);
    expect(handled).toBeNull(); // exited before returning
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('thin client');
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
  });

  test('database_url must be a postgres:// or postgresql:// DSN (exit 1 on anything else)', async () => {
    expect(await runRouted('database_url', 'mysql://u:p@h/db')).toBeNull();
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('postgres://');
    expect(existsSync(configPath())).toBe(false); // nothing persisted
  });

  test('unrelated keys are not handled (fall through to the normal set path)', async () => {
    expect(await runRouted('search.mode', 'balanced')).toBe(false);
    expect(exitCode).toBeNull();
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('config set engine — hard refusal', () => {
  test('engine is never set directly: exit 1 with the migrate recipe, nothing written', async () => {
    let handled: boolean | null = null;
    try {
      handled = await tryRunConfigEngineFree(['set', 'engine', 'postgres']);
    } catch (e) {
      if (!(e as Error).message.startsWith('EXIT:')) throw e;
    }
    expect(handled).toBeNull(); // exited inside the refusal
    expect(exitCode).toBe(1);
    const err = errs.join('\n');
    expect(err).toContain('INFERRED');
    expect(err).toContain('migrate');
    expect(err).toContain('No --force escape');
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('redactConfigValue', () => {
  test('postgres:// DSN (the old regex blind spot) drops the whole userinfo', () => {
    const out = redactConfigValue('database_url', 'postgres://user:pass@host/db');
    expect(out).not.toContain('pass');
    expect(out).not.toContain('user');
    expect(out).toBe('postgres://***@host/db');
  });

  test('postgresql:// DSN redacts the same way', () => {
    const out = redactConfigValue('database_url', 'postgresql://user:pass@host:5432/db');
    expect(out).not.toContain('pass');
    expect(out).toBe('postgresql://***@host:5432/db');
  });

  test('non-URL sensitive keys collapse to ***; non-sensitive values pass through', () => {
    expect(redactConfigValue('anthropic_api_key', 'sk-super-secret')).toBe('***');
    expect(redactConfigValue('auth_token', 'tok123')).toBe('***');
    expect(redactConfigValue('search.mode', 'balanced')).toBe('balanced');
  });
});
