import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { whoknowsHealthCheck } from '../src/commands/doctor.ts';

/**
 * v0.33 whoknows_health doctor check — fixture-only assertion. The
 * check inspects the working-directory fixture file; it does NOT need
 * an engine. We pass a sentinel object cast to BrainEngine for the
 * type contract since the check intentionally ignores its argument.
 */

const stubEngine = {} as Parameters<typeof whoknowsHealthCheck>[0];

let savedCwd: string;
let workDir: string;

beforeAll(() => {
  savedCwd = process.cwd();
});

afterAll(() => {
  process.chdir(savedCwd);
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'whoknows-doctor-'));
  process.chdir(workDir);
});

function cleanup() {
  process.chdir(savedCwd);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

describe('whoknows_health doctor check', () => {
  it('warns when fixture file is missing entirely', async () => {
    try {
      const check = await whoknowsHealthCheck(stubEngine);
      expect(check.name).toBe('whoknows_health');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('fixture missing');
    } finally {
      cleanup();
    }
  });

  it('warns when fixture exists but is empty', async () => {
    try {
      mkdirSync('test/fixtures', { recursive: true });
      writeFileSync('test/fixtures/whoknows-eval.jsonl', '');
      const check = await whoknowsHealthCheck(stubEngine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('empty');
    } finally {
      cleanup();
    }
  });

  it('warns when fixture has fewer than 5 rows', async () => {
    try {
      mkdirSync('test/fixtures', { recursive: true });
      writeFileSync(
        'test/fixtures/whoknows-eval.jsonl',
        '{"query":"a","expected_top_3_slugs":["x"]}\n' +
          '{"query":"b","expected_top_3_slugs":["y"]}\n',
      );
      const check = await whoknowsHealthCheck(stubEngine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('2 row');
    } finally {
      cleanup();
    }
  });

  it('passes when fixture has at least 5 rows', async () => {
    try {
      mkdirSync('test/fixtures', { recursive: true });
      const rows = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ query: `q${i}`, expected_top_3_slugs: [`p${i}`] }),
      ).join('\n');
      writeFileSync('test/fixtures/whoknows-eval.jsonl', rows + '\n');
      const check = await whoknowsHealthCheck(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('10 queries');
    } finally {
      cleanup();
    }
  });

  it('ignores comment lines and blank lines when counting rows', async () => {
    try {
      mkdirSync('test/fixtures', { recursive: true });
      const content = [
        '# comment',
        '// another comment',
        '',
        '{"query":"a","expected_top_3_slugs":["x"]}',
        '{"query":"b","expected_top_3_slugs":["y"]}',
        '{"query":"c","expected_top_3_slugs":["z"]}',
        '{"query":"d","expected_top_3_slugs":["w"]}',
        '{"query":"e","expected_top_3_slugs":["v"]}',
      ].join('\n');
      writeFileSync('test/fixtures/whoknows-eval.jsonl', content + '\n');
      const check = await whoknowsHealthCheck(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('5 queries');
    } finally {
      cleanup();
    }
  });
});
