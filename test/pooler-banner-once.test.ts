/**
 * #7147: the transaction-pooler banner prints once per database target, not on
 * every connect. A CLI behind a transaction-mode pooler connects once per
 * call, so an agent making dozens of read calls a day saw the same stderr
 * paragraph on every one of them.
 *
 * Protects: the banner is shown the first time this foresights home connects to a
 * database with prepared statements off, never again for that database, and
 * again for a different database. The state it keeps never holds the URL's
 * credentials. Regression it catches: a connect that warns unconditionally (the
 * pre-#7147 behaviour) or a state key that ignores the database.
 *
 * No server is needed: `connect()` decides on the banner before it dials, so a
 * refused port exercises the whole path.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';

const BANNER = 'Prepared statements and statement pipelining disabled';
const url = (db: string) => `postgresql://alice-example:secret-example@127.0.0.1:1/${db}?prepare=false&connect_timeout=1`;

let home: string;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-pooler-banner-'));
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

const banners = () => warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes(BANNER)).length;

/** Connects to a refused port with this test's foresights home; the connect fails after its banner decision. */
async function connectRefused(databaseUrl: string): Promise<void> {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await expect(connect({ engine: 'postgres', database_url: databaseUrl })).rejects.toThrow();
  });
}

function stateFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

describe('pooler banner (#7147)', () => {
  test('a second connect to the same database does not repeat the banner', async () => {
    await connectRefused(url('brain_a'));
    expect(banners()).toBe(1);
    await connectRefused(url('brain_a'));
    expect(banners()).toBe(1);
  });

  test('a different database gets its own banner', async () => {
    await connectRefused(url('brain_a'));
    await connectRefused(url('brain_b'));
    expect(banners()).toBe(2);
  });

  test('the remembered state never contains the URL credentials', async () => {
    await connectRefused(url('brain_a'));
    const files = stateFiles(home);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain('secret-example');
  });
});
