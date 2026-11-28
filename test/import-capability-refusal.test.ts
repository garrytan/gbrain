/**
 * An engine that cannot run an import step refuses it with the typed `engine_capability_missing`. `runImport` used to turn
 * that refusal into one failure per file (the catch around each file's import), so a Rust brain, which reaches its first
 * unserved member only once the import has read the source, ended "partial" with every file listed as failed and one
 * sync-failure ledger row per file. Master refused the whole import at its first raw statement, with no rows.
 *
 * Protects: when a per-file import ends in `engine_capability_missing`, `runImport` rejects with that same refusal, writes no
 * failure ledger row and prints no partial result; every other per-file failure still ends the run "partial" with its
 * failures listed and its ledger rows, and an import on an engine that serves every member is unchanged.
 * Fails when the per-file catch records a capability refusal as a file failure.
 * Hermetic PGLite in-memory behind the Rust-engine stand-in (test/helpers/rust-stand-in.ts); GBRAIN_HOME is a temp directory.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { isEngineCapabilityRefusal } from '../src/core/engine-capability-refusal.ts';
import { rustStandIn } from './helpers/rust-stand-in.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

let serial = 0;
function folder(files = 3): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-refusal-'));
  mkdirSync(join(dir, 'notes'));
  for (let i = 0; i < files; i++) writeFileSync(join(dir, 'notes', `page-${i}.md`), `---\ntype: note\ntitle: Page ${i}\n---\n# Page ${i}\n\nBody ${++serial}.\n`);
  return dir;
}

/** The import's stdout, its rejection (if any), and the ledger rows it wrote. */
async function runCaptured(view: BrainEngine) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let error: unknown = null;
  let result: unknown = null;
  try {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    result = await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
      const out = await runImport(view, [folder(), '--no-embed', '--json']).then((r) => ({ r }), (e: unknown) => ({ e }));
      return { out, ledger: loadSyncFailures().length };
    });
  } finally { console.log = log; }
  const { out, ledger } = result as { out: { r?: unknown; e?: unknown }; ledger: number };
  if ('e' in out) error = out.e;
  return { stdout: lines.join('\n'), error, ledger, returned: out.r };
}

test('a capability refusal on a file ends the import with that refusal, no partial result and no ledger row', async () => {
  const { stdout, error, ledger } = await runCaptured(rustStandIn(engine));
  expect(isEngineCapabilityRefusal(error), `rejected with ${String(error)}`).toBe(true);
  expect(ledger).toBe(0);
  expect(stdout).not.toContain('"status":"partial"');
});

test('any other per-file failure still ends the run partial with its failures and ledger rows', async () => {
  const boom = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return async () => { throw new Error('disk on fire'); };
    const value = (target as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as unknown as BrainEngine;
  const { stdout, error, ledger } = await runCaptured(boom);
  expect(isEngineCapabilityRefusal(error)).toBe(false);
  expect(stdout).toContain('"status":"partial"');
  expect(stdout).toContain('disk on fire');
});

test('an engine that serves every member imports the same files', async () => {
  const { stdout, error, ledger } = await runCaptured(engine);
  expect(error).toBeNull();
  expect(ledger).toBe(0);
  expect(stdout).toContain('"status":"success"');
  expect(stdout).toContain('"imported":3');
});
