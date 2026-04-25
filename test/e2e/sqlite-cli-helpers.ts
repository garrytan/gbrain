import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const decoder = new TextDecoder();
const repoRoot = new URL('../..', import.meta.url).pathname;

export interface SqliteCliHarness {
  rootDir: string;
  homeDir: string;
  configDir: string;
  brainRepoDir: string;
  exportDir: string;
  dbPath: string;
  run: (args: string[], options?: { cwd?: string; input?: string }) => CliResult;
  runJson: <T = any>(args: string[], options?: { cwd?: string; input?: string }) => T;
  call: <T = any>(tool: string, params?: Record<string, unknown>) => T;
  writeBrainFile: (relativePath: string, content: string) => void;
  git: (...args: string[]) => CliResult;
  teardown: () => void;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function createSqliteCliHarness(label: string): SqliteCliHarness {
  const rootDir = mkdtempSync(join(tmpdir(), `mbrain-sqlite-e2e-${label}-`));
  const homeDir = join(rootDir, 'home');
  const configDir = join(homeDir, '.mbrain');
  const brainRepoDir = join(rootDir, 'brain');
  const exportDir = join(rootDir, 'export');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(brainRepoDir, { recursive: true });
  const dbPath = join(configDir, 'brain.db');

  const env = {
    ...process.env,
    HOME: homeDir,
    MBRAIN_CONFIG_DIR: configDir,
    MBRAIN_DATABASE_PATH: dbPath,
    DATABASE_URL: 'postgresql://mbrain:ignored@127.0.0.1:9/not_used',
    MBRAIN_DATABASE_URL: 'postgresql://mbrain:ignored@127.0.0.1:9/not_used',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  };

  const run = (args: string[], options: { cwd?: string; input?: string } = {}): CliResult => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', ...args],
      cwd: options.cwd ?? repoRoot,
      env,
      stdin: options.input ? Buffer.from(options.input) : undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  };

  const runJson = <T = any>(args: string[], options?: { cwd?: string; input?: string }): T => {
    const result = run(args, options);
    assertOk(result, args);
    return parseJsonSuffix(result.stdout);
  };

  return {
    rootDir,
    homeDir,
    configDir,
    brainRepoDir,
    exportDir,
    dbPath,
    run,
    runJson,
    call: <T = any>(tool: string, params: Record<string, unknown> = {}) =>
      runJson<T>(['call', tool, JSON.stringify(params)]),
    writeBrainFile: (relativePath: string, content: string) => {
      const filePath = join(brainRepoDir, relativePath);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content);
    },
    git: (...args: string[]) => {
      const result = Bun.spawnSync({
        cmd: ['git', ...args],
        cwd: brainRepoDir,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        exitCode: result.exitCode,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    teardown: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export function assertOk(result: CliResult, args: string[]): void {
  if (result.exitCode !== 0) {
    throw new Error([
      `Command failed: mbrain ${args.join(' ')}`,
      `exit=${result.exitCode}`,
      `stdout=${result.stdout}`,
      `stderr=${result.stderr}`,
    ].join('\n'));
  }
}

export function assertFails(result: CliResult, args: string[]): void {
  if (result.exitCode === 0) {
    throw new Error([
      `Command unexpectedly succeeded: mbrain ${args.join(' ')}`,
      `stdout=${result.stdout}`,
      `stderr=${result.stderr}`,
    ].join('\n'));
  }
}

export function parseJsonSuffix<T = any>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Fall through to tolerate human-readable prefixes before JSON payloads.
  }
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char !== '{' && char !== '[') continue;
    try {
      return JSON.parse(trimmed.slice(index)) as T;
    } catch {
      // Try the next JSON-looking suffix.
    }
  }
  throw new Error(`No JSON payload found in stdout:\n${stdout}`);
}

export function initGitRepo(harness: SqliteCliHarness): void {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'sqlite-e2e@example.test'],
    ['config', 'user.name', 'SQLite E2E'],
  ]) {
    const result = harness.git(...args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    }
  }
}

export function commitAll(harness: SqliteCliHarness, message: string): void {
  for (const args of [
    ['add', '-A'],
    ['commit', '-m', message],
  ]) {
    const result = harness.git(...args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    }
  }
}

export function pageMarkdown(input: {
  type: string;
  title: string;
  tags?: string[];
  body: string;
  timeline?: string;
}): string {
  return [
    '---',
    `type: ${input.type}`,
    `title: ${input.title}`,
    `tags: [${(input.tags ?? []).join(', ')}]`,
    '---',
    '',
    input.body.trim(),
    '',
    '---',
    '',
    (input.timeline ?? '').trim(),
    '',
  ].join('\n');
}
