/**
 * Refusal-swallow site 1 (src/commands/google.ts runGoogleStatus): `gbrain google status` read the linked google
 * sources with raw SQL inside a catch that fell back to vault-only status. On the Rust engine, which refuses every raw
 * statement with `engine_capability_missing`, the status then listed no linked sources and looked complete. The read
 * now goes through the typed member the doctor calendar check uses, which every engine serves.
 *
 * The engine factory returns a real PGLite brain whose `executeRaw` refuses, as the Rust engine does, every statement
 * that reads `sources`. SERIAL: mock.module (R2) and GBRAIN_HOME (R1).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { withEnv } from './helpers/with-env.ts';

const pglite = new PGLiteEngine();

/** PGLite with lifecycle calls ignored (the test owns the connection) and raw reads of `sources` refused. */
const refusing = new Proxy(pglite, {
  get(target, prop) {
    if (prop === 'connect' || prop === 'disconnect') return async () => {};
    if (prop === 'executeRaw') {
      return async (sql: string, params?: unknown[]) => {
        if (/\bFROM sources\b/.test(sql)) throw capabilityMissing('raw_sql', 'executeRaw');
        return target.executeRaw(sql, params);
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

mock.module('../src/core/engine-factory.ts', () => ({ createEngine: async () => refusing }));
const { runGoogleStatus } = await import('../src/commands/google.ts');

let home: string;

beforeAll(async () => {
  await pglite.connect({});
  await pglite.initSchema();
  await pglite.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('gmail-me', 'gmail-me', $1::text::jsonb)`,
    [JSON.stringify({ kind: 'google', g_account: 'owner@example.invalid', services: ['gmail'] })]);
  home = mkdtempSync(join(tmpdir(), 'gbrain-google-status-refusal-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
}, 60_000);

afterAll(async () => {
  await pglite.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function stdout(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { process.stdout.write = orig; }
  return out.join('');
}

describe('gbrain google status on an engine that refuses raw SQL', () => {
  test('lists the linked google sources instead of falling back to vault-only status', async () => {
    const out = await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      () => stdout(() => runGoogleStatus(['--json', '--no-probe'])));
    const status = JSON.parse(out) as { linked_sources: Array<{ id: string; account: string | null }> };
    expect(status.linked_sources).toEqual([expect.objectContaining({ id: 'gmail-me', account: 'owner@example.invalid' })]);
  });
});
