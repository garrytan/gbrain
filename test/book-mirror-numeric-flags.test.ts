// #5909 (absorbed in agent contract v1 D4): bad values are invalid_params usage errors (exit 2 via renderCliError).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBookMirrorCmd } from '../src/commands/book-mirror.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let chaptersDir: string;
let engineReads = 0;
const noSubmitEngine = new Proxy({} as BrainEngine, {
  get() {
    engineReads++;
    throw new Error('engine access would submit a child job');
  },
});

beforeAll(() => {
  chaptersDir = mkdtempSync(join(import.meta.dir, '.book-mirror-numeric-'));
  mkdirSync(chaptersDir, { recursive: true });
  writeFileSync(join(chaptersDir, 'chapter-1.txt'), 'Synthetic chapter text.');
});
afterAll(() => rmSync(chaptersDir, { recursive: true, force: true }));

function args(flag: string, value?: string): string[] {
  return ['--chapters-dir', chaptersDir, '--slug', 'synthetic-book', '--dry-run', flag, ...(value === undefined ? [] : [value])];
}

for (const flag of ['--max-turns', '--timeout-ms']) {
  for (const value of ['abc', '12abc', '0', '-2', '9007199254740992', undefined]) {
    test(`${flag} rejects ${value ?? 'missing value'} before engine access`, async () => {
      const before = engineReads;
      await expect(runBookMirrorCmd(noSubmitEngine, args(flag, value))).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(flag) });
      expect(engineReads).toBe(before);
    });
  }

  for (const value of ['5', '05', ' 5 ']) {
    test(`${flag} accepts ${JSON.stringify(value)} without engine access in dry run`, async () => {
      const before = engineReads;
      await expect(runBookMirrorCmd(noSubmitEngine, args(flag, value))).resolves.toBeUndefined();
      expect(engineReads).toBe(before);
    });
  }
}
