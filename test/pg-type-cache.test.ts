/**
 * #5984 G3: the saved parameter types (src/core/pg-type-cache.ts). A second
 * process with the same database scope starts with the first one's described
 * types; a different server or schema version, the persist switch, or a
 * migration's clear leaves it describing again; no SQL text is written.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetSharedParameterTypesForTests, loadSharedParameterTypes, sharedParameterTypes, typeCacheTarget } from '../src/core/pg-type-cache.ts';
import { withEnv } from './helpers/with-env.ts';

/** A database URL with credentials (example values), built so no literal credential URL sits in the source. */
function dbUrl(hostPortDb: string, user = 'writer', password = 's3cret', query = ''): string {
  const url = new URL(`postgresql://${hostPortDb}${query}`);
  url.username = user;
  url.password = password;
  return url.toString();
}
const URL_A = dbUrl('db.example.test:6543/brain');
const KEY = '23,25SELECT id FROM pages WHERE source_id=$1 AND slug=$2';

afterEach(() => _resetSharedParameterTypesForTests());

async function withHome<T>(body: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-type-cache-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_PG_TYPE_CACHE: undefined, GBRAIN_PG_TYPE_CACHE_PERSIST: undefined }, () => body(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function cacheFiles(home: string): string[] {
  const dir = join(home, '.gbrain', 'cache', 'pg-types');
  return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [];
}

/** One "process": load the scope, optionally record a description, save at exit. */
function processRun(scope: [string, string], record?: number[]) {
  _resetSharedParameterTypesForTests();
  const store = sharedParameterTypes(URL_A);
  if (!store) throw new Error('sharing is off');
  const loaded = loadSharedParameterTypes(URL_A, scope[0], scope[1]);
  const before = store.get(KEY);
  if (record) store.set(KEY, record);
  store.save();
  return { loaded, before };
}

test('a second process with the same scope starts with the first one\'s described types', () => withHome(home => {
  expect(processRun(['160004', '112'], [25, 25]).before).toBeUndefined();
  expect(processRun(['160004', '112'])).toEqual({ loaded: 1, before: [25, 25] });
  const [file] = cacheFiles(home);
  expect(statSync(file!).mode & 0o777).toBe(0o600);
}));

test('the file holds digests and type ids only: no SQL text, credentials or host', () => withHome(home => {
  processRun(['160004', '112'], [25, 25]);
  const text = readFileSync(cacheFiles(home)[0]!, 'utf8');
  for (const leaked of ['SELECT', 'pages', 'source_id', 's3cret', 'writer', 'example']) expect(text).not.toContain(leaked);
}));

test('a different server version or schema version ignores and then replaces the saved types', () => withHome(() => {
  processRun(['160004', '112'], [25, 25]);
  expect(processRun(['170000', '112'])).toEqual({ loaded: 0, before: undefined });
  expect(processRun(['160004', '113'])).toEqual({ loaded: 0, before: undefined });
}));

test('with no schema version (a database gbrain has not initialized) nothing is loaded or saved', () => withHome(home => {
  processRun(['160004', null as unknown as string], [25, 25]);
  expect(cacheFiles(home)).toEqual([]);
}));

test('GBRAIN_PG_TYPE_CACHE_PERSIST=0 keeps the types in this process', () => withHome(async home => {
  await withEnv({ GBRAIN_PG_TYPE_CACHE_PERSIST: '0' }, () => processRun(['160004', '112'], [25, 25]));
  expect(cacheFiles(home)).toEqual([]);
}));

test('GBRAIN_PG_TYPE_CACHE=0 turns sharing off entirely', () => withEnv({ GBRAIN_PG_TYPE_CACHE: '0' }, () => {
  expect(sharedParameterTypes(URL_A)).toBe(false);
}));

test('clearing (after a migration) deletes the saved types', () => withHome(home => {
  processRun(['160004', '112'], [25, 25]);
  _resetSharedParameterTypesForTests();
  const store = sharedParameterTypes(URL_A) as Map<string, number[]>;
  loadSharedParameterTypes(URL_A, '160004', '112');
  store.clear();
  expect(cacheFiles(home)).toEqual([]);
  expect(processRun(['160004', '112']).before).toBeUndefined();
}));

test('pools of one database target share a store; another database gets its own', () => {
  expect(sharedParameterTypes(dbUrl('db.example.test:6543/brain', 'writer', 'rotated', '?sslmode=require'))).toBe(sharedParameterTypes(URL_A));
  expect(sharedParameterTypes(dbUrl('db.example.test:6543/other'))).not.toBe(sharedParameterTypes(URL_A));
  expect(typeCacheTarget(URL_A)).toBe('db.example.test:6543/brain?writer');
});

test('entries another process saved under the same scope are kept when this process saves', () => withHome(() => {
  processRun(['160004', '112'], [25, 25]);
  _resetSharedParameterTypesForTests();
  const store = sharedParameterTypes(URL_A) as Map<string, number[]>;
  loadSharedParameterTypes(URL_A, '160004', '112');
  store.set('20SELECT $1::bigint', [20]);
  (store as unknown as { save(): void }).save();
  _resetSharedParameterTypesForTests();
  const next = sharedParameterTypes(URL_A) as Map<string, number[]>;
  expect(loadSharedParameterTypes(URL_A, '160004', '112')).toBe(2);
  expect(next.get(KEY)).toEqual([25, 25]);
  expect(next.get('20SELECT $1::bigint')).toEqual([20]);
}));

test('a corrupt file or a non-built-in type id is ignored', () => withHome(home => {
  processRun(['160004', '112'], [25, 25]);
  const file = cacheFiles(home)[0]!;
  const digestKey = Object.keys(JSON.parse(readFileSync(file, 'utf8')).types)[0]!;
  writeFileSync(file, '{not json');
  expect(processRun(['160004', '112']).loaded).toBe(0);
  writeFileSync(file, JSON.stringify({ scope: '160004:112', types: { [digestKey]: [16385] } }));
  expect(processRun(['160004', '112']).loaded).toBe(0);
}));

test('a proxy URL and a direct URL to one database (same server-side identity) share the saved types', () => withHome(() => {
  const PROXY = dbUrl('127.0.0.1:55473/brain');
  const DIRECT = dbUrl('127.0.0.1:55472/brain');
  const identity = 'brain@172.17.0.2:5432?writer';
  _resetSharedParameterTypesForTests();
  const first = sharedParameterTypes(DIRECT) as Map<string, number[]>;
  loadSharedParameterTypes(DIRECT, '160004', '112', identity);
  first.set(KEY, [25, 25]);
  (first as unknown as { save(): void }).save();
  _resetSharedParameterTypesForTests();
  const second = sharedParameterTypes(PROXY) as Map<string, number[]>;
  expect(loadSharedParameterTypes(PROXY, '160004', '112', identity)).toBe(1);
  expect(second.get(KEY)).toEqual([25, 25]);
}));
