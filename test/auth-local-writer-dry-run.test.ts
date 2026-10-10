/**
 * #5595 ("also seen"): `gbrain auth local-writer register cli --dry-run`
 * failed with "unknown flag --dry-run for 'gbrain auth'" although --help
 * documents it. auth hands that argv to runPersistenceAdminCli
 * (persistence-admin.ts), one module deeper than the flag-registry scan
 * takes consumption evidence from, so the generator dropped the safety flag.
 * The same gap hid `auth rescope-client|rescope-token --dry-run`.
 */
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommandFlags } from '../src/cli/main.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-local-writer-dry-run-')));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
function gbrain(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: home };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete env[key];
  return spawnSync(process.execPath, ['run', CLI, ...args], { env, encoding: 'utf8', timeout: 120_000 });
}

test('the validator accepts --dry-run on every auth subcommand that parses it', () => {
  expect(validateCommandFlags('auth', ['local-writer', 'register', 'cli', '--dry-run'])).toBeNull();
  expect(validateCommandFlags('auth', ['local-writer', 'revoke', '00000000-0000-4000-8000-000000000000', '--dry-run'])).toBeNull();
  expect(validateCommandFlags('auth', ['rescope-client', 'client-example', '--source', 'default', '--dry-run'])).toBeNull();
  expect(validateCommandFlags('auth', ['local-writer', 'register', 'cli', '--definitely-not-a-flag'])).toBe('--definitely-not-a-flag');
});

test('auth local-writer register --replace --dry-run previews the regrant and changes nothing', () => {
  const init = gbrain(['init', '--pglite', '--non-interactive', '--no-embedding']);
  expect({ status: init.status, stderr: init.status === 0 ? '' : init.stderr }).toEqual({ status: 0, stderr: '' });
  const before = JSON.parse(gbrain(['auth', 'local-writer', 'list', '--json']).stdout);
  const preview = gbrain(['auth', 'local-writer', 'register', 'cli', '--source-ids', 'default', '--replace', '--dry-run', '--json']);
  expect(preview.stderr).not.toContain('unknown flag');
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ dry_run: true, action: 'local_writer_register', lane: 'cli', replace: true, grant: { sourceIds: ['default'] } });
  expect(JSON.parse(gbrain(['auth', 'local-writer', 'list', '--json']).stdout)).toEqual(before);
}, 150_000);
