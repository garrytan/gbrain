import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const repoRoot = new URL('..', import.meta.url).pathname;
const decoder = new TextDecoder();

let rootDir: string;
let homeDir: string;
let configDir: string;
let dbPath: string;

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'mbrain-agent-session-cli-'));
  homeDir = join(rootDir, 'home');
  configDir = join(homeDir, '.mbrain');
  dbPath = join(configDir, 'brain.db');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    engine: 'sqlite',
    database_path: dbPath,
    offline: true,
    embedding_provider: 'none',
    query_rewrite_provider: 'heuristic',
  }, null, 2));

  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: dbPath });
  await engine.initSchema();
  await engine.disconnect();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('agent-session CLI command', () => {
  test('previews a JSON envelope file without applying memory', () => {
    const envelopePath = writeEnvelope('preview-session', [{
      event_kind: 'explicit_memory_note',
      text: 'Remember that the user prefers concise implementation checkpoints.',
    }]);

    const result = runCli(['agent-session', 'preview', '--file', envelopePath, '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.stdout);
    expect(json.applied).toBe(false);
    expect(json.capture.events[0]).toMatchObject({
      source_kind: 'codex_session',
      session_id: 'preview-session',
      actor: 'user',
    });
  });

  test('rejects envelope params outside the shared operation schema', () => {
    const envelopePath = join(rootDir, 'invalid-source-kind.json');
    writeFileSync(envelopePath, JSON.stringify({
      source_kind: 'browser_session',
      session_id: 'invalid-source-kind-session',
      events: [{
        event_kind: 'explicit_memory_note',
        text: 'Remember that the user prefers concise implementation checkpoints.',
      }],
    }, null, 2));

    const result = runCli(['agent-session', 'preview', '--file', envelopePath, '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('source_kind must be one of: codex_session, claude_session, agent_session');
  });

  test('captures a JSON envelope file through governed direct personal preflight', () => {
    const envelopePath = writeEnvelope('capture-session', [{
      event_kind: 'explicit_memory_note',
      text: 'Remember that the user prefers concise implementation checkpoints.',
    }]);

    const result = runCli([
      'agent-session',
      'capture',
      '--file',
      envelopePath,
      '--apply',
      '--write-mode',
      'direct_personal_when_allowed',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.stdout);
    expect(json.applied).toBe(true);
    expect(json.routes[0].direct_write).toMatchObject({
      kind: 'profile_memory',
      status: 'written',
    });
  });
});

function writeEnvelope(sessionId: string, events: Array<Record<string, unknown>>): string {
  const path = join(rootDir, `${sessionId}.json`);
  writeFileSync(path, JSON.stringify({
    source_kind: 'codex_session',
    session_id: sessionId,
    client_name: 'codex',
    repo_path: '/Users/meghendra/Work/mbrain',
    workspace_id: 'workspace:mbrain',
    captured_at: '2026-06-04T01:02:03.000Z',
    events,
  }, null, 2));
  return path;
}

function runCli(args: string[]) {
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'src/cli.ts', ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      MBRAIN_CONFIG_DIR: configDir,
      DATABASE_URL: '',
      MBRAIN_DATABASE_URL: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}
