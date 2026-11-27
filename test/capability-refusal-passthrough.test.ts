/**
 * A brain whose engine refuses a call (`engine_capability_missing`, the Rust
 * engine before it serves a capability) must refuse the command, never print an
 * empty or partial answer. Each fail-soft read below rethrows the refusal and
 * keeps its old behavior for every other error, so PGLite and Postgres answer as
 * before. Synthetic names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { seedPage } from './helpers/keyword-paging-fixture.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { assertGraduationConnectAllowed } from '../src/core/persistence/graduation-custody.ts';
import { readGraduationConnectRow } from '../src/core/persistence/graduation-schema.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { findExperts, runWhoknows } from '../src/commands/whoknows.ts';
import { runExtract } from '../src/commands/extract.ts';
import type { Capability } from '../src/core/engine-capabilities.ts';
import { setStdoutCapture } from '../src/core/cli-force-exit.ts';
import { readGraduationGateRow as rustReadGraduationGateRow } from '../src/core/rust-engine/store-members/connect-gate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedPage(engine, 'people/alice-example', 'Alice Example works on keyword ranking.', { type: 'person', title: 'Alice Example' });
});

/** The PGLite engine with `member` replaced by a thrower: a capability refusal, or a plain failure for the control. */
function failing(member: keyof BrainEngine, capability: Capability, kind: 'refusal' | 'plain'): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === member) {
        return async () => {
          throw kind === 'refusal' ? capabilityMissing(capability, String(member)) : new Error(`${String(member)} failed`);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

/** The refusal's code survives, so `--json` output carries it. */
const isCapabilityMissing = (e: unknown) => (e as { code?: unknown } | null)?.code === 'engine_capability_missing';

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a capability refusal, got an answer');
}

describe('the graduation connect gate', () => {
  test('an engine without raw SQL reads as no custody row and never calls executeRaw', async () => {
    let calls = 0;
    const rust = {
      kind: 'rust',
      capabilities: new Set<Capability>(),
      // The Rust engine's own member: it keeps no custody row, so it answers null without raw SQL.
      readGraduationGateRow: rustReadGraduationGateRow,
      executeRaw: async () => { calls++; throw capabilityMissing('raw_sql', 'executeRaw'); },
    } as unknown as BrainEngine;
    expect(await readGraduationConnectRow(rust)).toBeNull();
    await expect(assertGraduationConnectAllowed(rust, {})).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  test('any custody read failure other than a missing table still throws', async () => {
    const denied = {
      capabilities: new Set<Capability>(['raw_sql']),
      readGraduationGateRow: async () => { throw Object.assign(new Error('permission denied for table persistence_graduation'), { code: '42501' }); },
    } as unknown as BrainEngine;
    await expect(assertGraduationConnectAllowed(denied, {})).rejects.toThrow(/permission denied/);
  });
});

describe('query (hybrid search lexical arms)', () => {
  test('a refused keyword arm refuses the search', async () => {
    const e = await refusalOf(hybridSearch(failing('searchKeyword', 'keyword_search', 'refusal'), 'keyword ranking', { limit: 5, useCache: false }));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('a refused title arm refuses the search', async () => {
    const e = await refusalOf(hybridSearch(failing('searchTitles', 'keyword_search', 'refusal'), 'keyword ranking', { limit: 5, useCache: false }));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('any other keyword-arm failure still fails open', async () => {
    const rows = await hybridSearch(failing('searchKeyword', 'keyword_search', 'plain'), 'keyword ranking', { limit: 5, useCache: false });
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('entity', () => {
  const card = (e: BrainEngine) => buildEntityCard(e, 'default', 'Alice Example', { remote: false, includeReferences: true, variants: true });

  test('a refused alias lookup refuses the card instead of printing found:false', async () => {
    const e = await refusalOf(card(failing('resolveAliases', 'pages', 'refusal')));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('a refused exact-match read refuses the card', async () => {
    const e = await refusalOf(card(failing('executeRaw', 'raw_sql', 'refusal')));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('a refused text-mention probe refuses a miss instead of printing unread: read_failed', async () => {
    const e = await refusalOf(buildEntityCard(failing('searchKeyword', 'keyword_search', 'refusal'), 'default', 'Imogen Nobody', { remote: false, includeReferences: true }));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('any other alias failure still degrades to the exact-match arm', async () => {
    const res = await card(failing('resolveAliases', 'pages', 'plain'));
    expect(res.found).toBe(true);
  });
});

describe('whoknows', () => {
  test('a refused pack read refuses the command instead of printing []', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const e = await refusalOf(runWhoknows(failing('getConfig', 'config', 'refusal'), ['keyword', '--json']));
      expect(isCapabilityMissing(e)).toBe(true);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test('a refused salience read refuses the ranking', async () => {
    const e = await refusalOf(findExperts(failing('getSalienceScores', 'pages', 'refusal'), { topic: 'keyword ranking', types: ['person'] }));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('any other salience failure still ranks without it', async () => {
    const rows = await findExperts(failing('getSalienceScores', 'pages', 'plain'), { topic: 'keyword ranking', types: ['person'] });
    expect(rows.map(r => r.slug)).toContain('people/alice-example');
  });
});

describe('extract --json', () => {
  class Exit extends Error { constructor(public code: number | undefined) { super(`exit ${code}`); } }

  async function run(e: BrainEngine): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
    const out = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as never);
    const err = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as never);
    const cerr = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr += `${a.join(' ')}\n`; });
    setStdoutCapture((text) => { stdout += text; });
    try {
      await runExtract(e, ['all', '--source', 'db', '--json']);
      return { code: undefined, stdout, stderr };
    } catch (x) {
      if (x instanceof Exit) return { code: x.code, stdout, stderr };
      throw x;
    } finally {
      setStdoutCapture(null);
      exit.mockRestore(); out.mockRestore(); err.mockRestore(); cerr.mockRestore();
    }
  }

  test('a refusal prints as the JSON refusal document with its code', async () => {
    const r = await run(failing('getConfig', 'config', 'refusal'));
    expect(r.code).not.toBe(0);
    expect(r.code).toBeDefined();
    const doc = JSON.parse(r.stdout.trim()) as { code: string; reason: string };
    expect(doc.code).toBe('engine_capability_missing');
    expect(doc.reason).toBe('config');
    expect(r.stderr).not.toContain('migrations_pending');
  });

  test('any other failure keeps the plain message and exit 1', async () => {
    const r = await run(failing('getConfig', 'config', 'plain'));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('getConfig failed');
  });
});
