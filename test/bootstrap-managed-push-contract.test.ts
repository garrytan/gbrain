import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'templates', 'bootstrap');
const files = ['AGENTS.md.template', 'GITHUB.md.template', 'template-repo/AGENTS.md', 'template-repo/GITHUB.md'];

describe('bootstrap persistence contract on a managed canonical worktree', () => {
  for (const f of files) {
    test(`${f} names the managed exception to sources push`, () => {
      const text = readFileSync(join(root, f), 'utf8');
      expect(text).toContain('managed canonical worktree');
      expect(text).toContain('writer_coordinator_required');
    });
  }
});
