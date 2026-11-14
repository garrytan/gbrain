/**
 * The skill-diet eval adapter (test/fixtures/skill-evals/_lib/adapter.mjs) enforces
 * EVAL_SPEND_CAP from its ledger. A Codex model with no price row would log a null
 * cost that the cap reads as 0, so a capped run refuses it before starting a session.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const ADAPTER = join(import.meta.dir, 'fixtures', 'skill-evals', '_lib', 'adapter.mjs');
const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

test('a capped run refuses an unpriced Codex model before starting a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-evals-adapter-'));
  created.push(dir);
  const out = join(dir, 'out');
  const work = join(dir, 'work');
  const r = spawnSync('node', [ADAPTER, '', 'prompt', out, work], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, EVAL_MODEL: 'gpt-unpriced-example', EVAL_LEDGER: join(dir, 'ledger.jsonl'), EVAL_SPEND_CAP: '1', EVAL_AGENTS_BIN: join(dir, 'bin') },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('no price for gpt-unpriced-example');
  expect(existsSync(join(out, 'raw.jsonl'))).toBe(false);
  expect(existsSync(work)).toBe(false);
});
