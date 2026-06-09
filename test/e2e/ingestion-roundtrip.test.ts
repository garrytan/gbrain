/**
 * E2E roundtrip for the v0.38 ingestion substrate.
 *
 * Wires the daemon + inbox-folder source + dispatcher together against
 * an in-memory PGLite (no DATABASE_URL needed) and verifies:
 *   1. A file dropped into the inbox dir produces an IngestionEvent
 *      that flows through the daemon's validate → dedup → rate-limit
 *      → dispatch pipeline.
 *   2. The dispatched event reaches the ingest_capture Minion handler.
 *   3. The handler routes through importFromContent and lands a page
 *      in the DB with the expected slug + content.
 *   4. The page is queryable by content via getPage.
 *   5. Dedup catches a repeat-drop of the same file content within the
 *      24h window.
 *
 * This is the substrate-level e2e — it's the unit-test concept lifted
 * one layer up to the daemon+handler wiring. The full server-process
 * e2e (gbrain serve --http + POST /ingest + real OAuth) is a separate
 * test that requires DATABASE_URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { IngestionDaemon } from '../../src/core/ingestion/daemon.ts';
import { createInboxFolderSource } from '../../src/core/ingestion/sources/inbox-folder.ts';
import { watch, type ChokidarOptions, type FSWatcher } from 'chokidar';

// E2E determinism: force chokidar into polling mode via the source's
// `_watchFactory` seam so file-drop detection never depends on macOS fsevents
// timing. The native-events path occasionally missed the first add under load,
// timing out the 15s waitFor (the documented first-drop flake). Polling at a
// 20ms interval is deterministic and still fast. Production keeps native events.
const pollingWatchFactory = (paths: string, opts: ChokidarOptions): FSWatcher =>
  watch(paths, { ...opts, usePolling: true, interval: 20, binaryInterval: 20 });
import { makeIngestCaptureHandler } from '../../src/core/minions/handlers/ingest-capture.ts';
import type { IngestionEvent } from '../../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';

// Fake job-context constructor so we can drive the handler directly
// from the dispatcher without spinning up a Minion worker.
function makeFakeJobCtx(data: Record<string, unknown>): MinionJobContext {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    name: 'ingest_capture',
    data,
    attempts_made: 1,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

let engine: PGLiteEngine;
let tmpRoot: string;
let inboxDir: string;
let brainDir: string;

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
  // 200ms grace period for the previous test's chokidar watchers to fully
  // release OS-level FSEvents handles on macOS. Without this, the second
  // test's watcher events queue behind the first test's pending cleanup
  // and the waitFor(15s) for the first file drop times out. See
  // ingestion-roundtrip cross-test contamination notes.
  await new Promise((r) => setTimeout(r, 200));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-e2e-roundtrip-'));
  inboxDir = path.join(tmpRoot, 'inbox');
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const captureLogger = () => {
  const messages: Array<{ level: string; msg: string }> = [];
  return {
    logger: {
      info: (msg: string) => { messages.push({ level: 'info', msg }); },
      warn: (msg: string) => { messages.push({ level: 'warn', msg }); },
      error: (msg: string) => { messages.push({ level: 'error', msg }); },
    },
    messages,
  };
};

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

describe('ingestion roundtrip — inbox-folder → daemon → ingest_capture → DB', () => {
  test('full pipeline: file drop → page in DB', async () => {
    const { logger } = captureLogger();
    const handler = makeIngestCaptureHandler(engine);
    const dispatchedEvents: IngestionEvent[] = [];

    const daemon = new IngestionDaemon({
      engine,
      logger,
      dispatch: async (event) => {
        dispatchedEvents.push(event);
        // Route the event into the handler directly. In production the
        // daemon would submit a Minion job and the worker would invoke
        // the handler; here we collapse that for test-loop efficiency.
        await handler(makeFakeJobCtx({ event }));
        return { kind: 'queued' };
      },
    });

    // Create the inbox dir BEFORE starting the watcher to eliminate a race
    // where chokidar hasn't attached yet when the first write fires (the
    // 6s→15s waitFor flake on the source.) Without this, the test relies on
    // chokidar's polling fallback to notice the dir, which is timing-dependent.
    fs.mkdirSync(inboxDir, { recursive: true });

    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 50,
      awaitStabilityMs: 100,
      _watchFactory: pollingWatchFactory,
    });
    daemon.register({ source });

    // Drop the file BEFORE start so the initial scan (ignoreInitial:false)
    // emits it deterministically. The full emit → dispatch → handler → DB →
    // archive pipeline still runs end to end; only the inherently timing-
    // dependent post-start watcher detection is removed (covered robustly by
    // the dedup test's polled second drop below).
    const captured = path.join(inboxDir, 'roundtrip.md');
    fs.writeFileSync(captured, '---\ntitle: Roundtrip\n---\n\nfull e2e flow');

    await daemon.start();
    // Wait for the daemon to pick it up + dispatch + handler to write.
    await waitFor(() => dispatchedEvents.length === 1, 15000);

    // Page is in the DB.
    const page = await engine.getPage(dispatchedEvents[0]!.metadata!.slug as string ??
      `inbox/${new Date().toISOString().slice(0, 10)}-${dispatchedEvents[0]!.content_hash.slice(0, 6)}`);
    // The handler defaults to inbox/<date>-<hash6> if no slug provided by
    // the source. inbox-folder source doesn't set metadata.slug so the
    // handler computes the default.
    const expectedSlug = `inbox/${new Date().toISOString().slice(0, 10)}-${dispatchedEvents[0]!.content_hash.slice(0, 6)}`;
    const fetched = await engine.getPage(expectedSlug);
    expect(fetched).not.toBeNull();
    expect(fetched?.compiled_truth).toContain('full e2e flow');

    // File was archived after ingestion (the inbox-folder source's
    // post-emit archive step).
    expect(fs.existsSync(captured)).toBe(false);
    const archiveDate = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(inboxDir, '.archived', archiveDate, 'roundtrip.md'))).toBe(true);

    await daemon.stop();
  }, 15_000);

  test('repeat drop of same content dedups silently', async () => {
    const { logger } = captureLogger();
    const handler = makeIngestCaptureHandler(engine);
    const dispatchedEvents: IngestionEvent[] = [];

    const daemon = new IngestionDaemon({
      engine,
      logger,
      dispatch: async (event) => {
        dispatchedEvents.push(event);
        await handler(makeFakeJobCtx({ event }));
        return { kind: 'queued' };
      },
    });

    // mkdirSync BEFORE daemon.start to eliminate chokidar attach race.
    fs.mkdirSync(inboxDir, { recursive: true });

    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 50,
      awaitStabilityMs: 100,
      _watchFactory: pollingWatchFactory,
    });
    daemon.register({ source });

    // Drop file 1 BEFORE start so the initial scan (ignoreInitial:false) emits
    // it deterministically — removes the post-start watcher race that flaked.
    const drop1 = path.join(inboxDir, 'dup-1.md');
    fs.writeFileSync(drop1, '# duplicate content\n\nidentical body');

    await daemon.start();
    await waitFor(() => dispatchedEvents.length === 1, 15000);

    // Drop file 2 with byte-identical content (different filename) AFTER start;
    // the watcher catches it and dedup intercepts before dispatch.
    const drop2 = path.join(inboxDir, 'dup-2.md');
    fs.writeFileSync(drop2, '# duplicate content\n\nidentical body');

    // Poll for the dedup hit instead of a fixed sleep so a slow watcher tick
    // can't make the assertion flake.
    let dedupHits = 0;
    for (let i = 0; i < 240; i++) {
      dedupHits = (await daemon.healthCheck()).dedup.hits;
      if (dedupHits >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // Only ONE event made it through dispatch (dedup intercepted the second).
    expect(dispatchedEvents).toHaveLength(1);
    // The daemon's dedup stats reflect a hit.
    expect(dedupHits).toBeGreaterThanOrEqual(1);

    await daemon.stop();
  }, 15_000);
});

describe('ingestion roundtrip — multi-source coordination', () => {
  test('two sources see different content; daemon ingests both', async () => {
    const { logger } = captureLogger();
    const handler = makeIngestCaptureHandler(engine);
    const dispatchedEvents: IngestionEvent[] = [];

    const daemon = new IngestionDaemon({
      engine,
      logger,
      dispatch: async (event) => {
        dispatchedEvents.push(event);
        await handler(makeFakeJobCtx({ event }));
        return { kind: 'queued' };
      },
    });

    // Two distinct inbox dirs, two sources. Create the dirs BEFORE
    // daemon.start to eliminate the chokidar attach race (same fix as
    // the single-source tests above).
    const inboxA = path.join(tmpRoot, 'inbox-a');
    const inboxB = path.join(tmpRoot, 'inbox-b');
    fs.mkdirSync(inboxA, { recursive: true });
    fs.mkdirSync(inboxB, { recursive: true });
    const sourceA = createInboxFolderSource({
      id: 'inbox-a',
      inboxDir: inboxA,
      debounceMs: 50,
      awaitStabilityMs: 100,
      _watchFactory: pollingWatchFactory,
    });
    const sourceB = createInboxFolderSource({
      id: 'inbox-b',
      inboxDir: inboxB,
      debounceMs: 50,
      awaitStabilityMs: 100,
      _watchFactory: pollingWatchFactory,
    });
    daemon.register({ source: sourceA });
    daemon.register({ source: sourceB });

    // Drop both files BEFORE start. With ignoreInitial:false the initial scan
    // emits an `add` for each on chokidar `ready`, so both sources ingest
    // deterministically — no dependency on the post-start watcher catching a
    // freshly written file (the source of the residual flake).
    fs.writeFileSync(path.join(inboxA, 'from-a.md'), 'content from A');
    fs.writeFileSync(path.join(inboxB, 'from-b.md'), 'content from B');

    await daemon.start();

    await waitFor(() => dispatchedEvents.length === 2, 15000);

    const fromA = dispatchedEvents.find((e) => e.source_id === 'inbox-a');
    const fromB = dispatchedEvents.find((e) => e.source_id === 'inbox-b');
    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();
    expect(fromA?.content).toContain('content from A');
    expect(fromB?.content).toContain('content from B');

    await daemon.stop();
  }, 15_000);
});
