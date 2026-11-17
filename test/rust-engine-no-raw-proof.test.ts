/**
 * Rust engine Track 2 (docs/designs/RUST_ENGINE.md, D6): the no-raw proof for
 * the scope B paths. A Rust engine serves typed methods only, so every raw SQL
 * seam a default path still reaches is a site the Rust engine cannot serve.
 *
 * Protects: the default import (new page, changed body, unchanged re-import,
 * reordered sections, moved file path), hybrid search (keyless, and with a
 * vector transport) and the import cycle lock (acquire, refresh, release,
 * inspect, reap, and the source filesystem lock) reach the raw seams (`executeRaw`, `executeRawDirect`,
 * `withReservedConnection`) only from the call sites listed in
 * REMAINING_RAW_SITES. Each listed site is a known, recorded follow-up.
 * Fails when: a scope B call site that moved behind a typed engine method
 * (search reads, import writes, import guards, cycle lock) goes back to raw SQL, or a new
 * raw call site appears on these paths.
 * Seams: the engine is wrapped in a Proxy that records the first non-engine
 * caller frame of every raw call. A raw call made while an engine method runs
 * (directly, or through a shared helper the method hands itself to, such as
 * search/read-enrichment.ts) is the engine's own implementation and is
 * labelled engine-internal (tracked with AsyncLocalStorage, so concurrent
 * caller code is not mislabelled); `transaction` passes a wrapped tx engine so raw calls in a
 * transaction are recorded too. PGLite only: the sites are engine-independent
 * caller code.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { inspectLocks, listStaleLocks, reapDeadHolderLocks, withRefreshingLock } from '../src/core/db-lock.ts';
import { withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const RAW_SEAMS = new Set(['executeRaw', 'executeRawDirect', 'withReservedConnection']);
const ENGINE_FRAME = /src\/core\/(pglite-engine|postgres-engine|engine-sql\/)/;
const SKIP_FRAME = /node_modules|bun:|native|rust-engine-no-raw-proof/;

/**
 * Call sites on these paths that still use a raw seam (`file:function`). Each is a
 * known Track 2 follow-up; removing one from the code means removing it here.
 */
const REMAINING_RAW_SITES = new Set<string>([
  // The version-row write in the page-state commit (page-state/versions.ts); not in scope B.
  'src/core/page-state/versions.ts:<anonymous>',
  // The origin claim check runs in the caller's transaction before refreshPageOrigin; not moved in scope B.
  'src/core/persistence/origin-guard.ts:assertOriginUnclaimed',
  'src/core/persistence/origin-guard.ts:originScopeOf',
  // The source filesystem lock's legacy-writer guard (persistence/filesystem-guard.ts) reads the full persistence_brain
  // row; ten callers share that read, so it moves as one follow-up, not in scope B.
  'src/core/persistence/managed-mode.ts:readPersistenceBrain',
]);

function callerSite(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(2);
  for (const line of lines) {
    const m = line.match(/at (?:async )?([^\s(]+)? ?\(?(\/[^):]+):\d+:\d+\)?/);
    if (!m) continue;
    const [, fn, file] = m;
    if (SKIP_FRAME.test(file)) continue;
    if (ENGINE_FRAME.test(file)) return '<engine-internal>';
    return `${file.replace(/^.*?\/src\//, 'src/')}:${fn ?? '<anonymous>'}`;
  }
  return '<engine-internal>';
}

/** Set while an engine method runs: its raw calls (directly or through a helper it hands itself to) are the engine's own. */
const insideEngine = new AsyncLocalStorage<string | false>();

function recording(engine: BrainEngine, sites: string[], methods: Set<string> = new Set()): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop === 'string' && RAW_SEAMS.has(prop)) {
        return (...args: unknown[]) => {
          const inside = insideEngine.getStore();
          sites.push(`${prop} ${inside ? `<engine-internal:${inside}>` : callerSite()}`);
          return (value as (...a: unknown[]) => unknown).apply(receiver, args);
        };
      }
      if (prop === 'transaction') {
        return (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) =>
          insideEngine.run('transaction', () => (value as (f: unknown, o?: unknown) => Promise<unknown>).call(receiver,
            // The callback is caller code again.
            (tx: BrainEngine) => insideEngine.run(false, () => fn(tx === receiver ? tx : recording(tx, sites, methods))), opts));
      }
      // `this` is the proxy, so an engine method that hands itself to a helper (helper(this, ...)) is labelled engine-internal.
      // A callback argument (withReservedConnection, a lock or maintenance wrapper) is caller code again.
      if (typeof prop === 'string') methods.add(prop);
      return (...args: unknown[]) => insideEngine.run(String(prop), () => (value as (...a: unknown[]) => unknown).apply(receiver,
        args.map(a => typeof a === 'function' ? (...cb: unknown[]) => insideEngine.run(false, () => (a as (...x: unknown[]) => unknown)(...cb)) : a)));
    },
  });
}

const BODY = (extra: string) => `---\ntype: note\ntitle: Proof Note\n---\n# Alpha\n\nAlpha section about widgets and gears. ${extra}\n\n# Beta\n\nBeta section about sprockets.\n`;
const REORDERED = `---\ntype: note\ntitle: Proof Note\n---\n# Beta\n\nBeta section about sprockets.\n\n# Alpha\n\nAlpha section about widgets and gears. changed\n`;

describe('Rust engine Track 2: scope B default paths reach raw SQL only from recorded sites', () => {
  let base: PGLiteEngine;

  beforeAll(async () => {
    base = new PGLiteEngine();
    await base.connect({});
    await base.initSchema();
  }, 180_000);

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    await base.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(base);
    __setEmbedTransportForTests(null);
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
  });

  async function trace(run: (engine: BrainEngine) => Promise<unknown>, methods = new Set<string>()): Promise<string[]> {
    const sites: string[] = [];
    await run(recording(base, sites, methods));
    return [...new Set(sites)].sort();
  }

  /** Caller sites not on the recorded list. An engine-internal raw call is the engine's own implementation of a typed method. */
  function unexpected(sites: string[]): string[] {
    return sites.map(s => s.slice(s.indexOf(' ') + 1)).filter(s => !s.startsWith('<engine-internal') && !REMAINING_RAW_SITES.has(s));
  }

  test('import: new page, changed body, unchanged re-import, reordered sections, moved path', async () => {
    const methods = new Set<string>();
    const sites = await trace(async (engine) => {
      await importFromContent(engine, 'notes/proof', BODY('first'), { noEmbed: true, sourcePath: 'notes/proof.md' } as never);
      await importFromContent(engine, 'notes/proof', BODY('changed'), { noEmbed: true, sourcePath: 'notes/proof.md' } as never);
      await importFromContent(engine, 'notes/proof', BODY('changed'), { noEmbed: true, sourcePath: 'notes/proof.md' } as never);
      await importFromContent(engine, 'notes/proof', REORDERED, { noEmbed: true, sourcePath: 'notes/proof.md' } as never);
      await importFromContent(engine, 'notes/proof', REORDERED, { noEmbed: true, sourcePath: 'archive/proof.md' } as never);
    }, methods);
    console.log(`[no-raw-proof] import sites:\n${sites.join('\n')}\n[no-raw-proof] import methods: ${[...methods].sort().join(' ')}`);
    expect(unexpected(sites)).toEqual([]);
    // The scope B typed methods this path now reaches instead of raw SQL.
    for (const m of ['addPageTagsById', 'applyTransactionSettings', 'getChunkReuseRows', 'getConfigValues', 'getPageSealState', 'getSource',
      'getSourceStrictness', 'moveChunkIndexes', 'pruneFrontmatterTags', 'readLedgerSource', 'readManagedModeRows', 'readPersistenceBrainId',
      'readTransactionSettings', 'refreshPageOrigin', 'replaceDerivedAliases', 'writeTextProjectionSeal']) expect(methods.has(m)).toBe(true);
  });

  test('hybrid search: keyless, then with a vector transport', async () => {
    await importFromContent(base, 'notes/widgets', BODY('widgets'), { noEmbed: true } as never);
    const methods = new Set<string>();
    const sites = await trace(async (engine) => {
      await hybridSearch(engine, 'widgets gears', { limit: 5 });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => [1, ...new Array(1535).fill(0)]),
      })) as never);
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
      await hybridSearch(engine, 'widgets gears', { limit: 5 });
    }, methods);
    console.log(`[no-raw-proof] search sites:\n${sites.join('\n')}\n[no-raw-proof] search methods: ${[...methods].sort().join(' ')}`);
    expect(unexpected(sites)).toEqual([]);
    for (const m of ['aliasCanonicalRefs', 'cosinesByChunkIds', 'generatedPagesIn', 'hasSupersedeEdges', 'pageCollapseFacts']) expect(methods.has(m)).toBe(true);
  });

  test('cycle lock: acquire, refresh, release, inspect, reap, source filesystem lock', async () => {
    const dir = mkdtempSync(join('/var/tmp', 'gbrain-no-raw-proof-'));
    const methods = new Set<string>();
    try {
      const sites = await trace(async (engine) => {
        // ttl 1 minute with a 50 ms refresh interval: the 200 ms work spans several refreshes.
        await withRefreshingLock(engine, 'gbrain-sync:proof', async () => { await new Promise(r => setTimeout(r, 200)); },
          { ttlMinutes: 1, refreshIntervalMs: 50 });
        await inspectLocks(engine, ['gbrain-sync:proof']);
        await listStaleLocks(engine);
        await reapDeadHolderLocks(engine);
        await withSourceFilesystemLock(engine, dir, async () => undefined);
      }, methods);
      console.log(`[no-raw-proof] cycle-lock sites:\n${sites.join('\n')}\n[no-raw-proof] cycle-lock methods: ${[...methods].sort().join(' ')}`);
      expect(unexpected(sites)).toEqual([]);
      for (const m of ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'listSourceLocalPaths']) expect(methods.has(m)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
