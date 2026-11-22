import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDream } from '../src/commands/dream.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
let dir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-dream-nodb-home-'));
  dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-nodb-dir-'));
  writeFileSync(join(dir, 'transcript.txt'), 'a transcript long enough to matter\n'.repeat(50));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('dream --input without a database exits non-zero', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`EXIT ${code}`); }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const out = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  let outcome = 'returned';
  try {
    await runDream(null, ['--input', join(dir, 'transcript.txt'), '--dir', dir, '--json']);
  } catch (e) {
    outcome = (e as Error).message;
  } finally {
    exit.mockRestore(); log.mockRestore(); err.mockRestore(); out.mockRestore();
  }
  expect(outcome).toBe('EXIT 1');
}), 60_000);
