/**
 * #8484: the brain-first ledger (agent-instructions.json) and the skills
 * ledger (skill-loading.json) are read, edited and rewritten by every install
 * lane. Two installs at once used to drop each other's entry: both read the
 * ledger, and the later rename wins. A sync now runs its whole transaction
 * under one shared lock (underInstructionLedgerLock), so an install that
 * starts while another holds the lock waits and reads the other's entry.
 *
 * The other install is a child process that takes the lock, reads the
 * ledger, waits, then writes it back with its own entry, the read-modify-write
 * every install lane does.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { brainFirstLedgerPath, brainFirstTargetAt, syncBrainFirst } from '../src/core/setup/brain-first.ts';
import { skillLoadingLedgerPath, syncSkillsBlock } from '../src/core/setup/skills-block.ts';
import { SKILL_INDEX_VERSION } from '../src/core/skills/spring-index.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const HOLDER = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { acquireNativeLockSync } from '__NATIVE_LOCK__';
const [lockPath, ledgerPath, marker, entry] = process.argv.slice(2);
const lock = acquireNativeLockSync(lockPath, { timeoutMs: 5000 });
if (!lock) process.exit(3);
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { version: 1, entries: [] };
writeFileSync(marker, 'held');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
ledger.entries.push(JSON.parse(entry));
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
lock.release();
`;

/** Start the other install; resolves once it holds the lock and has read the ledger. */
async function otherInstall(home: string, ledgerPath: string, entry: object): Promise<{ exited: Promise<number> }> {
  const script = join(home, 'holder.ts');
  writeFileSync(script, HOLDER.replace('__NATIVE_LOCK__', join(import.meta.dir, '..', 'src', 'core', 'persistence', 'native-lock.ts')));
  const marker = join(home, 'held');
  const child = Bun.spawn([process.execPath, '--no-env-file', script, join(home, '.gbrain', 'agent-instructions.lock'), ledgerPath, marker, JSON.stringify(entry)], { stdout: 'inherit', stderr: 'inherit' });
  for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(25);
  expect(existsSync(marker)).toBe(true);
  return { exited: child.exited };
}

function sandbox(): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-lock-'));
  roots.push(home);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  return home;
}

const entries = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { entries: { harness: string; path: string }[] }).entries.map((e) => `${e.harness} ${e.path}`).sort();

describe('#8484: concurrent installs keep every ledger entry', () => {
  test('brain-first: a sync that starts while another install holds the ledger waits and keeps its entry', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const ledger = brainFirstLedgerPath();
      const otherPath = join(home, 'other', 'AGENTS.md');
      const { exited } = await otherInstall(home, ledger, { harness: 'codex', path: otherPath, status: 'installed', block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'gbrain setup codex', created_file: false, updated_at: '2026-11-03T00:00:00.000Z' });
      const file = join(home, '.claude', 'CLAUDE.md');
      const out = syncBrainFirst({ target: brainFirstTargetAt('claude-code', file), access: { kind: 'mcp', server: 'gbrain' }, decision: { value: 'accepted', source: 'flag' }, writer: 'gbrain setup claude-code', dryRun: false });
      expect(await exited).toBe(0);
      expect(out.action).toBe('write');
      expect(entries(ledger)).toEqual([`claude-code ${file}`, `codex ${otherPath}`].sort());
    });
  });

  test('skills: a sync that starts while another install holds the ledger waits and keeps its entry', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const ledger = skillLoadingLedgerPath();
      const otherPath = join(home, 'other', 'AGENTS.md');
      const { exited } = await otherInstall(home, ledger, { harness: 'codex', path: otherPath, mode: 'off', block_version: SKILL_INDEX_VERSION, writer: 'gbrain setup codex', created_file: false, updated_at: '2026-11-03T00:00:00.000Z' });
      const file = join(home, '.claude', 'CLAUDE.md');
      const out = syncSkillsBlock({ target: brainFirstTargetAt('claude-code', file), launcher: '/usr/local/bin/gbrain', decision: { value: 'off', source: 'flag' }, writer: 'gbrain setup claude-code', dryRun: false, settingsPath: join(home, '.claude', 'settings.json') });
      expect(await exited).toBe(0);
      expect(out.action).toBe('skip');
      expect(entries(ledger)).toEqual([`claude-code ${file}`, `codex ${otherPath}`].sort());
    });
  });

  test.skipIf(process.getuid?.() === 0)('a config dir the lock cannot be created in changes nothing (ledger_locked)', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const dir = join(home, '.gbrain');
      const file = join(home, '.claude', 'CLAUDE.md');
      chmodSync(dir, 0o500);
      let skills, brainFirst;
      try {
        skills = syncSkillsBlock({ target: brainFirstTargetAt('claude-code', file), launcher: '/usr/local/bin/gbrain', decision: { value: 'off', source: 'flag' }, writer: 'test', dryRun: false });
        brainFirst = syncBrainFirst({ target: brainFirstTargetAt('claude-code', file), access: { kind: 'mcp', server: 'gbrain' }, decision: { value: 'accepted', source: 'flag' }, writer: 'test', dryRun: false });
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(skills).toMatchObject({ action: 'preserve', reason: 'ledger_locked' });
      expect(brainFirst).toMatchObject({ action: 'preserve' });
      expect(brainFirst.detail).toContain('agent-instructions.lock');
      expect(existsSync(file)).toBe(false);
      expect(existsSync(skillLoadingLedgerPath())).toBe(false);
      expect(existsSync(brainFirstLedgerPath())).toBe(false);
    });
  });
});
