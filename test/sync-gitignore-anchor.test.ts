import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { withEnv } from './helpers/with-env.ts';
import { manageGitignore } from '../src/commands/sync.ts';

describe('manageGitignore anchoring', () => {
  test('single-segment db_only dir does not ignore nested tracked dirs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-anchor-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: tmp });
      writeFileSync(join(tmp, 'gbrain.yml'), 'storage:\n  db_only:\n    - decisions/\n');
      mkdirSync(join(tmp, 'docs/decisions'), { recursive: true });
      writeFileSync(join(tmp, 'docs/decisions/x.md'), 'x');
      await withEnv({ GBRAIN_NO_GITIGNORE: undefined }, () => manageGitignore(tmp));
      const nested = spawnSync('git', ['check-ignore', 'docs/decisions/x.md'], { cwd: tmp });
      const root = spawnSync('git', ['check-ignore', 'decisions/y.md'], { cwd: tmp });
      expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toContain('/decisions/');
      expect(nested.status).toBe(1);
      expect(root.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
