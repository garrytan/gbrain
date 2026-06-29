#!/usr/bin/env bun
/**
 * Smoke test: verify the Postgres target runtime migration confidence path.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... bun run smoke:postgres-runtime
 *
 * This is intended for a disposable Postgres database. It runs `mbrain init`,
 * imports a Markdown fixture, reads it through the bounded get_page operation,
 * executes the deterministic Phase 13 replay gate, and finishes with
 * `mbrain doctor --json`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const decoder = new TextDecoder();
const repoRoot = new URL('..', import.meta.url).pathname;
const databaseUrl = process.env.MBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const allowNonEmpty = process.env.MBRAIN_POSTGRES_RUNTIME_SMOKE_ALLOW_NONEMPTY === '1';
const verbose = process.env.MBRAIN_SMOKE_VERBOSE === '1';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

if (!databaseUrl) {
  console.error('Set DATABASE_URL or MBRAIN_DATABASE_URL before running the Postgres runtime smoke.');
  process.exit(1);
}

const rootDir = mkdtempSync(join(tmpdir(), 'mbrain-postgres-runtime-smoke-'));
const homeDir = join(rootDir, 'home');
const markdownDir = join(rootDir, 'markdown-export');
const configDir = join(homeDir, '.mbrain');
const slug = 'phase14/runtime-smoke';

const commandEnv: Record<string, string> = {
  ...process.env,
  HOME: homeDir,
  MBRAIN_CONFIG_DIR: configDir,
  MBRAIN_CONFIG_PATH: '',
  MBRAIN_DATABASE_URL: databaseUrl,
  DATABASE_URL: databaseUrl,
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
};

function runCommand(
  cmd: string[],
  label: string,
  env: Record<string, string> = commandEnv,
): CommandResult {
  console.log(`$ ${label}`);
  const result = Bun.spawnSync({
    cmd,
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);

  if (verbose && stdout.trim()) console.log(stdout.trim());
  if ((verbose || result.exitCode !== 0) && stderr.trim()) console.error(stderr.trim());

  if (result.exitCode !== 0) {
    throw new Error([
      `Command failed: ${label}`,
      `exit=${result.exitCode}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ].filter(Boolean).join('\n'));
  }

  return { stdout, stderr, exitCode: result.exitCode };
}

function runMbrain(args: string[]): CommandResult {
  return runCommand(['bun', 'run', 'src/cli.ts', ...args], `mbrain ${args.join(' ')}`);
}

function runDeterministicPhase13(): void {
  runCommand(['bun', 'run', 'test:phase13'], 'bun run test:phase13', {
    ...process.env,
    HOME: homeDir,
    MBRAIN_CONFIG_DIR: '',
    MBRAIN_CONFIG_PATH: '',
    MBRAIN_DATABASE_URL: '',
    DATABASE_URL: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  });
}

function parseLastJsonObject<T = any>(output: string, label: string): T {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n')) as T;
    } catch {
      // Keep scanning: earlier command logs may include non-JSON braces.
    }
  }
  throw new Error(`${label} did not emit a JSON object.`);
}

function writeFixture(): void {
  const pageDir = join(markdownDir, 'phase14');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(pageDir, 'runtime-smoke.md'), [
    '---',
    'title: Phase 14 Runtime Smoke',
    'type: system',
    'tags:',
    '  - phase14',
    '  - smoke',
    '---',
    '',
    'The Postgres runtime confidence smoke validates the Markdown-first migration acceptance path.',
    '[Source: Postgres runtime smoke test, direct fixture, 2026-05-31 00:00 KST]',
    '',
    '---',
    '',
    '- **2026-05-31** | Imported by the Phase 14 Postgres runtime smoke.',
  ].join('\n'));
}

try {
  writeFixture();

  parseLastJsonObject(runMbrain(['init', '--url', databaseUrl, '--non-interactive', '--json']).stdout, 'init');

  const initialStats = parseLastJsonObject<{ page_count: number }>(
    runMbrain(['call', 'get_stats', '{}']).stdout,
    'get_stats',
  );
  if (!allowNonEmpty && initialStats.page_count !== 0) {
    throw new Error(
      `Postgres runtime smoke requires a disposable empty database; found ${initialStats.page_count} page(s). `
      + 'Set MBRAIN_POSTGRES_RUNTIME_SMOKE_ALLOW_NONEMPTY=1 only if you intentionally want to run against a populated target.',
    );
  }

  const importResult = parseLastJsonObject<{ imported: number; errors: number; chunks: number }>(
    runMbrain(['import', markdownDir, '--no-embed', '--workers', '1', '--fresh', '--json']).stdout,
    'import',
  );
  if (importResult.imported !== 1 || importResult.errors !== 0 || importResult.chunks < 1) {
    throw new Error(`Unexpected import result: ${JSON.stringify(importResult)}`);
  }

  const page = runMbrain(['get', slug]).stdout;
  if (!page.includes('Phase 14 Runtime Smoke') || !page.includes('Postgres runtime confidence smoke')) {
    throw new Error(`Imported page did not round-trip through get_page: ${page}`);
  }

  const boundedPage = parseLastJsonObject<any>(
    runMbrain(['call', 'get_page', JSON.stringify({ slug, content_char_limit: 80 })]).stdout,
    'get_page',
  );
  if (
    boundedPage?.slug !== slug
    || boundedPage?.title !== 'Phase 14 Runtime Smoke'
    || typeof boundedPage?.content_hash !== 'string'
    || !boundedPage?.content_window
    || boundedPage?.content_window?.char_limit !== 80
    || !String(boundedPage?.compiled_truth ?? '').includes('Postgres runtime confidence smoke')
  ) {
    throw new Error(`Bounded get_page did not return the imported page window: ${JSON.stringify(boundedPage)}`);
  }

  runDeterministicPhase13();

  const doctor = parseLastJsonObject<{ status: string; checks: Array<{ name: string; status: string }> }>(
    runMbrain(['doctor', '--json']).stdout,
    'doctor',
  );
  if (doctor.status !== 'healthy') {
    throw new Error(`Doctor reported unhealthy runtime: ${JSON.stringify(doctor)}`);
  }
  for (const required of ['connection', 'target_runtime', 'schema_version', 'system_of_record', 'memory_runtime']) {
    if (!doctor.checks.some(check => check.name === required)) {
      throw new Error(`Doctor report missed required check "${required}": ${JSON.stringify(doctor)}`);
    }
  }

  runMbrain(['delete', slug]);

  console.log(JSON.stringify({
    ok: true,
    runtime: 'postgres',
    slug,
    imported: importResult.imported,
    chunks: importResult.chunks,
    doctorStatus: doctor.status,
    apiKeysRequired: false,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!process.env.MBRAIN_SMOKE_KEEP_TEMP) {
    rmSync(rootDir, { recursive: true, force: true });
  } else {
    console.error(`Keeping temp directory: ${rootDir}`);
  }
}
