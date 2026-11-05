/** Process A is this isolated persistent PGLite owner; process B is the real CLI. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectLockHolder } from '../src/core/pglite-lock.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readLocalWriter } from '../src/core/persistence/identity.ts';
import { requestPersistenceAdministration, startPersistenceIpcServer, persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import type { PersistenceAdminOperation } from '../src/core/persistence/admin-contract.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string, database: string, socket: string, brainId: string;
let engine: PGLiteEngine;
let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>>;
let responseOverride: { result: unknown } | undefined;
let releaseOwnerBeforeResponse = false;
const state = (value: string | null) => ({ key: 'sources.refresh_hold', present: value !== null, value });
const isolated = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
const call = (...args: string[]) => runCli(['sources', 'refresh-hold', ...args, '--json'], { home, cwd: home });

async function closeOwner() {
  if (binding) {
    const closed = once(binding.server, 'close');
    binding.close(); await closed; binding = null;
  }
  if (engine) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gb-hold-owner-'));
  database = join(home, 'db');
  mkdirSync(join(home, '.gbrain'));
  const config = { engine: 'pglite' as const, database_path: database, embedding_disabled: true,
    sources: { refresh_hold: 'false' } };
  writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
  await isolated(async () => {
    engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
    // Only the fixture's diagnostic metadata changes; the real kernel lock stays held by A.
    const metadata = join(database, '.gbrain-lock/lock');
    writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, 'utf8')), subcommand: 'serve' }));
    const provider = await createPersistenceIpcProvider(engine, config);
    const administer = provider.administer!;
    provider.administer = async request => {
      const result = await administer(request);
      if (releaseOwnerBeforeResponse) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
      return request.operation === 'writer_refresh_hold_get' && responseOverride ? responseOverride.result : result;
    };
    brainId = provider.brainId;
    socket = persistenceSocketPathForConfig(config)!;
    binding = await startPersistenceIpcServer(socket, provider);
    expect(binding).not.toBeNull();
    await engine.setConfig('hold_fixture_other', 'unrelated fixture value');
  });
}, 120_000);
afterAll(async () => { await closeOwner(); if (home) rmSync(home, { recursive: true, force: true }); });

test('resident owner: real CLI reads DB-only absent, empty, dash and BOM values while A retains its lock', () => isolated(async () => {
  for (const value of [null, '', '-x', '\ufeff -中文\n']) {
    if (value === null) await engine.unsetConfig('sources.refresh_hold');
    else await engine.setConfig('sources.refresh_hold', value);
    const before = inspectLockHolder(database);
    expect(before).toMatchObject({ held: true, pid: process.pid, serve: true });
    for (const flags of [[], ['--json']]) {
      const result = await runCli(['sources', 'refresh-hold', 'get', ...flags], { home, cwd: home });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(state(value));
    }
    expect(inspectLockHolder(database)).toMatchObject(before);
    expect(await engine.getConfig('hold_fixture_other')).toBe('unrelated fixture value');
  }
}), 120_000);

const malformedResponses: [string, unknown][] = [
  ['wrong key', { key: 'hold_fixture_other', present: true, value: 'false' }],
  ['missing key', { present: true, value: 'false' }],
  ['missing present', { key: 'sources.refresh_hold', value: 'false' }],
  ['missing value', { key: 'sources.refresh_hold', present: false }],
  ['string present', { key: 'sources.refresh_hold', present: 'true', value: 'false' }],
  ['number present', { key: 'sources.refresh_hold', present: 0, value: null }],
  ['null present', { key: 'sources.refresh_hold', present: null, value: null }],
  ['present null', { key: 'sources.refresh_hold', present: true, value: null }],
  ['absent string', { key: 'sources.refresh_hold', present: false, value: '' }],
  ['number value', { key: 'sources.refresh_hold', present: true, value: 0 }],
  ['boolean value', { key: 'sources.refresh_hold', present: true, value: false }],
  ['object value', { key: 'sources.refresh_hold', present: true, value: {} }],
  ['array value', { key: 'sources.refresh_hold', present: true, value: [] }],
  ['extra field', { ...state('false'), extra: 'synthetic extra field' }],
  ['null result', null], ['array result', []], ['string result', 'false'], ['boolean result', false],
];

test.each(malformedResponses.flatMap(([name, result]) => [false, true].map(json => [name, json, result] as const)))(
  'resident owner rejects malformed success %s json=%s', (name, json, body) => isolated(async () => {
    responseOverride = { result: body };
    try {
      const before = inspectLockHolder(database);
      const result = await runCli(['sources', 'refresh-hold', 'get', ...(json ? ['--json'] : [])], { home, cwd: home });
      expect(result.exitCode, JSON.stringify({ name, json, ...result })).toBe(1);
      expect(result.stderr).toContain('invalid refresh-hold result');
      if (json) expect(JSON.parse(result.stdout)).toMatchObject({ code: 'unavailable' });
      else expect(result.stdout).toBe('');
      expect(result.stdout + result.stderr).not.toContain('synthetic extra field');
      expect(inspectLockHolder(database)).toMatchObject(before);
    } finally { responseOverride = undefined; }
  }), 120_000);

test('resident owner: refresh_held survives IPC and its returned inspect argv executes in a second real CLI', () => isolated(async () => {
  await engine.setConfig('sources.refresh_hold', '-x');
  const refused = await runCli(['sources', 'refresh', 'default', '--json'], { home, cwd: home });
  expect(refused.exitCode).toBe(1);
  const body = JSON.parse(refused.stdout);
  expect(body.code).toBe('refresh_held');
  expect(body.fix.argv).toEqual(['gbrain', 'sources', 'refresh-hold', 'get', '--json', '--brain', 'host']);
  const inspected = await runCli(body.fix.argv.slice(1), { home, cwd: home });
  expect(inspected.exitCode, inspected.stderr).toBe(0);
  expect(JSON.parse(inspected.stdout)).toEqual(state('-x'));
}), 120_000);

test('resident owner: a global timeout still uses the pre-connect inspection delegate', () => isolated(async () => {
  await engine.setConfig('sources.refresh_hold', '-x');
  const result = await call('get', '--timeout=10s');
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(state('-x'));
  expect(inspectLockHolder(database)).toMatchObject({ held: true, pid: process.pid, serve: true });
}), 120_000);

test('global timeout bounds a stalled resident capability handshake with exit 124', () => isolated(async () => {
  const server = binding!.server, listeners = server.listeners('connection'), sockets = new Set<Socket>();
  let contacted = false;
  // Stall only this fixture's capability handshake; A keeps the actual engine and kernel lock.
  server.removeAllListeners('connection');
  server.on('connection', socket => { sockets.add(socket); socket.on('data', () => { contacted = true; }); });
  try {
    const result = await call('get', '--timeout=100ms');
    expect(contacted).toBe(true);
    expect(result.exitCode, result.stderr).toBe(124);
    expect(result.stderr).toContain('timed out');
    expect(inspectLockHolder(database)).toMatchObject({ held: true, pid: process.pid, serve: true });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.removeAllListeners('connection');
    for (const listener of listeners) server.on('connection', socket => listener.call(server, socket));
  }
}), 120_000);

test('resident inspection rejects arbitrary keys, values and SQL before reading or writing', () => isolated(async () => {
  const registration = await readLocalWriter(engine, 'cli');
  for (const params of [{ key: 'hold_fixture_other' }, { value: 'false' }, { sql: 'SELECT 1' }, { dry_run: true }]) {
    await expect(requestPersistenceAdministration(socket, { version: 1, kind: 'administration', brain_id: brainId,
      operation: 'writer_refresh_hold_get' as PersistenceAdminOperation, params, registration })).rejects.toMatchObject({ code: 'invalid_params' });
  }
  const malformed = await call('get', 'hold_fixture_other');
  expect(malformed.exitCode).not.toBe(0);
  expect(malformed.stdout + malformed.stderr).not.toContain('unrelated fixture value');
  expect(await engine.getConfig('sources.refresh_hold')).toBe('-x');
  expect(await engine.getConfig('hold_fixture_other')).toBe('unrelated fixture value');
}), 120_000);

test('resident inspection requires this brain\'s registered CLI and refuses stdio callers', () => isolated(async () => {
  const registration = await readLocalWriter(engine, 'stdio');
  await expect(requestPersistenceAdministration(socket, { version: 1, kind: 'administration', brain_id: brainId,
    operation: 'writer_refresh_hold_get' as PersistenceAdminOperation, params: {}, registration })).rejects.toMatchObject({ code: 'invalid_params' });
  const unregistered = join(home, 'unregistered');
  mkdirSync(join(unregistered, '.gbrain'), { recursive: true });
  writeFileSync(join(unregistered, '.gbrain/config.json'), readFileSync(join(home, '.gbrain/config.json')));
  const denied = await runCli(['sources', 'refresh-hold', 'get', '--json'], { home: unregistered, cwd: unregistered });
  expect(denied.exitCode).not.toBe(0);
  expect(denied.stdout + denied.stderr).toContain('permission_denied');
}), 120_000);

test('set and clear keep the existing PGLite stop-window requirement and cannot change the resident hold', () => isolated(async () => {
  const file = join(home, 'value'); writeFileSync(file, 'false');
  for (const args of [['set', '--file', file], ['clear']]) {
    const refused = await call(...args);
    expect(refused.exitCode).not.toBe(0);
    expect(await engine.getConfig('sources.refresh_hold')).toBe('-x');
    expect(inspectLockHolder(database)).toMatchObject({ held: true, pid: process.pid });
  }
}), 120_000);

test('invalid success cannot fall back to a direct read even after the owner releases its lock', () => isolated(async () => {
  responseOverride = { result: { key: 'hold_fixture_other', present: true, value: 'false' } };
  releaseOwnerBeforeResponse = true;
  try {
    const result = await call('get');
    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'unavailable' });
    expect(result.stderr).toContain('invalid refresh-hold result');
    expect(inspectLockHolder(database).held).toBe(false);
  } finally { responseOverride = undefined; releaseOwnerBeforeResponse = false; }
}), 120_000);

test('owner absent: real CLI falls back to direct persistent DB inspection', () => isolated(async () => {
  await closeOwner();
  expect(inspectLockHolder(database).held).toBe(false);
  const result = await call('get');
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(state('-x'));
}), 120_000);
