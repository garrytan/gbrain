/**
 * Disk-backed PGLite brains cloned from one initialized template per process.
 *
 * A fresh disk brain (`connect({ database_path }) + initSchema()`) replays
 * every migration (~3 s; the schema snapshot only serves in-memory engines).
 * A clone copies an initialized data directory and reopens it (~1 s).
 *
 * Contract:
 *   - One template per process and embedding shape, initialized into a
 *     private cache directory and disconnected before any copy.
 *   - The template is captured right after initSchema: no source
 *     registration, writer registration or physical-root reservation exists
 *     in it (asserted), and nothing outside the data directory is copied, so
 *     locks, reservations and runtime files never travel.
 *   - Each clone gets its own brain identity: brain_id, the default source
 *     incarnation, and the shared-skill token secret and serving epoch are
 *     regenerated. Host identity lives in the caller's GBRAIN_HOME.
 *
 * Use it for fixtures that need any initialized disk brain. Tests of
 * `foresights init` or migration behavior keep a real initSchema on an empty
 * directory.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEmbeddingDimensions, getEmbeddingModel } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const templates = new Map<string, Promise<string>>();

async function buildTemplate(): Promise<string> {
  const cache = mkdtempSync(join(tmpdir(), 'gbrain-brain-template-'));
  process.once('exit', () => rmSync(cache, { recursive: true, force: true }));
  const dataDir = join(cache, 'brain');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  try {
    await engine.initSchema();
    const [state] = await engine.executeRaw<{ sources: number; writers: number }>(
      "SELECT (SELECT count(*)::int FROM sources WHERE id <> 'default') AS sources, (SELECT count(*)::int FROM persistence_local_writers) AS writers");
    if (state.sources || state.writers) throw new Error('brain-template: the template must be captured before any source or writer registration');
  } finally { await engine.disconnect(); }
  return dataDir;
}

/** The template data directory for the current embedding shape (built on first use). */
export function brainTemplateDir(): Promise<string> {
  const key = `${getEmbeddingModel()}:${getEmbeddingDimensions()}`;
  let template = templates.get(key);
  if (!template) {
    template = buildTemplate();
    templates.set(key, template);
    template.catch(() => templates.delete(key));
  }
  return template;
}

/** Copies the template into `dataDir` (which must not exist) and returns a connected engine with a fresh brain identity. */
export async function connectTemplateBrain(dataDir: string): Promise<PGLiteEngine> {
  cpSync(await brainTemplateDir(), dataDir, { recursive: true, errorOnExist: true, force: false });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  try {
    await engine.initSchema();
    await engine.executeRaw('UPDATE persistence_brain SET brain_id=gen_random_uuid() WHERE singleton=1');
    await engine.executeRaw("UPDATE sources SET incarnation=gen_random_uuid() WHERE id='default'");
    await engine.executeRaw('UPDATE shared_skill_state SET token_secret=$1, serving_epoch=gen_random_uuid() WHERE singleton=1', [randomBytes(32).toString('hex')]);
  } catch (error) { await engine.disconnect(); throw error; }
  return engine;
}
