/**
 * A first local writer registration records its database row before it publishes the credential file. A registration
 * that stops between the two steps (a crash, or a `gbrain serve` whose stdin closed mid-startup) must leave no
 * credential file that names a missing row: such a file reads as revoked (permission_denied) and tells the user to
 * replace a registration that never existed. With the row first, it reads as not registered, and the next
 * registration completes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistenceHome, readLocalWriter, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const homes: string[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'gb-row-first-')); homes.push(dir); return dir; };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

/** The engine whose registration insert never lands: the process stops before the row is written. */
function stopsBeforeTheRow(): BrainEngine {
  return {
    readPersistenceBrainId: () => engine.readPersistenceBrainId(),
    readLocalWriterRow: (id: string, opts?: { lock?: boolean }) => engine.readLocalWriterRow(id, opts),
    insertLocalWriterRow: async () => { throw new Error('stopped before the row'); },
  } as unknown as BrainEngine;
}

async function code(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; }
}

describe('a first local writer registration', () => {
  test('that stops before its row leaves no credential file, so the brain reads as not registered and the next registration completes', () =>
    withEnv({ GBRAIN_HOME: home() }, async () => {
      const brain = await engine.readPersistenceBrainId();
      const file = join(persistenceHome(), `${brain}.cli.json`);
      expect(await code(() => registerLocalWriter(stopsBeforeTheRow(), 'cli'))).toBe('stopped before the row');
      expect({ file: existsSync(file), read: await code(() => readLocalWriter(engine, 'cli')) })
        .toEqual({ file: false, read: 'writer_registration_required' });
      const registered = await registerLocalWriter(engine, 'cli');
      expect({ file: existsSync(file), read: (await readLocalWriter(engine, 'cli')).id }).toEqual({ file: true, read: registered.id });
    }));

  test('run twice at once ends with one credential file, and its row authorizes it', () =>
    withEnv({ GBRAIN_HOME: home() }, async () => {
      const [a, b] = await Promise.all([registerLocalWriter(engine, 'stdio'), registerLocalWriter(engine, 'stdio')]);
      expect(a.id).toBe(b.id);
      expect((await readLocalWriter(engine, 'stdio')).id).toBe(a.id);
    }));
});
