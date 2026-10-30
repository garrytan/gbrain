/**
 * GBRA-156: serial database round trips a warm serve request pays around its operation.
 *
 * 1. Protects: a warm request resolves its source and reads the config table in one round trip, on the warm CLI socket
 *    and on MCP stdio, with the same resolved source; the MCP hot-memory hook runs beside a read op's handler, and
 *    reads its two cache revalidation keys (withdrawal watermark, trust generation) together.
 * 2. Fails when: a source-resolution or config read waits on another one (the merged config before the resolution,
 *    tier 5's config key behind the tier-4 listing, the tier-5.5 emptiness probe behind the listing, the federated
 *    set's own sources read, stdio resolving outside the request's config snapshot), or the hook starts only after a
 *    read op settles, or it reads the watermark and the generation one after the other again.
 * 3. Existing coverage: test/cold-read-folded-statements.test.ts counts the sources reads of one snapshot, not their
 *    order; test/facts-context-injection.serial.test.ts pins the hook's payload, not when it runs.
 * 4. Seam: none. test/helpers/statement-depth.ts holds every PGLite statement and records its serial depth; the stdio
 *    arm runs the real `startMcpServer` (test/fixtures/mcp-stdio-round-trip-driver.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { executeCliSocketRequest } from '../src/core/cli-socket/execute.ts';
import { cliSocketIdentity } from '../src/core/cli-socket/identity.ts';
import { withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { explicitReadBinding, localFederatedSourceIds, resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetHotMemoryCacheForTests, getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { recordStatementDepth, type DepthRecord } from './helpers/statement-depth.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

/** The reads a request makes to resolve its source and load its config. */
const RESOLUTION = /^SELECT (key, value|value) FROM config\b|\bFROM sources (ORDER BY id|WHERE)\b|^SELECT 1 AS one FROM pages WHERE source_id = 'default'/;
const WITHDRAWALS = /FROM fact_withdrawals WHERE source_id/;
const GENERATION = /FROM trust_policy_state WHERE id = 1/;
const SEARCH = /^WITH (top_pages|ranked) AS/;

/** Every read before the operation's first statement, and that first statement. */
function resolutionThenOp(records: DepthRecord[]): { resolution: DepthRecord[]; op: DepthRecord } {
  const first = records.findIndex(r => !RESOLUTION.test(r.sql));
  return { resolution: records.slice(0, first), op: records[first]! };
}

let engine: PGLiteEngine;
let depth: ReturnType<typeof recordStatementDepth>;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  depth = recordStatementDepth(engine);
  root = mkdtempSync(join(tmpdir(), 'gbrain-serve-round-trips-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetHotMemoryCacheForTests();
  const side = join(root, 'source-a-example');
  mkdirSync(side, { recursive: true });
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('source-a', 'source-a', $1, '{"federated": true}'::jsonb)`, [side]);
});

async function traced(fn: () => Promise<unknown>): Promise<DepthRecord[]> {
  depth.reset();
  await fn();
  return [...depth.records];
}

describe('warm CLI socket request', () => {
  const search = () => executeCliSocketRequest(engine, {
    v: 1, identity: cliSocketIdentity({ config: { engine: 'postgres' }, brainId: 'host', configDir: '/nonexistent', configFile: '/nonexistent/config.json', version: 'x', env: {} }),
    command: 'search', kind: 'op', op: 'search', params: { query: 'alpha' }, routing: { cwd: root, source_env: null }, cli: { quiet: true, timeout_ms: null },
  });

  test('resolves its source (tier 5.5) and reads its config in one round trip, then runs the op', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await search();
      let kind: unknown;
      const records = await traced(async () => { kind = (await search()).frame.kind; });
      const { resolution, op } = resolutionThenOp(records);
      expect(kind).toBe('result');
      expect(resolution.length).toBeGreaterThanOrEqual(2);
      expect(resolution.map(r => r.depth)).toEqual(resolution.map(() => 1));
      expect(op.depth).toBe(2);
    });
  });
});

describe('source resolution inside a request snapshot', () => {
  for (const defaultPages of [false, true]) {
    test(`tier 5.5 with ${defaultPages ? 'a non-empty' : 'an empty'} 'default': one round trip, the same answer as live reads`, async () => {
      if (defaultPages) await engine.putPage('notes/default-example', { type: 'note', title: 'Default example', compiled_truth: 'body' });
      const resolveScope = async () => {
        const resolved = await resolveSourceWithTier(engine, null, root);
        return { ...resolved, federated: await localFederatedSourceIds(engine, resolved.source_id, resolved.tier) };
      };
      await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
        const live = await resolveScope();
        let snapshot: unknown;
        const records = await traced(async () => { snapshot = await withRequestConfigSnapshot(engine, resolveScope); });
        expect(live.source_id).toBe(defaultPages ? 'default' : 'source-a');
        expect(snapshot).toEqual(live);
        expect(records.map(r => r.depth)).toEqual(records.map(() => 1));
      });
    });
  }

  test('an env-bound source is checked against the request\'s rows, not by its own read', async () => {
    const bind = async () => {
      const resolved = await resolveSourceWithTier(engine, null, root, { env: 'source-a' });
      return { ...resolved, binding: await explicitReadBinding(engine, resolved.source_id, resolved.tier) };
    };
    const live = await bind();
    let snapshot: unknown;
    const records = await traced(async () => { snapshot = await withRequestConfigSnapshot(engine, bind); });
    expect(snapshot).toEqual(live);
    expect(records.map(r => r.depth)).toEqual([1]);
    await expect(withRequestConfigSnapshot(engine, () => resolveSourceWithTier(engine, null, root, { env: 'source-missing' }))).rejects.toThrow(/not found or is archived/);
  });
});

describe('MCP hot-memory hook', () => {
  test('runs beside a read op and reads the withdrawal watermark and the trust generation together', async () => {
    const call = () => dispatchToolCall(engine, 'search', { query: 'alpha' }, { remote: true, sourceId: 'default', transport: 'stdio', metaHook: getBrainHotMemoryMeta });
    await call();
    __resetHotMemoryCacheForTests();
    const records = await traced(call);
    const withdrawals = records.find(r => WITHDRAWALS.test(r.sql))!;
    const generation = records.find(r => GENERATION.test(r.sql))!;
    const search = records.find(r => SEARCH.test(r.sql))!;
    expect(generation.depth).toBe(withdrawals.depth);
    expect(withdrawals.depth).toBeLessThanOrEqual(search.depth);
  });
});

describe('MCP stdio warm search (real startMcpServer)', () => {
  const REPO_ROOT = resolve(import.meta.dir, '..');
  const DRIVER = join(REPO_ROOT, 'test', 'fixtures', 'mcp-stdio-round-trip-driver.ts');
  const CHILD_STRIP = ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'GBRAIN_SURFACE', 'GBRAIN_MCP_FORCE_SURFACE', 'GBRAIN_MCP_INSTRUCTIONS'];

  test('resolves its source and reads config in one round trip; the hook runs beside the op', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-stdio-round-trips-'));
    const log = join(parent, 'statements.ndjson');
    writeFileSync(log, '');
    mkdirSync(join(parent, '.gbrain'), { recursive: true });
    writeFileSync(join(parent, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(parent, 'db'), embedding_dimensions: 1536 }));
    const env = { ...process.env } as Record<string, string>;
    for (const k of CHILD_STRIP) delete env[k];
    Object.assign(env, { GBRAIN_HOME: parent, HOME: parent, GBRAIN_SWEEP: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SERVE_SYNC_IPC: '0', ROUND_TRIP_LOG: log });
    const proc = Bun.spawn([process.execPath, DRIVER], { cwd: parent, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const responses = new Map<number, unknown>();
    const reader = (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (typeof msg.id === 'number') responses.set(msg.id, msg.result ?? msg.error);
        }
      }
    })();
    const send = (msg: unknown) => { proc.stdin.write(JSON.stringify(msg) + '\n'); proc.stdin.flush(); };
    const waitFor = async (id: number) => {
      const deadline = Date.now() + 60_000;
      while (!responses.has(id)) {
        if (proc.exitCode !== null) throw new Error(`driver exited ${proc.exitCode}: ${await new Response(proc.stderr).text()}`);
        if (Date.now() > deadline) throw new Error(`no response ${id}`);
        await Bun.sleep(10);
      }
      return responses.get(id);
    };
    const logged = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as DepthRecord);
    const searchCall = (id: number) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: { query: 'alpha' } } });
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'round-trips', version: '0' } } });
      await waitFor(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      searchCall(2);
      await waitFor(2);
      await Bun.sleep(500);
      const before = logged().length;
      searchCall(3);
      const result = await waitFor(3) as { isError?: boolean };
      await Bun.sleep(200);
      const call = logged().slice(before);
      const base = call[0]!.depth - 1;
      const records = call.map(r => ({ ...r, depth: r.depth - base }));
      expect(result.isError).toBeFalsy();
      const { resolution, op } = resolutionThenOp(records);
      expect(resolution.length).toBeGreaterThanOrEqual(2);
      expect(resolution.map(r => r.depth)).toEqual(resolution.map(() => 1));
      expect(op.depth).toBe(2);
      const withdrawals = records.find(r => WITHDRAWALS.test(r.sql));
      const generation = records.find(r => GENERATION.test(r.sql));
      const search = records.find(r => SEARCH.test(r.sql))!;
      expect(withdrawals?.depth).toBe(generation?.depth);
      expect(withdrawals!.depth).toBeLessThanOrEqual(search.depth);
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
      await reader.catch(() => {});
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
