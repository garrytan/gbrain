/**
 * #9451: `gbrain init --force --embedding-model X` on a keyless PGLite brain moved the file plane to X but left the
 * database plane's embedding_model on the new-install default, so fact and take vectors, doctor and
 * `migrate embeddings --status` kept targeting a model the brain no longer uses. With no stored vectors from another
 * model, the re-init now records X in both planes.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-9451-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('init --force --embedding-model on a keyless PGLite brain moves the database plane to the new model', async () => {
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1',
    OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined };
  expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
  const reinit = await runCli(['init', '--force', '--pglite', '--embedding-model', 'ollama:mxbai-embed-large', '--embedding-dimensions', '1024', '--skip-embed-check', '--json'], { env });
  expect(reinit.exitCode).toBe(0);
  const status = await runCli(['migrate', 'embeddings', '--status', '--json'], { env });
  const doc = JSON.parse(status.stdout) as { file_plane: { model: string; dims: number }; db_plane: { model: string; dims: string } };
  expect(doc.file_plane).toEqual({ model: 'ollama:mxbai-embed-large', dims: 1024 });
  expect(doc.db_plane).toEqual({ model: 'ollama:mxbai-embed-large', dims: '1024' });
}, 240_000);
