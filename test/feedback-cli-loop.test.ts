/**
 * Retrieval feedback through the real CLI on a keyless PGLite brain: off by
 * default (no answer id); once enabled, search prints an answer id, `foresights rate` records the rating, and the next
 * `search --explain` shows the feedback multiplier on the rated pages.
 *
 * Spawns the CLI against a temporary GBRAIN_HOME; no process-wide state.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const env = { GBRAIN_SOURCE: undefined, GBRAIN_NO_BANNER: '1', GBRAIN_MODEL_DISCOVERY: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1',
  ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };

let home: string;
const cli = (args: string[]) => runCli(args, { home, cwd: home, env, timeoutMs: 120_000 });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-feedback-cli-'));
  const notes = join(home, 'notes');
  mkdirSync(join(notes, 'people'), { recursive: true });
  writeFileSync(join(notes, 'people', 'alice-example.md'), '---\ntitle: Alice Example\ntype: person\n---\nAlice Example leads the widget project at Acme.\n');
  writeFileSync(join(notes, 'widget-notes.md'), '---\ntitle: Widget Notes\n---\nThe widget project ships widgets. Widget roadmap and widget pricing.\n');
  expect((await cli(['init', '--pglite', '--no-embedding'])).exitCode).toBe(0);
  expect((await cli(['import', notes, '--no-embed'])).exitCode).toBe(0);
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test('search → rate → search --explain shows the learned boost', async () => {
  const off = await cli(['search', 'widget', '--json']);
  expect(off.exitCode).toBe(0);
  expect(off.stdout).not.toContain('answer_id');
  expect((await cli(['config', 'set', 'feedback.enabled', 'true'])).exitCode).toBe(0);

  const before = await cli(['search', 'widget', '--explain']);
  expect(before.exitCode).toBe(0);
  expect(before.stdout).not.toContain('feedback ×');

  const search = await cli(['search', 'widget', '--json']);
  expect(search.exitCode).toBe(0);
  const answerId = (JSON.parse(search.stdout) as Array<{ answer_id?: string }>)[0]?.answer_id;
  expect(answerId).toMatch(/^ans_[0-9A-Z]{26}$/);
  expect(search.stderr).toContain(`foresights rate ${answerId} 1-5`);

  const rate = await cli(['rate', answerId!, '5']);
  expect(rate.exitCode).toBe(0);
  expect(rate.stdout).toContain('--explain');

  const after = await cli(['search', 'widget', '--explain']);
  expect(after.exitCode).toBe(0);
  expect(after.stdout).toContain('feedback ×1.01 (use-attributed ratings)');
}, 300_000);
