/**
 * GST-2767: `gbrain embed --status --source <id> --json` answered internal_error "Page not found: <id>": embed has no
 * --status mode, so the run fell through to the single-page branch, which took the first argument not starting with
 * `--` as the slug, the source id. The slug is now the first argument that is neither a flag nor a flag's value, and an
 * unknown flag is refused as unknown_flag (exit 2) before consent or any provider call.
 * Seams: none; the real CLI against a keyless PGLite brain under a temp GBRAIN_HOME.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embedSlugTarget } from '../src/commands/embed-slug-args.ts';
import { runCli } from './helpers/cli-spawn.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-embed-args-'));
beforeAll(async () => {
  const init = await runCli(['init', '--pglite', '--no-embedding'], { home, timeoutMs: 120_000 });
  expect(init.exitCode).toBe(0);
}, 180_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

test('the slug is never a flag value: --source, --batch-size, --priority, --max-usd and --pace-max-concurrency take the next argument', () => {
  expect(embedSlugTarget(['--source', 'source-a', 'people/alice-example'])).toBe('people/alice-example');
  expect(embedSlugTarget(['--batch-size', '50', '--priority', 'recent', 'people/alice-example', '--dry-run'])).toBe('people/alice-example');
  expect(embedSlugTarget(['--max-usd', '2', '--pace-max-concurrency', '3', 'people/alice-example'])).toBe('people/alice-example');
  expect(embedSlugTarget(['--pace=gentle', '--source=source-a', 'people/alice-example'])).toBe('people/alice-example');
  expect(embedSlugTarget(['--source', 'source-a', '--dry-run'])).toBeUndefined();
});

test('a flag no embed mode takes is refused as unknown_flag, naming the read-only way to see embedding coverage for --status', () => {
  let caught: { code?: string; suggestion?: string; detail?: string } | undefined;
  try { embedSlugTarget(['--status', '--source', 'source-a', '--json']); } catch (e) { caught = e as typeof caught; }
  expect(caught?.code).toBe('unknown_flag');
  expect(caught?.detail).toBe('--status');
  expect(caught?.suggestion).toContain('gbrain embed --stale --dry-run --json');
});

test('CLI: embed --status --source <id> --json exits 2 with unknown_flag instead of looking the source id up as a page', async () => {
  const r = await runCli(['embed', '--status', '--source', 'source-a', '--json'], { home, timeoutMs: 120_000 });
  expect(r.stdout).not.toContain('Page not found');
  expect(r.exitCode).toBe(2);
  expect(JSON.parse(r.stdout)).toMatchObject({ code: 'unknown_flag', detail: '--status' });
}, 180_000);

test('CLI: embed --source <id> <slug> --dry-run reads the slug, not the source id', async () => {
  const r = await runCli(['embed', '--source', 'default', 'people/alice-example', '--dry-run', '--json'], { home, timeoutMs: 120_000 });
  expect(r.stdout + r.stderr).toContain('people/alice-example');
  expect(r.stdout + r.stderr).not.toContain('Page not found: default');
}, 180_000);
