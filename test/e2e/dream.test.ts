/**
 * E2E dream tests — Tier 1 (no API keys required).
 *
 * Drives the dream CLI entry point through a real Postgres engine with
 * a real git repo. Complements test/dream.test.ts (which exercises the
 * code paths via the library call) by testing the actual CLI output
 * shape and exit-code semantics against real DB state.
 *
 * Run: DATABASE_URL=... bun test test/e2e/dream.test.ts
 */

import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { hasDatabase, setupLegacyEmbeddingDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

// Mock embedBatch so embed phase doesn't call OpenAI.
mock.module('../../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(1536)),
  // v0.41.31: embed phase reads the current signature to stamp provenance.
  currentEmbeddingSignature: () => 'test:model:1536',
}));

const { runDream } = await import('../../src/commands/dream.ts');

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E dream tests (DATABASE_URL not set)');
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-dream-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, 'concepts'), { recursive: true });
  writeFileSync(
    join(dir, 'concepts/testing.md'),
    '---\ntype: concept\ntitle: Testing Philosophy\n---\n\nEvery untested path is a path where bugs hide.\n',
  );
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

// runDream exits 1 when a phase fails. In-process that would end the bun test
// process with no assertion and no JUnit report, so the exit becomes a thrown
// error carrying the captured report instead.
function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  return new Promise(async (resolve, reject) => {
    const lines: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => {
      throw new Error(`runDream called process.exit(${code}); captured output:\n${lines.join('\n').slice(0, 4000)}`);
    }) as typeof process.exit;
    try {
      const result = await fn();
      resolve({ result, output: lines.join('\n') });
    } catch (e) {
      reject(e);
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }
  });
}

describeE2E('E2E: gbrain dream CLI against real Postgres', () => {
  let repo: string;

  // The gateway below carries no Anthropic key, but the e2e runner keeps the
  // ambient one (nightly CI sets it). LLM phases probe hasAnthropicKey(), which
  // reads process.env first, so they would start and then fail at chat time
  // against this gateway. Drop it so they skip, as on a keyless brain.
  const ambientAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    await setupLegacyEmbeddingDB();
    // embedBatch is mocked above, but the embed phase's credential preflight
    // reads the gateway env, and a failed phase now exits 1 (agent operator E4).
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'placeholder-key-embed-is-mocked' } });
    delete process.env.ANTHROPIC_API_KEY;
    repo = makeGitRepo();
  }, 30_000);

  afterAll(async () => {
    if (ambientAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = ambientAnthropicKey;
    await teardownDB();
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test('dream --dry-run --json emits a valid CycleReport + DB stays empty', async () => {
    const conn = getConn();
    const beforePages = await conn.unsafe(`SELECT count(*)::int AS n FROM pages`);

    const { output } = await captureLog(() =>
      runDream(getEngine(), ['--dir', repo, '--dry-run', '--json']),
    );

    // dream prints a CycleReport as pretty-printed JSON. It may be
    // preceded by inline phase-runner log lines (e.g. sync's
    // "Full-sync dry run: N files"). Extract the JSON object.
    const jsonStart = output.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(output.slice(jsonStart));
    expect(parsed.schema_version).toBe('1');
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('phases');
    expect(parsed).toHaveProperty('totals');
    expect(parsed.brain_dir).toBe(repo);

    // No pages were written.
    const afterPages = await conn.unsafe(`SELECT count(*)::int AS n FROM pages`);
    expect(afterPages[0].n).toBe(beforePages[0].n);
  });

  test('dream (no --dry-run) syncs pages into the real DB', async () => {
    const conn = getConn();

    await captureLog(() => runDream(getEngine(), ['--dir', repo, '--json']));

    const pages = await conn.unsafe(`SELECT slug FROM pages ORDER BY slug`);
    const slugs = (pages as unknown as Array<{ slug: string }>).map(p => p.slug);
    expect(slugs).toContain('concepts/testing');

    // sync.last_commit bookmark set.
    const sync = await conn.unsafe(
      `SELECT value FROM config WHERE key = 'sync.last_commit'`,
    );
    expect(sync.length).toBe(1);
  }, 60_000);

  test('dream --phase orphans only reports orphans + no cycle-lock footprint', async () => {
    const conn = getConn();
    const before = await conn.unsafe(
      `SELECT COUNT(*)::int AS n FROM gbrain_cycle_locks`,
    );

    const { result } = await captureLog(() =>
      runDream(getEngine(), ['--dir', repo, '--phase', 'orphans', '--json']),
    );

    expect(result).toBeTruthy();
    if (result) {
      expect(result.phases.length).toBe(1);
      expect(result.phases[0].phase).toBe('orphans');
    }

    const after = await conn.unsafe(
      `SELECT COUNT(*)::int AS n FROM gbrain_cycle_locks`,
    );
    // Read-only phase selection doesn't touch the lock table.
    expect(after[0].n).toBe(before[0].n);
  });
});
