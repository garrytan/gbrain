/**
 * #8484 timeout path: when another install holds the shared instruction-ledger
 * lock past the 10 s wait, a skills sync and an uninstall refuse with
 * reason ledger_locked and change neither the instruction file nor the
 * ledger. Slow tier: each refusal waits the full 10 s.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { brainFirstTargetAt, removeBrainFirst } from '../src/core/setup/brain-first.ts';
import { removeSkillsBlock, skillLoadingLedgerPath, syncSkillsBlock } from '../src/core/setup/skills-block.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const HOLDER = [
  "import { writeFileSync } from 'node:fs';",
  "import { acquireNativeLockSync } from '__NATIVE_LOCK__';",
  "const [lockPath, marker, holdMs] = process.argv.slice(2);",
  "const lock = acquireNativeLockSync(lockPath, { timeoutMs: 5000 });",
  "if (!lock) process.exit(3);",
  "writeFileSync(marker, 'held');",
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));",
  "lock.release();",
].join('\n');

describe('#8484: an install that cannot take the ledger lock changes nothing', () => {
  test('a skills sync and the uninstall paths refuse with ledger_locked while another install holds the lock past the wait', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-lock-timeout-'));
    roots.push(home);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const file = join(home, '.claude', 'CLAUDE.md');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(file, '# My rules\n');
    const script = join(home, 'holder.ts');
    writeFileSync(script, HOLDER.replace('__NATIVE_LOCK__', join(import.meta.dir, '..', 'src', 'core', 'persistence', 'native-lock.ts')));
    const marker = join(home, 'held');
    const child = Bun.spawn([process.execPath, '--no-env-file', script, join(home, '.gbrain', 'agent-instructions.lock'), marker, '45000'], { stdout: 'inherit', stderr: 'inherit' });
    try {
      for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(25);
      expect(existsSync(marker)).toBe(true);
      await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
        const target = brainFirstTargetAt('claude-code', file);
        const sync = syncSkillsBlock({ target, launcher: '/usr/local/bin/gbrain', decision: { value: 'spring', source: 'flag' }, writer: 'test', dryRun: false, settingsPath: join(home, '.claude', 'settings.json') });
        expect(sync).toMatchObject({ action: 'preserve', reason: 'ledger_locked' });
        expect(sync.detail).toContain('another gbrain install is updating the instruction ledgers');
        const removed = removeSkillsBlock({ harness: 'claude-code', path: file, dryRun: false });
        expect(removed).toMatchObject({ action: 'preserve', reason: 'ledger_locked' });
        const brainFirst = removeBrainFirst({ harness: 'claude-code', path: file, dryRun: false });
        expect(brainFirst.action).toBe('preserve');
        expect(brainFirst.detail).toContain('another gbrain install is updating the instruction ledgers');
        expect(readFileSync(file, 'utf8')).toBe('# My rules\n');
        expect(existsSync(skillLoadingLedgerPath())).toBe(false);
        expect(existsSync(join(home, '.gbrain', 'agent-instructions.json'))).toBe(false);
        expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
      });
    } finally {
      child.kill();
      await child.exited;
    }
  }, 90_000);
});
