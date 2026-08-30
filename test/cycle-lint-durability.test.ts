import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { runPhaseLint } from '../src/core/cycle.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('cycle lint durability', () => {
  test('a hardened corpus commits exactly the page lint fixed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-cycle-lint-durability-'));
    roots.push(root);
    const page = join(root, 'note.md');
    writeFileSync(
      page,
      `---\ntype: note\ntitle: Durable\nstatus: active\ningested_at: '2026-08-30T12:00:00Z'\n---\n\nBody.\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['add', '--', 'note.md'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });

    const hook = join(root, '.git', 'hooks', 'post-commit');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      hook,
      '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n',
    );
    chmodSync(hook, 0o755);

    const result = await runPhaseLint(root, false, null);

    expect(result.status).toBe('ok');
    expect(result.details?.fixed).toBe(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim())
      .toBe('gbrain: write-through note');
  });
});
