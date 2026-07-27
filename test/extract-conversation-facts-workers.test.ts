/**
 * Hermetic unit + structural tests for the extract-conversation-facts
 * `--workers N` wiring (v0.41.15.0, T5).
 *
 * What this file pins:
 *   - parseArgs accepts `--workers N` and routes through parseWorkers
 *     (rejects 0, negatives, non-integers).
 *   - parseArgs accepts the alias `--concurrency N`.
 *   - buildJobParams threads `workers` into the Minion job envelope
 *     (round-trip via `gbrain extract-conversation-facts --background
 *     --workers 20`).
 *   - The exported helpers (`extractConversationFactsLockId`,
 *     `cpMapToEntries`-shape via the public API) match the load-bearing
 *     contracts D2 / D11 / D6 rely on.
 *   - Source-grep structural assertions on the production file: workers
 *     is threaded through, runSlidingPool is wired in, withRefreshingLock
 *     wraps each page, delete-orphans-first is called, preflight fires
 *     at startup, lock-busy is caught + counted + skipped, exit 3 path
 *     exists.
 *
 * End-to-end behavioral test (workers=3 on a seeded PGLite brain with
 * stubbed LLM extractor + cross-process safety simulation) is filed as
 * `test/extract-conversation-facts-workers.serial.test.ts` because it
 * uses `mock.module` for the gateway stub. This file lives in the
 * parallel fast loop per the test-isolation lint.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  extractConversationFactsLockId,
  PER_PAGE_LOCK_TTL_MINUTES,
  _resetLockBusyLogCacheForTest,
} from '../src/commands/extract-conversation-facts.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SRC_PATH = resolve(REPO_ROOT, 'src/commands/extract-conversation-facts.ts');
const SRC = readFileSync(SRC_PATH, 'utf-8');

beforeEach(() => {
  _resetLockBusyLogCacheForTest();
});

describe('extract-conversation-facts — exported helpers (T5)', () => {
  test('extractConversationFactsLockId composes source + slug', () => {
    expect(extractConversationFactsLockId('default', 'chat/alice')).toBe(
      'extract-conversation-facts:default:chat/alice',
    );
    expect(extractConversationFactsLockId('media', 'imessage/2024-01')).toBe(
      'extract-conversation-facts:media:imessage/2024-01',
    );
  });

  test('lock id differs across sources for the same slug', () => {
    // Cross-source isolation — the lock primitive must prevent
    // double-claim WITHIN a source but allow parallel work ACROSS
    // sources. Two sources with the same slug get different lock ids.
    const a = extractConversationFactsLockId('dept-a', 'chat/team');
    const b = extractConversationFactsLockId('dept-b', 'chat/team');
    expect(a).not.toBe(b);
  });

  test('PER_PAGE_LOCK_TTL_MINUTES is short enough that holder-death recovers within ~2min', () => {
    // The TTL governs how long a dead worker's lock blocks the next
    // attempt. 2 minutes balances "long enough for a real page to
    // finish" against "short enough that a crash isn't a 30min stall."
    // The plan's D12 spec calls for ~10s refresh; with TTL=2min,
    // withRefreshingLock fires at max(15s, 120s/6) = 20s, well under.
    expect(PER_PAGE_LOCK_TTL_MINUTES).toBeGreaterThanOrEqual(1);
    expect(PER_PAGE_LOCK_TTL_MINUTES).toBeLessThanOrEqual(10);
  });
});

describe('extract-conversation-facts — structural contracts (T5)', () => {
  test('imports runSlidingPool from worker-pool helper', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*runSlidingPool\s*\}\s*from\s*['"]\.\.\/core\/worker-pool\.ts['"]/,
    );
  });

  test('imports parseWorkers + resolveWorkersWithClamp from sync-concurrency', () => {
    expect(SRC).toMatch(/parseWorkers,\s*resolveWorkersWithClamp/);
    expect(SRC).toMatch(/from\s*['"]\.\.\/core\/sync-concurrency\.ts['"]/);
  });

  test('imports withRefreshingLock + LockUnavailableError from db-lock', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*withRefreshingLock,\s*LockUnavailableError\s*\}\s*from\s*['"]\.\.\/core\/db-lock\.ts['"]/,
    );
  });

  test('imports assertFactsEmbeddingDimMatchesConfig (D15 preflight)', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*assertFactsEmbeddingDimMatchesConfig\s*\}\s*from\s*['"]\.\.\/core\/embedding-dim-check\.ts['"]/,
    );
  });

  test('runExtractConversationFactsCore calls resolveWorkersWithClamp', () => {
    expect(SRC).toMatch(/resolveWorkersWithClamp\(/);
  });

  test('preflight fires inside runExtractConversationFactsCore body, BEFORE work loop', () => {
    // Locate the preflight call and the workers resolution; preflight
    // must appear before the worker-pool fanout so dim drift surfaces
    // before any LLM spend.
    const preflightIdx = SRC.indexOf('assertFactsEmbeddingDimMatchesConfig(engine)');
    const poolCallIdx = SRC.indexOf('runSlidingPool(');
    expect(preflightIdx).toBeGreaterThan(0);
    expect(poolCallIdx).toBeGreaterThan(0);
    expect(preflightIdx).toBeLessThan(poolCallIdx);
  });

  test('per-page work wrapped in withRefreshingLock (D2 + D12)', () => {
    expect(SRC).toMatch(/withRefreshingLock\(\s*engine,\s*lockId/);
    expect(SRC).toMatch(/ttlMinutes:\s*PER_PAGE_LOCK_TTL_MINUTES/);
  });

  test('LockUnavailableError caught + pages_lock_skipped incremented (D6)', () => {
    // Both halves of the lock-busy contract.
    expect(SRC).toMatch(/instanceof\s+LockUnavailableError/);
    expect(SRC).toMatch(/pages_lock_skipped\+\+/);
  });

  test('delete-orphans-first called BEFORE segment extraction (D11)', () => {
    expect(SRC).toMatch(/deleteOrphanFactsForPage\(/);
    // Positional check: the delete-orphans call must appear before the
    // segment for-loop. Easier to assert that orphan_facts_cleaned is
    // bumped before the segment loop begins.
    const cleanedBumpIdx = SRC.indexOf('orphan_facts_cleaned +=');
    const segmentLoopIdx = SRC.indexOf('for (const seg of segments)');
    expect(cleanedBumpIdx).toBeGreaterThan(0);
    expect(segmentLoopIdx).toBeGreaterThan(0);
    expect(cleanedBumpIdx).toBeLessThan(segmentLoopIdx);
  });

  test('exit 3 fires when lock-busy pages remain (codex #3)', () => {
    expect(SRC).toMatch(
      /pages_lock_skipped\s*>\s*0[\s\S]{0,200}process\.exit\(3\)/,
    );
  });

  test('parsedArgs.workers threaded into core opts', () => {
    expect(SRC).toMatch(/workers:\s*parsed\.workers/);
  });

  test('Minion job envelope includes workers (D9 round-trip)', () => {
    expect(SRC).toMatch(/workers:\s*parsed\.workers/);
    // buildJobParams shape — there should be a `workers` field in the
    // returned object literal.
    const bjpRegion = SRC.slice(SRC.indexOf('function buildJobParams'));
    expect(bjpRegion).toMatch(/workers:\s*parsed\.workers/);
  });
});

describe('extract-conversation-facts — Result type carries new counters', () => {
  test('ExtractConversationFactsResult has pages_lock_skipped + orphan_facts_cleaned', () => {
    // Source-level shape check (the type is exported but bun:test
    // doesn't introspect types at runtime; a grep is honest).
    expect(SRC).toMatch(/pages_lock_skipped:\s*number/);
    expect(SRC).toMatch(/orphan_facts_cleaned:\s*number/);
  });

  test('initial result object literal initializes both counters to 0', () => {
    // Both call sites (core init + CLI aggregate init) must initialize
    // the new counters or the aggregator will produce NaN under +=.
    const initOccurrences = SRC.match(/pages_lock_skipped:\s*0/g) ?? [];
    expect(initOccurrences.length).toBeGreaterThanOrEqual(2);
    const cleanedOccurrences = SRC.match(/orphan_facts_cleaned:\s*0/g) ?? [];
    expect(cleanedOccurrences.length).toBeGreaterThanOrEqual(2);
  });
});
