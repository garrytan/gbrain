/**
 * #5799 residual (wave 14 P4.16): the user-prompt FAILING banner reads push
 * statuses through `livePushStatuses`, so a record a managed worktree has
 * superseded (a `writer_coordinator_required` refusal, or any record whose
 * root carries `.gbrain-managed` now) raises no notice, while a live failure
 * on a plain root still does. Follows test/hook-backup-notice.serial.test.ts
 * for env save/restore + tmp GBRAIN_HOME + collectStdout + runHook.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from '../src/commands/hook.ts';
import { pushStatusPathForRoot } from '../src/core/workspace-push.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_BACKUP_CHECK'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hkps-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
  process.env.GBRAIN_BACKUP_CHECK = '0';
  mkdirSync(join(tmp, '.gbrain', 'bootstrap'), { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

function makeRoot(name: string, managed: boolean): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  if (managed) writeFileSync(join(root, '.gbrain-managed'), '');
  return root;
}

function writeStatus(root: string, over: Record<string, unknown>): void {
  writeFileSync(pushStatusPathForRoot(root), JSON.stringify({ ts: new Date().toISOString(), ok: false, repoRoot: root, ...over }) + '\n', { mode: 0o600 });
}

async function userPrompt(): Promise<{ systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } }> {
  const out = collectStdout();
  expect(await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) })).toBe(0);
  return out.get().trim() ? JSON.parse(out.get()) : {};
}

describe('user-prompt push banner ignores superseded records (#5799)', () => {
  test('a stale writer_coordinator_required record on a managed root raises no FAILING notice', async () => {
    const root = makeRoot('managed-brain', true);
    writeStatus(root, { code: 'writer_coordinator_required', reason: 'writer_coordinator_required: This path belongs to the managed canonical worktree.' });
    const payload = await userPrompt();
    expect(payload.systemMessage ?? '').not.toContain('FAILING');
    expect(payload.hookSpecificOutput?.additionalContext ?? '').not.toContain('FAILING');
  });

  test('an older failure record whose root is managed now is superseded too', async () => {
    const root = makeRoot('adopted-brain', true);
    writeStatus(root, { reason: 'push failed: remote rejected' });
    const payload = await userPrompt();
    expect(payload.systemMessage ?? '').not.toContain('FAILING');
  });

  test('a live failure on a plain root still raises the notice', async () => {
    const root = makeRoot('plain-brain', false);
    writeStatus(root, { reason: 'refused_visibility: origin unverifiable' });
    const payload = await userPrompt();
    expect(payload.systemMessage).toContain('FAILING');
    expect(payload.systemMessage).toContain('NOT on GitHub');
  });
});
