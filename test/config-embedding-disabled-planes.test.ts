/**
 * #5253 + B-NEW-1/2/3: `embedding_disabled` and `schema_pack` report and
 * change the value the runtime uses. Authoring gate: (1) protects the
 * keyless-to-keyed journey through the real CLI (`config unset`, `set
 * true|false`, `init --force --embedding-model`), the effective `schema_pack`
 * in `config get`/`show`, and the one enablement command every keyless hint
 * names; (2) fails when `unset` reports not-found for the init sentinel, when
 * `set false` is shadowed by the file plane, when the enable path leaves a DB
 * row that keeps write-path embedding off, or when `config get schema_pack`
 * reports a value `schema active` does not use; (3) config-get-plane tests
 * use stubs and never cross planes; (4) no production seam (real subprocess,
 * isolated GBRAIN_HOME, no provider keys).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../src/cli.ts');

describe('embedding_disabled and schema_pack config planes', () => {
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-config-planes-'));
    const init = await cli(['init', '--pglite', '--no-embedding']);
    expect(init.code).toBe(0);
  }, 120_000);
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  async function cli(args: string[]) {
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKIP_UPGRADE_CHECK: '1', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_SCHEMA_PACK: undefined,
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined,
      GEMINI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
    const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout: stdout.trim(), stderr, code };
  }
  const fileConfig = () => JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')) as Record<string, unknown>;

  test('a keyless embed names the one enablement command', async () => {
    const run = await cli(['embed', '--stale']);
    expect(run.stderr).toContain('Turn on semantic search (pages and facts are kept): gbrain init --force --embedding-model');
    expect(run.stderr).not.toContain('set embedding_model via gbrain config');
  }, 60_000);

  test('unset removes the init sentinel', async () => {
    expect(fileConfig().embedding_disabled).toBe(true);
    const run = await cli(['config', 'unset', 'embedding_disabled']);
    expect({ code: run.code, stdout: run.stdout }).toEqual({ code: 0, stdout: 'Unset embedding_disabled (file plane)' });
    expect('embedding_disabled' in fileConfig()).toBe(false);
    expect((await cli(['config', 'get', 'embedding_disabled'])).code).toBe(1);
  }, 60_000);

  test('set true and set false move both planes and get reports the runtime value', async () => {
    expect((await cli(['config', 'set', 'embedding_disabled', 'true'])).code).toBe(0);
    expect(fileConfig().embedding_disabled).toBe(true);
    expect((await cli(['config', 'get', 'embedding_disabled'])).stdout).toBe('true');
    expect((await cli(['config', 'set', 'embedding_disabled', 'false'])).code).toBe(0);
    expect('embedding_disabled' in fileConfig()).toBe(false);
    expect((await cli(['config', 'get', 'embedding_disabled'])).stdout).toBe('false');
    expect((await cli(['config', 'set', 'embedding_disabled', 'maybe'])).code).toBe(1);
  }, 60_000);

  test('the enable path clears both planes', async () => {
    expect((await cli(['config', 'set', 'embedding_disabled', 'true'])).code).toBe(0);
    const force = await cli(['init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024',
      '--path', join(home, '.gbrain', 'brain.pglite')]);
    expect({ code: force.code, stderr: force.stderr }).toMatchObject({ code: 0 });
    expect(fileConfig()).toMatchObject({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024 });
    const get = await cli(['config', 'get', 'embedding_disabled']);
    expect({ code: get.code, stdout: get.stdout }).toEqual({ code: 1, stdout: '' });
  }, 120_000);

  test('config get and show report the schema pack the runtime resolves', async () => {
    expect((await cli(['config', 'set', 'schema_pack', 'gbrain-creator'])).code).toBe(0);
    expect(fileConfig().schema_pack).not.toBe('gbrain-creator');
    const active = await cli(['schema', 'active']);
    expect(active.stdout).toContain('Active pack: gbrain-creator');
    const get = await cli(['config', 'get', 'schema_pack']);
    expect(get.stdout).toBe('gbrain-creator');
    expect(get.stderr).toContain('db plane');
    expect((await cli(['config', 'show'])).stdout).toContain('schema_pack: gbrain-creator');
  }, 60_000);
});
